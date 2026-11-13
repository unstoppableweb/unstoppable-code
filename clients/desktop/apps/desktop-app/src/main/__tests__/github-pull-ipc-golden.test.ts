// CAN-5517 goldens: `github:pull` responses, progress events, refusals, Git
// effects and fetch freshness, captured against the unchanged handler before
// its fetch and pull became projections of `worker.git.fetch` and
// `worker.git.pull`. Real data root, workspace records, checkouts and bare
// file-path origins; only IPC registration, the PR poller, the GitHub client,
// preferences and the rebase-resolution chat launcher are mocked. No hooks
// run: the fixture's Git config is empty.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import type {
  CommitPushProgressEvent,
  PullResponse,
} from '@canopy/desktop-shared/types/github';

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
import {
  readGitFetchFreshness,
  recordGitFetchSuccess,
  type GitFetchFreshnessIdentity,
} from '../lib/git-fetch-freshness';
import { launchRebaseResolutionChat } from '../lib/rebase-resolution-chat';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { readPreferencesFile } from '../ipc/preferences';

jest.setTimeout(120_000);

const SINGLE = 'pull-ws';
const MULTI = 'pull-multi';

let dir: string;
let dataDir: string;
let origin: string;
let pusher: string;
let repo: string;
let originalDataDir: string | undefined;
let originalGitEnv: [string, string | undefined][] = [];
let runtime: DesktopCanopyDispatcher | undefined;
const sent: { channel: string; payload: unknown }[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function identify(path: string): void {
  git(path, ['config', 'user.email', 'pull@example.com']);
  git(path, ['config', 'user.name', 'Pull']);
}

function commit(path: string, file: string, content = `${file}\n`): string {
  writeFileSync(join(path, file), content);
  git(path, ['add', '.']);
  git(path, ['commit', '-q', '-m', file]);
  return git(path, ['rev-parse', 'HEAD']);
}

function clone(from: string, to: string): void {
  execFileSync('git', ['clone', '-q', from, to], { stdio: 'pipe' });
  identify(to);
}

function worktreeDir(workspaceId: string, worktreeId: string): string {
  return join(dataDir, 'workspaces', workspaceId, 'worktrees', worktreeId);
}

/** Publishes `branch` on origin from `main`, with one commit of its own. */
function publish(branch: string): void {
  git(pusher, ['checkout', '-q', '-b', branch, 'main']);
  commit(pusher, `${branch}-base.txt`);
  git(pusher, ['push', '-q', '-u', 'origin', branch]);
  git(pusher, ['checkout', '-q', 'main']);
}

/** Pushes one more commit to origin's `branch`; answers its sha. */
function advanceOrigin(
  branch: string,
  file: string,
  content = `${file}\n`,
): string {
  git(pusher, ['checkout', '-q', branch]);
  git(pusher, ['pull', '-q', '--ff-only', 'origin', branch]);
  const sha = commit(pusher, file, content);
  git(pusher, ['push', '-q', 'origin', branch]);
  git(pusher, ['checkout', '-q', 'main']);
  return sha;
}

/**
 * A worktree of the single-repo workspace on its own branch `name`, tracking
 * origin's `name`, so every case starts from its own checkout.
 */
function singleWorktree(name: string): string {
  publish(name);
  git(repo, ['fetch', '-q', 'origin']);
  const path = worktreeDir(SINGLE, name);
  git(repo, ['worktree', 'add', '-q', '--track', '-b', name, path, `origin/${name}`]); // prettier-ignore
  return path;
}

const event: Partial<IpcMainInvokeEvent> = {};

const desktopCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};

/**
 * The registration, with the runtime the handler dispatches through. The
 * goldens were captured on the handler before it took one, which ignores it.
 */
const register: (
  getWindow: () => BrowserWindow | null,
  runtime: {
    dispatcher: DesktopCanopyDispatcher;
    resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor;
  },
) => void = registerGitHubHandlers;

async function pull(request: Record<string, unknown>): Promise<PullResponse> {
  const handler = mockHandlers.get(IPC_CHANNELS.githubPull);
  if (!handler) throw new Error('github:pull was not registered');
  sent.length = 0;
  const response: unknown = await handler(event, request);
  // The handler's declared response; the goldens pin its exact shape.
  return response as PullResponse;
}

function printed(pending: Promise<unknown>): Promise<string> {
  return pending.then(
    () => 'resolved',
    (error: unknown) => String(error),
  );
}

function progress(): CommitPushProgressEvent[] {
  return sent
    .filter(({ channel }) => channel === IPC_CHANNELS.githubCommitPushProgress)
    .map(({ payload }) => payload as CommitPushProgressEvent);
}

function commonDirOf(path: string): string {
  const raw = git(path, ['rev-parse', '--git-common-dir']);
  return realpathSync(raw.startsWith('/') ? raw : join(path, raw));
}

const ANY_STRING: unknown = expect.any(String);
const gitFailure = (pattern: RegExp): unknown => expect.stringMatching(pattern);

const window = {
  isDestroyed: (): boolean => false,
  webContents: {
    send: (channel: string, payload: unknown): void => {
      sent.push({ channel, payload });
    },
    isDestroyed: (): boolean => false,
    isCrashed: (): boolean => false,
    mainFrame: { isDestroyed: (): boolean => false, detached: false },
  },
};

/**
 * Electron main runs in one realm, so a child-process error is an `Error`
 * there; Jest's sandbox has its own `Error`. Treat any error object as one,
 * so the failed-repository messages are the ones Electron returns. Subclass
 * checks keep the ordinary prototype test.
 */
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'github-pull-golden-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  // User config (hooks, pull.rebase, commit.gpgsign) and hook-inherited
  // GIT_DIR would change the fixture; the handler's Git inherits process.env.
  originalGitEnv = Object.entries(process.env).filter(([key]) =>
    key.startsWith('GIT_'),
  );
  for (const [key] of originalGitEnv) delete process.env[key];
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(
    globalConfig,
    '[user]\n\temail = pull@example.com\n\tname = Pull\n',
  );
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = globalConfig;

  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  identify(seed);
  commit(seed, 'README.md');
  origin = join(dir, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
    stdio: 'pipe',
  });
  pusher = join(dir, 'pusher');
  clone(origin, pusher);
  repo = join(dir, 'repo');
  clone(origin, repo);

  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      { id: SINGLE, name: SINGLE, type: 'single-repo', color: '#38BDF8', collapsed: false, order: 0 }, // prettier-ignore
      { id: MULTI, name: MULTI, type: 'multi-repo', color: '#38BDF8', collapsed: false, order: 1 }, // prettier-ignore
    ],
  });
  writeJson(join(dataDir, 'workspaces', SINGLE, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repo,
    repos: [],
  });
  registerWorkspaceTypes(
    new Map<string, WorkspaceType>([
      [SINGLE, 'single-repo'],
      [MULTI, 'multi-repo'],
    ]),
  );

  runtime = createDesktopRuntime();
  register(() => window as unknown as BrowserWindow, {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
  });
});

afterAll(async () => {
  await runtime?.shutdown();
  restoreErrorRealm();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  delete process.env.GIT_CONFIG_GLOBAL;
  for (const [key, value] of originalGitEnv) process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.mocked(requestRefresh).mockClear();
  jest.mocked(enqueueFastRefresh).mockClear();
  jest.mocked(launchRebaseResolutionChat).mockClear();
  jest.mocked(readPreferencesFile).mockResolvedValue({
    agentRebaseResolutionEnabled: false,
  } as Awaited<ReturnType<typeof readPreferencesFile>>);
});

const single = (worktreeId: string): Record<string, unknown> => ({
  projectId: SINGLE,
  worktreeId,
});

const success = {
  repoId: SINGLE_REPO_USAGE_REPO_ID,
  repoName: 'repo',
  status: 'success',
};

describe('github:pull (single repository)', () => {
  it('fast-forwards a branch that is only behind origin', async () => {
    const path = singleWorktree('ff-behind');
    const tip = advanceOrigin('ff-behind', 'ff-remote.txt');

    await expect(pull(single('ff-behind'))).resolves.toEqual({
      repos: [success],
      skippedRepos: [],
      failedRepos: [],
      agentResolutionRepos: [],
    });
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(tip);
    expect(progress()).toEqual([
      { projectId: SINGLE, worktreeId: 'ff-behind', phase: 'pulling', repoName: 'repo' }, // prettier-ignore
      { projectId: SINGLE, worktreeId: 'ff-behind', phase: 'done', repoName: 'repo' }, // prettier-ignore
      { projectId: SINGLE, worktreeId: 'ff-behind', phase: 'done' },
    ]);
    expect(requestRefresh).toHaveBeenCalledWith(SINGLE, 'ff-behind', true);
    expect(enqueueFastRefresh).toHaveBeenCalledWith(SINGLE, 'ff-behind', false);
  });

  it('rebases a branch that is ahead and behind, keeping its commit', async () => {
    const path = singleWorktree('rebase-clean');
    const tip = advanceOrigin('rebase-clean', 'rebase-remote.txt');
    commit(path, 'rebase-local.txt');

    await expect(pull(single('rebase-clean'))).resolves.toEqual({
      repos: [success],
      skippedRepos: [],
      failedRepos: [],
      agentResolutionRepos: [],
    });
    expect(git(path, ['rev-parse', 'HEAD~1'])).toBe(tip);
    expect(git(path, ['log', '-1', '--format=%s'])).toBe('rebase-local.txt');
    expect(progress().map(({ phase }) => phase)).toEqual([
      'pulling',
      'done',
      'done',
    ]);
  });

  it('rebases with autostash, restoring uncommitted changes', async () => {
    const path = singleWorktree('rebase-autostash');
    const tip = advanceOrigin('rebase-autostash', 'stash-remote.txt');
    commit(path, 'stash-local.txt');
    writeFileSync(join(path, 'stash-local.txt'), 'edited\n');

    await expect(pull(single('rebase-autostash'))).resolves.toEqual({
      repos: [success],
      skippedRepos: [],
      failedRepos: [],
      agentResolutionRepos: [],
    });
    expect(git(path, ['rev-parse', 'HEAD~1'])).toBe(tip);
    expect(readFileSync(join(path, 'stash-local.txt'), 'utf8')).toBe(
      'edited\n',
    );
    expect(git(path, ['stash', 'list'])).toBe('');
  });

  it('reports a rebase conflict with manual guidance, leaving the rebase in progress', async () => {
    const path = singleWorktree('rebase-conflict');
    advanceOrigin('rebase-conflict', 'shared.txt', 'remote\n');
    commit(path, 'shared.txt', 'local\n');

    const result = await pull(single('rebase-conflict'));
    expect(result).toEqual({
      repos: [],
      skippedRepos: [],
      failedRepos: [
        {
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoName: 'repo',
          error: ANY_STRING,
          status: 'failed',
        },
      ],
      agentResolutionRepos: [],
    });
    const [failed] = result.failedRepos;
    const lines = (failed?.error ?? '').split('\n');
    expect(lines.slice(0, 3)).toEqual([
      'Rebase conflict while pulling "rebase-conflict" in "repo". The repo is mid-rebase and needs manual resolution.',
      'Next steps: resolve conflicts in the listed files, `git add` them, then run `git rebase --continue`. To abort, run `git rebase --abort` (uncommitted changes will be restored from the autostash).',
      '',
    ]);
    // Git's own stderr follows, as the pull printed it.
    expect(lines[3]).toMatch(/^From \/.+\/origin$/);
    expect(failed?.error).toMatch(/error: could not apply [0-9a-f]+\.\.\. shared\.txt/); // prettier-ignore
    expect(
      existsSync(
        join(commonDirOf(path), 'worktrees', 'rebase-conflict', 'rebase-merge'),
      ),
    ).toBe(true);
    expect(progress()).toEqual([
      { projectId: SINGLE, worktreeId: 'rebase-conflict', phase: 'pulling', repoName: 'repo' }, // prettier-ignore
      { projectId: SINGLE, worktreeId: 'rebase-conflict', phase: 'error', repoName: 'repo', error: failed?.error }, // prettier-ignore
      { projectId: SINGLE, worktreeId: 'rebase-conflict', phase: 'error' },
    ]);
    expect(requestRefresh).not.toHaveBeenCalled();
    expect(launchRebaseResolutionChat).not.toHaveBeenCalled();
  });

  it('hands a rebase conflict to an agent chat when agent resolution is on', async () => {
    jest.mocked(readPreferencesFile).mockResolvedValue({
      agentRebaseResolutionEnabled: true,
    } as Awaited<ReturnType<typeof readPreferencesFile>>);
    const path = singleWorktree('agent-conflict');
    advanceOrigin('agent-conflict', 'agent.txt', 'remote\n');
    commit(path, 'agent.txt', 'local\n');

    await expect(pull(single('agent-conflict'))).resolves.toEqual({
      repos: [],
      skippedRepos: [],
      failedRepos: [],
      agentResolutionRepos: [
        {
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoName: 'repo',
          chatId: 'chat-1',
          kind: 'rebase_conflict',
        },
      ],
    });
    const [launch] = jest.mocked(launchRebaseResolutionChat).mock.calls;
    expect(launch?.[0]).toMatchObject({
      projectId: SINGLE,
      worktreeId: 'agent-conflict',
      context: {
        kind: 'rebase_conflict',
        repoName: 'repo',
        branchName: 'agent-conflict',
        repoPath: path,
      },
    });
    expect(launch?.[0].context.errorMessage).toMatch(
      /^From \/.+\n[^]*error: could not apply [0-9a-f]+\.\.\. agent\.txt/,
    );
    expect(launch?.[0].context.commitMessage).toBeUndefined();
    expect(progress().map(({ phase }) => phase)).toEqual([
      'pulling',
      'done',
      'done',
    ]);
  });

  it('reports success when only the autostash re-apply conflicts, keeping the stash', async () => {
    const path = singleWorktree('stash-pop');
    const tip = advanceOrigin('stash-pop', 'popped.txt', 'remote\n');
    commit(path, 'stash-pop-local.txt');
    // Staged and also added by origin: the autostash's re-apply collides
    // with the rebased tree, but Git exits 0 and keeps the stash.
    writeFileSync(join(path, 'popped.txt'), 'local\n');
    git(path, ['add', 'popped.txt']);

    await expect(pull(single('stash-pop'))).resolves.toEqual({
      repos: [success],
      skippedRepos: [],
      failedRepos: [],
      agentResolutionRepos: [],
    });
    expect(git(path, ['rev-parse', 'HEAD~1'])).toBe(tip);
    expect(git(path, ['stash', 'list'])).toContain('autostash');
    expect(readFileSync(join(path, 'popped.txt'), 'utf8')).toBe(
      '<<<<<<< Updated upstream\nremote\n=======\nlocal\n>>>>>>> Stashed changes\n',
    );
  });

  it('fails the repository with Git’s error when a fast-forward is refused', async () => {
    const path = singleWorktree('ff-refused');
    advanceOrigin('ff-refused', 'blocker.txt');
    writeFileSync(join(path, 'blocker.txt'), 'untracked\n');

    const result = await pull(single('ff-refused'));
    expect(result).toEqual({
      repos: [],
      skippedRepos: [],
      failedRepos: [
        {
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoName: 'repo',
          error: gitFailure(
            /^Command failed: \S+ pull --ff-only origin ff-refused\n/,
          ),
          status: 'failed',
        },
      ],
      agentResolutionRepos: [],
    });
    expect(result.failedRepos[0]?.error).toContain(
      'untracked working tree files would be overwritten',
    );
    expect(progress().map(({ phase }) => phase)).toEqual([
      'pulling',
      'error',
      'error',
    ]);
  });

  it('reports a failed fetch as a failed repository, runs no pull and clears fetch freshness', async () => {
    const path = singleWorktree('offline');
    const before = git(path, ['rev-parse', 'HEAD']);
    advanceOrigin('offline', 'offline-remote.txt');
    const commonDir = commonDirOf(path);
    const identities: GitFetchFreshnessIdentity[] = [false, true].map(
      (prune) => ({ commonDir, originUrl: origin, prune }),
    );
    for (const identity of identities)
      await recordGitFetchSuccess({ identity, succeededAt: Date.now() });
    const offline = join(dir, 'origin-offline.git');
    renameSync(origin, offline);
    try {
      const result = await pull(single('offline'));
      expect(result).toEqual({
        repos: [],
        skippedRepos: [],
        failedRepos: [
          {
            repoId: SINGLE_REPO_USAGE_REPO_ID,
            repoName: 'repo',
            error: gitFailure(/^Command failed: \S+ fetch --prune origin\n/),
            status: 'failed',
          },
        ],
        agentResolutionRepos: [],
      });
      expect(result.failedRepos[0]?.error).toContain(
        'does not appear to be a git repository',
      );
      expect(result.failedRepos[0]).not.toHaveProperty('failureCode');
      expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
      for (const identity of identities)
        await expect(readGitFetchFreshness(identity)).resolves.toBeNull();
      // The fetch fails before the pull phase starts.
      expect(progress()).toEqual([
        { projectId: SINGLE, worktreeId: 'offline', phase: 'error', repoName: 'repo', error: result.failedRepos[0]?.error }, // prettier-ignore
        { projectId: SINGLE, worktreeId: 'offline', phase: 'error' },
      ]);
    } finally {
      renameSync(offline, origin);
    }
  });

  it('writes no durable fetch freshness for a successful user pull', async () => {
    const path = singleWorktree('fresh-success');
    advanceOrigin('fresh-success', 'fresh-remote.txt');
    await pull(single('fresh-success'));
    const commonDir = commonDirOf(path);
    for (const prune of [false, true])
      await expect(
        readGitFetchFreshness({ commonDir, originUrl: origin, prune }),
      ).resolves.toBeNull();
  });

  it('prunes a branch deleted on origin before deciding, so nothing is pulled', async () => {
    const path = singleWorktree('deleted-upstream');
    git(pusher, ['push', '-q', 'origin', '--delete', 'deleted-upstream']);
    expect(
      git(path, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/deleted-upstream']), // prettier-ignore
    ).not.toBe('');

    await expect(printed(pull(single('deleted-upstream')))).resolves.toBe(
      'Error: No repos needed to pull.',
    );
    expect(
      () =>
      git(path, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/deleted-upstream']), // prettier-ignore
    ).toThrow();
  });

  it('rejects when the only repository is already up to date', async () => {
    singleWorktree('up-to-date');
    await expect(printed(pull(single('up-to-date')))).resolves.toBe(
      'Error: No repos needed to pull.',
    );
    expect(progress()).toEqual([]);
  });

  it('refuses the read-only shared-container viewer before anything runs', async () => {
    await expect(
      printed(
        pull({ projectId: 'shared-container-viewer', worktreeId: 'run-1' }),
      ),
    ).resolves.toBe(
      'Error: Shared-container recipient workspaces are read-only',
    );
  });

  it('validates identifiers with the desktop messages', async () => {
    await expect(
      printed(pull({ projectId: '../escape', worktreeId: 'wt' })),
    ).resolves.toBe(
      'IdentifierValidationError: Invalid projectId: must be lowercase alphanumeric with hyphens',
    );
    await expect(
      printed(pull({ projectId: SINGLE, worktreeId: '../escape' })),
    ).resolves.toBe(
      'IdentifierValidationError: Invalid worktreeId: must be lowercase alphanumeric with hyphens',
    );
    await expect(
      printed(
        pull({ projectId: SINGLE, worktreeId: 'wt', operationId: '../op' }),
      ),
    ).resolves.toBe(
      'IdentifierValidationError: Invalid operationId: must be lowercase alphanumeric with hyphens',
    );
  });
});

describe('github:pull (multi-repository)', () => {
  const WORKTREE = 'multi-task';

  /** A member checkout under the worktree's repos/, cloned from `from`. */
  function member(id: string, from: string): string {
    const path = join(worktreeDir(MULTI, WORKTREE), 'repos', id);
    clone(from, path);
    return path;
  }

  it('pulls, skips and fails each repository on its own and keeps going', async () => {
    publish('multi-task');
    const behind = member('behind', origin);
    git(behind, ['checkout', '-q', 'multi-task']);
    const current = member('current', origin);
    git(current, ['checkout', '-q', 'multi-task']);
    const untracked = member('untracked', origin);
    git(untracked, ['checkout', '-q', '-b', 'local-only']);
    const noOrigin = member('no-origin', origin);
    git(noOrigin, ['remote', 'remove', 'origin']);
    const unreachable = member('unreachable', origin);
    git(unreachable, ['checkout', '-q', 'multi-task']);
    git(unreachable, ['remote', 'set-url', 'origin', join(dir, 'missing.git')]);
    const tip = advanceOrigin('multi-task', 'multi-remote.txt');
    writeJson(join(dataDir, 'workspaces', MULTI, 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: ['behind', 'current', 'untracked', 'no-origin', 'unreachable'].map(
        (id) => ({ id, name: `Repo ${id}`, repoPath: join(dir, `${id}-src`) }),
      ),
    });
    // `current` reads as behind only once fetched; pull it first.
    git(current, ['pull', '-q', '--ff-only', 'origin', 'multi-task']);

    const result = await pull({ projectId: MULTI, worktreeId: WORKTREE });
    const byRepo = <T extends { repoId?: string }>(entries: T[]): T[] =>
      [...entries].sort((left, right) =>
        (left.repoId ?? '').localeCompare(right.repoId ?? ''),
      );
    expect(byRepo(result.repos)).toEqual([
      { repoId: 'behind', repoName: 'Repo behind', status: 'success' },
    ]);
    expect(byRepo(result.skippedRepos)).toEqual([
      { repoId: 'current', repoName: 'Repo current', reason: 'not_behind' },
      { repoId: 'no-origin', repoName: 'Repo no-origin', reason: 'no_remote_origin' }, // prettier-ignore
      { repoId: 'untracked', repoName: 'Repo untracked', reason: 'no_remote_tracking' }, // prettier-ignore
    ]);
    expect(result.failedRepos).toEqual([
      {
        repoId: 'unreachable',
        repoName: 'Repo unreachable',
        error: gitFailure(/^Command failed: \S+ fetch --prune origin\n/),
        status: 'failed',
      },
    ]);
    expect(result.agentResolutionRepos).toEqual([]);
    expect(git(behind, ['rev-parse', 'HEAD'])).toBe(tip);
    expect(basename(behind)).toBe('behind');
    // Mixed results: the final progress is `done` because one repo pulled.
    expect(progress().at(-1)).toEqual({
      projectId: MULTI,
      worktreeId: WORKTREE,
      phase: 'done',
    });
  });
});
