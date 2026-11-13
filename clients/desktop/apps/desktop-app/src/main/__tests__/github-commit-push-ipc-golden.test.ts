// CAN-5882 baseline: real Git through unchanged desktop IPC and Portal
// orchestration. Only registration and external services are replaced; no Git
// runner or mutation is mocked (auth cases use a local remote helper).
// Capture before commit/push dispatcher cutover.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
  type WorkspaceType,
  type PortalCommandEnvelope,
  type PortalPrActionPayload,
} from '@canopy/desktop-shared/types';
import type {
  CommitPushProgressEvent,
  CommitAndPushRequest,
  CommitAndPushResponse,
  PushOnlyRequest,
  PushOnlyResponse,
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
  invalidateGitFetchFreshness,
  readGitFetchFreshness,
  recordGitFetchSuccess,
} from '../lib/git-fetch-freshness';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { readPreferencesFile } from '../ipc/preferences';

import { runPrAction } from '../services/pr-service';
import { handlePortalPrAction } from '../portal/adapters/pr-adapter';
import type { PortalAdapterContext } from '../portal/adapters/types';
import {
  acquireSplitLock,
  releaseSplitLock,
} from '../services/split-lock-service';

jest.mock('../lib/github-pr', () => ({
  fetchPrStatusForWorktree: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../lib/worktree-precommit-failure-hook', () => ({
  triggerWorktreePrecommitFailureHook: jest.fn(() => Promise.resolve()),
}));

jest.setTimeout(30_000);
const WORKSPACE = 'shipping-ws';
const MULTI = 'shipping-multi';
const sent: { channel: string; payload: unknown }[] = [];
let dir: string;
let dataDir: string;
let origin: string;
let pusher: string;
let repo: string;
let runtime: DesktopCanopyDispatcher;
let restoreErrors: () => void;
let previousDataDir: string | undefined;
let previousGitEnv: [string, string | undefined][];
let onProgress: ((event: CommitPushProgressEvent) => void) | undefined;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}
function identify(path: string): void {
  git(path, ['config', 'user.email', 'shipping@example.com']);
  git(path, ['config', 'user.name', 'Shipping']);
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function commit(path: string, file: string, content = `${file}\n`): string {
  writeFileSync(join(path, file), content);
  git(path, ['add', '-A']);
  git(path, ['commit', '-q', '-m', file]);
  return git(path, ['rev-parse', 'HEAD']);
}
function checkout(name: string): string {
  // Seed only fixture refs; the application still performs every tested push.
  git(origin, ['update-ref', `refs/heads/${name}`, 'refs/heads/main']);
  git(repo, [
    'fetch',
    '-q',
    'origin',
    `refs/heads/${name}:refs/remotes/origin/${name}`,
  ]);
  const path = join(dataDir, 'workspaces', WORKSPACE, 'worktrees', name);
  git(repo, [
    'worktree',
    'add',
    '-q',
    '--track',
    '-b',
    name,
    path,
    `origin/${name}`,
  ]);
  identify(path);
  return path;
}
function advanceOrigin(branch: string): string {
  git(pusher, ['checkout', '-q', '-b', branch, 'main']);
  const tip = commit(pusher, `${branch}-remote.txt`);
  git(pusher, ['push', '-q', 'origin', branch]);
  return tip;
}
function remoteHead(branch: string): string {
  return git(origin, ['rev-parse', `refs/heads/${branch}`]);
}
function hook(name: string, body: string): void {
  const hooks = join(dir, 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, name), `#!/bin/sh\nset -eu\n${body}\n`, {
    mode: 0o755,
  });
  git(repo, ['config', 'core.hooksPath', hooks]);
}
function progress(): CommitPushProgressEvent[] {
  return sent
    .filter(({ channel }) => channel === IPC_CHANNELS.githubCommitPushProgress)
    .map(({ payload }) => payload as CommitPushProgressEvent);
}
function expectedProgress(
  worktreeId: string,
  phases: CommitPushProgressEvent['phase'][],
): CommitPushProgressEvent[] {
  return phases.map((phase, index) => ({
    projectId: WORKSPACE,
    worktreeId,
    phase,
    ...(index === phases.length - 1 ? {} : { repoName: 'repo' }),
  }));
}
function invoke(channel: string, request: unknown): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  return Promise.resolve().then(() => handler({}, request));
}
function shippingRequest(worktreeId: string): CommitAndPushRequest {
  return {
    projectId: WORKSPACE,
    worktreeId,
    messages: [{ repoName: 'repo', message: '  Ship every change  ' }],
    expectedHeadBranch: worktreeId,
  };
}
function ship(
  worktreeId: string,
  options: Partial<CommitAndPushRequest> = {},
): Promise<CommitAndPushResponse> {
  return invoke(IPC_CHANNELS.githubCommitAndPush, {
    ...shippingRequest(worktreeId),
    ...options,
  }) as Promise<CommitAndPushResponse>;
}
function push(
  worktreeId: string,
  options: Partial<PushOnlyRequest> = {},
): Promise<PushOnlyResponse> {
  return invoke(IPC_CHANNELS.githubPushOnly, {
    projectId: WORKSPACE,
    worktreeId,
    ...options,
  }) as Promise<PushOnlyResponse>;
}
function cancel(worktreeId: string, operationId: string): Promise<unknown> {
  return invoke(IPC_CHANNELS.githubCancelGitAction, {
    projectId: WORKSPACE,
    worktreeId,
    operationId,
  });
}
function exact(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}
const identity = { repoId: SINGLE_REPO_USAGE_REPO_ID, repoName: 'repo' };
const success = { ...identity, status: 'success' };
function failedResponse(error: unknown, shipping: boolean): object {
  return {
    repos: [],
    skippedRepos: [],
    failedRepos: [{ ...identity, error, status: 'failed' }],
    ...(shipping ? { agentResolutionRepos: [] } : {}),
  };
}
function assertFailureProgress(
  worktreeId: string,
  error: string,
  phases: CommitPushProgressEvent['phase'][] = [],
): void {
  exact(progress(), [
    ...phases.map((phase) => ({
      projectId: WORKSPACE,
      worktreeId,
      phase,
      repoName: 'repo',
    })),
    {
      projectId: WORKSPACE,
      worktreeId,
      phase: 'error',
      repoName: 'repo',
      error,
    },
    { projectId: WORKSPACE, worktreeId, phase: 'error' },
  ]);
}
async function freshness(path: string): Promise<void> {
  const raw = git(path, ['rev-parse', '--git-common-dir']);
  const commonDir = realpathSync(raw.startsWith('/') ? raw : join(path, raw));
  for (const prune of [false, true]) {
    const value = await readGitFetchFreshness({
      commonDir,
      originUrl: origin,
      prune,
    });
    expect(value).toBeNull();
  }
}
async function seedFreshness(path: string): Promise<void> {
  const raw = git(path, ['rev-parse', '--git-common-dir']);
  const commonDir = realpathSync(raw.startsWith('/') ? raw : join(path, raw));
  for (const prune of [false, true]) {
    const identity = { commonDir, originUrl: origin, prune };
    await recordGitFetchSuccess({ identity, succeededAt: Date.now() });
    await expect(readGitFetchFreshness(identity)).resolves.not.toBeNull();
  }
}

async function keepingFreshness<T>(
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  const raw = git(path, ['rev-parse', '--git-common-dir']);
  const commonDir = realpathSync(raw.startsWith('/') ? raw : join(path, raw));
  const identities = [false, true].map((prune) => ({
    commonDir,
    originUrl: origin,
    prune,
  }));
  await seedFreshness(path);
  const before = await Promise.all(identities.map(readGitFetchFreshness));
  try {
    const result = await run();
    // User shipping must neither overwrite nor invalidate automatic-fetch freshness.
    exact(await Promise.all(identities.map(readGitFetchFreshness)), before);
    return result;
  } finally {
    await Promise.all(identities.map(invalidateGitFetchFreshness));
  }
}

/** Trace the real executable, rather than infer "no force" from a rejected push. */
async function traceGit<T>(
  run: () => Promise<T>,
): Promise<{ result: T; commands: string[][] }> {
  const trace = join(dir, `trace-${Date.now()}.json`);
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  let result: T;
  try {
    result = await run();
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
  const commands: string[][] = [];
  for (const line of readFileSync(trace, 'utf8').trim().split('\n')) {
    const event: unknown = JSON.parse(line);
    if (
      typeof event !== 'object' ||
      event === null ||
      !('event' in event) ||
      event.event !== 'start' ||
      !('argv' in event) ||
      !Array.isArray(event.argv)
    )
      continue;
    commands.push(
      event.argv
        .filter((arg): arg is string => typeof arg === 'string')
        .slice(1),
    );
  }
  return { result, commands };
}
function expectPushWithoutForce(commands: string[][]): void {
  expect(commands.filter((args) => args[0] === 'push')).toEqual([
    ['push', '-u', 'origin', 'HEAD'],
  ]);
  for (const args of commands) {
    expect(
      args.some((arg) => arg.startsWith('--force') || arg.startsWith('+')),
    ).toBe(false);
  }
}

/**
 * O_RDWR keeps release non-blocking even when a regression never runs the hook.
 * A file notification replaces the old blocking FIFO reader; both the watcher
 * and deadline are disposed on early completion, rejection and assertion errors.
 */
async function duringHook<T>(
  name: string,
  run: () => Promise<T>,
  inspect: (pending: Promise<T>) => Promise<void>,
): Promise<T> {
  const barrier = mkdtempSync(join(dir, 'barrier-'));
  const started = join(barrier, 'started');
  const release = join(barrier, 'release');
  execFileSync('mkfifo', [release]);
  const fd = openSync(release, constants.O_RDWR);
  let entered = (): void => {};
  const watcher = watch(barrier, () => {
    if (existsSync(started)) entered();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    entered = resolve;
    timer = setTimeout(
      () => reject(new Error(`Git did not enter ${name} hook`)),
      5_000,
    );
  });
  hook(name, `printf ready > '${started}'\nread -r release < '${release}'`);
  const pending = run();
  try {
    await Promise.race([
      ready,
      pending.then(() => {
        throw new Error(`Git settled before entering ${name} hook`);
      }),
    ]);
    await inspect(pending);
  } finally {
    watcher.close();
    if (timer !== undefined) clearTimeout(timer);
    writeSync(fd, 'continue\n');
    try {
      // Drain the child before closing the keeper FD or removing the FIFO.
      await pending;
    } finally {
      closeSync(fd);
      rmSync(barrier, { recursive: true, force: true });
    }
  }
  return pending;
}

function committedResponse(
  path: string,
  operation = 'commit_and_push',
): object {
  return {
    repos: [
      {
        ...identity,
        commitHash: git(path, ['rev-parse', 'HEAD']),
        status: 'success',
        operation,
      },
    ],
    skippedRepos: [],
    failedRepos: [],
    agentResolutionRepos: [],
  };
}

beforeAll(() => {
  // Child-process errors belong to Node's realm, unlike Jest's Error.
  const ordinary = Function.prototype[Symbol.hasInstance];
  Object.defineProperty(Error, Symbol.hasInstance, {
    configurable: true,
    value: function (this: unknown, value: unknown): boolean {
      return this === Error
        ? Object.prototype.toString.call(value) === '[object Error]'
        : ordinary.call(this, value);
    },
  });
  restoreErrors = (): void => {
    Reflect.deleteProperty(Error, Symbol.hasInstance);
  };
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-shipping-')));
  dataDir = join(dir, 'data');
  previousDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  previousGitEnv = Object.entries(process.env).filter(([key]) =>
    key.startsWith('GIT_'),
  );
  for (const [key] of previousGitEnv) delete process.env[key];
  const config = join(dir, 'gitconfig');
  writeFileSync(
    config,
    '[user]\n\temail = shipping@example.com\n\tname = Shipping\n',
  );
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = config;
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  identify(seed);
  writeFileSync(join(seed, 'obsolete.txt'), 'obsolete\n');
  commit(seed, 'README.md');
  origin = join(dir, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
    stdio: 'pipe',
  });
  identify(origin);
  pusher = join(dir, 'pusher');
  repo = join(dir, 'repo');
  for (const path of [pusher, repo]) {
    execFileSync('git', ['clone', '-q', origin, path], { stdio: 'pipe' });
    identify(path);
  }
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE,
        name: WORKSPACE,
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 0,
      },
      {
        id: MULTI,
        name: MULTI,
        type: 'multi-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 1,
      },
    ],
  });
  writeJson(join(dataDir, 'workspaces', WORKSPACE, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repo,
    repos: [],
  });
  registerWorkspaceTypes(
    new Map<string, WorkspaceType>([
      [WORKSPACE, 'single-repo'],
      [MULTI, 'multi-repo'],
    ]),
  );
  runtime = createDesktopRuntime();
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-web-contents:1',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read', 'core.workspace.read'],
  };
  const window = {
    isDestroyed: (): boolean => false,
    webContents: {
      send: (channel: string, payload: unknown): void => {
        sent.push({ channel, payload });
        if (channel === IPC_CHANNELS.githubCommitPushProgress)
          onProgress?.(payload as CommitPushProgressEvent);
      },
      isDestroyed: (): boolean => false,
      isCrashed: (): boolean => false,
      mainFrame: { isDestroyed: (): boolean => false, detached: false },
    },
  };
  registerGitHubHandlers(() => window as unknown as BrowserWindow, {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => caller,
  });
});
beforeEach(() => {
  sent.length = 0;
  onProgress = undefined;
  jest.mocked(requestRefresh).mockClear();
  jest.mocked(enqueueFastRefresh).mockClear();
  jest
    .mocked(readPreferencesFile)
    .mockResolvedValue({ agentRebaseResolutionEnabled: false } as Awaited<
      ReturnType<typeof readPreferencesFile>
    >);
  git(repo, ['config', 'core.hooksPath', join(dir, 'empty-hooks')]);
  rmSync(join(dir, 'hooks'), { recursive: true, force: true });
});
afterAll(async () => {
  await runtime?.shutdown();
  restoreErrors?.();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) delete process.env[key];
  }
  for (const [key, value] of previousGitEnv ?? []) process.env[key] = value;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('github:commit-and-push baseline', () => {
  it('creates the first local commit on an unborn branch when no continuation guard is supplied', async () => {
    const name = 'unborn';
    const path = join(dataDir, 'workspaces', WORKSPACE, 'worktrees', name);
    mkdirSync(path, { recursive: true });
    git(path, ['init', '-q', '-b', name]);
    identify(path);
    writeFileSync(join(path, 'first.txt'), 'first\n');
    const result = await ship(name, { expectedHeadBranch: undefined });
    exact(result, {
      repos: [
        {
          ...identity,
          commitHash: git(path, ['rev-parse', 'HEAD']),
          status: 'success',
          operation: 'commit',
        },
      ],
      skippedRepos: [],
      failedRepos: [],
      agentResolutionRepos: [],
    });
    expect(git(path, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(path, ['show', 'HEAD:first.txt'])).toBe('first');
    exact(
      progress(),
      expectedProgress(name, ['staging', 'committing', 'done', 'done']),
    );
  });

  it('stages additions, edits and deletions, trims the message, commits and pushes HEAD with upstream', async () => {
    const path = checkout('ship-all');
    rmSync(join(path, 'obsolete.txt'));
    writeFileSync(join(path, 'README.md'), 'edited\n');
    writeFileSync(join(path, 'new.txt'), 'new\n');
    const result = await keepingFreshness(path, () => ship('ship-all'));
    const tip = git(path, ['rev-parse', 'HEAD']);
    exact(result, {
      repos: [
        {
          ...identity,
          commitHash: tip,
          status: 'success',
          operation: 'commit_and_push',
        },
      ],
      skippedRepos: [],
      failedRepos: [],
      agentResolutionRepos: [],
    });
    exact(
      progress(),
      expectedProgress('ship-all', [
        'staging',
        'committing',
        'pushing',
        'done',
        'done',
      ]),
    );
    expect(git(path, ['log', '-1', '--format=%s'])).toBe('Ship every change');
    expect(git(path, ['show', 'HEAD:new.txt'])).toBe('new');
    expect(git(path, ['show', 'HEAD:README.md'])).toBe('edited');
    expect(git(path, ['ls-tree', '--name-only', 'HEAD'])).not.toContain(
      'obsolete.txt',
    );
    expect(git(path, ['status', '--porcelain'])).toBe('');
    expect(remoteHead('ship-all')).toBe(tip);
    expect(git(path, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe(
      'origin/ship-all',
    );
    expect(requestRefresh).toHaveBeenCalledWith(WORKSPACE, 'ship-all', true);
    expect(enqueueFastRefresh).toHaveBeenCalledWith(
      WORKSPACE,
      'ship-all',
      false,
    );
    await freshness(path);
  });

  it('commits locally without an origin and never enters the push phase', async () => {
    const path = checkout('local-only');
    // Remote config is common to every worktree; restore it for later cases.
    git(repo, ['remote', 'remove', 'origin']);
    try {
      writeFileSync(join(path, 'local.txt'), 'local\n');
      const result = await ship('local-only');
      exact(result, {
        repos: [
          {
            ...identity,
            commitHash: git(path, ['rev-parse', 'HEAD']),
            status: 'success',
            operation: 'commit',
          },
        ],
        skippedRepos: [],
        failedRepos: [],
        agentResolutionRepos: [],
      });
      exact(
        progress(),
        expectedProgress('local-only', [
          'staging',
          'committing',
          'done',
          'done',
        ]),
      );
      expect(git(path, ['status', '--porcelain'])).toBe('');
    } finally {
      git(repo, ['remote', 'add', 'origin', origin]);
    }
  });

  it('pushes already-committed changes without making a new commit', async () => {
    const path = checkout('ship-existing');
    const tip = commit(path, 'already.txt');
    exact(await ship('ship-existing'), {
      repos: [{ ...success, operation: 'push' }],
      skippedRepos: [],
      failedRepos: [],
      agentResolutionRepos: [],
    });
    expect(remoteHead('ship-existing')).toBe(tip);
    exact(
      progress(),
      expectedProgress('ship-existing', ['pushing', 'done', 'done']),
    );
  });

  // CAN-5953: a Try again asks main never to push a clean repository's
  // pending commits on its own; they wait for the bar's Push.
  it('skipCleanPush leaves already-committed changes unpushed', async () => {
    const path = checkout('ship-existing-retry');
    const before = remoteHead('ship-existing-retry');
    const tip = commit(path, 'already.txt');
    exact(await ship('ship-existing-retry', { skipCleanPush: true }), {
      repos: [],
      skippedRepos: [{ ...identity, reason: 'commits_not_pushed' }],
      failedRepos: [],
      agentResolutionRepos: [],
    });
    expect(remoteHead('ship-existing-retry')).toBe(before);
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(tip);
  });

  it('does not commit when there are no changes or no upstream', async () => {
    const path = checkout('empty');
    const before = git(path, ['rev-parse', 'HEAD']);
    await expect(ship('empty')).rejects.toMatchObject({
      message: 'No repos had uncommitted changes to commit.',
    });
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
    exact(progress(), []);
    git(path, ['branch', '--unset-upstream']);
    writeFileSync(join(path, 'untracked.txt'), 'untracked\n');
    await expect(ship('empty')).rejects.toMatchObject({
      message: 'No repos had uncommitted changes to commit.',
    });
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(path, ['status', '--porcelain'])).toBe('?? untracked.txt');
    expect(requestRefresh).not.toHaveBeenCalled();
  });

  it('preserves the blank-message failure after staging', async () => {
    const path = checkout('blank-message');
    writeFileSync(join(path, 'pending.txt'), 'pending\n');
    const result = await ship('blank-message', {
      messages: [{ repoName: 'repo', message: '   ' }],
    });
    exact(result, failedResponse('Commit message must not be empty', true));
    assertFailureProgress('blank-message', 'Commit message must not be empty', [
      'staging',
      'committing',
    ]);
    expect(git(path, ['status', '--porcelain'])).toBe('A  pending.txt');
  });

  it('pulls before committing when requested and keeps both sides', async () => {
    const path = checkout('ship-pull');
    const remote = advanceOrigin('ship-pull');
    writeFileSync(join(path, 'local.txt'), 'local\n');
    const result = await ship('ship-pull', { pullFirst: true });
    exact(result, committedResponse(path));
    expect(git(path, ['rev-parse', 'HEAD~1'])).toBe(remote);
    expect(remoteHead('ship-pull')).toBe(git(path, ['rev-parse', 'HEAD']));
    exact(
      progress(),
      expectedProgress('ship-pull', [
        'pulling',
        'staging',
        'committing',
        'pushing',
        'done',
        'done',
      ]),
    );
  });

  it('refuses a branch changed by a commit hook before pushing either branch', async () => {
    const path = checkout('changed-after-commit');
    const remote = remoteHead('changed-after-commit');
    git(path, ['branch', 'other-after-commit']);
    hook('post-commit', 'git symbolic-ref HEAD refs/heads/other-after-commit');
    writeFileSync(join(path, 'pending.txt'), 'pending\n');
    exact(
      await ship('changed-after-commit'),
      failedResponse('The branch changed. Start a new push.', true),
    );
    assertFailureProgress(
      'changed-after-commit',
      'The branch changed. Start a new push.',
      ['staging', 'committing'],
    );
    expect(remoteHead('changed-after-commit')).toBe(remote);
    expect(git(path, ['rev-parse', 'changed-after-commit'])).not.toBe(remote);
    expect(git(path, ['branch', '--show-current'])).toBe('other-after-commit');
    expect(() => remoteHead('other-after-commit')).toThrow();
  });
});

describe('github:push-only baseline', () => {
  it('pushes commits, not dirty files, with exact progress and no fetch freshness writes', async () => {
    const path = checkout('push-dirty');
    const tip = commit(path, 'committed.txt');
    writeFileSync(join(path, 'dirty.txt'), 'dirty\n');
    exact(await keepingFreshness(path, () => push('push-dirty')), {
      repos: [success],
      skippedRepos: [],
      failedRepos: [],
    });
    expect(remoteHead('push-dirty')).toBe(tip);
    expect(git(path, ['status', '--porcelain'])).toBe('?? dirty.txt');
    exact(
      progress(),
      expectedProgress('push-dirty', ['pushing', 'done', 'done']),
    );
    await freshness(path);
  });

  it('establishes upstream only when explicitly requested with a repository and branch', async () => {
    const path = checkout('new-upstream');
    git(path, ['checkout', '-q', '-b', 'new-local']);
    const tip = commit(path, 'local-branch.txt');
    await expect(
      push('new-upstream', { establishUpstream: true }),
    ).rejects.toMatchObject({
      message: 'Select a repository and branch to continue pushing.',
    });
    exact(
      await push('new-upstream', {
        establishUpstream: true,
        expectedHeadBranch: 'new-local',
        repoIds: [SINGLE_REPO_USAGE_REPO_ID],
      }),
      { repos: [success], skippedRepos: [], failedRepos: [] },
    );
    expect(remoteHead('new-local')).toBe(tip);
    expect(git(path, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe(
      'origin/new-local',
    );
  });

  it('refuses a non-fast-forward without force and keeps both histories intact', async () => {
    const path = checkout('nff');
    const local = commit(path, 'local.txt');
    const remote = advanceOrigin('nff');
    const { result, commands } = await traceGit(() => push('nff'));
    expectPushWithoutForce(commands);
    const error = result.failedRepos[0]?.error;
    expect(error).toMatch(/^Command failed: \S+ push -u origin HEAD\n/);
    expect(error).toMatch(/\[rejected\].*(fetch first|non-fast-forward)/);
    exact(result, failedResponse(error, false));
    if (error === undefined)
      throw new Error('Expected the failed push message');
    assertFailureProgress('nff', error, ['pushing']);
    expect(remoteHead('nff')).toBe(remote);
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(local);
    expect(requestRefresh).not.toHaveBeenCalled();
  });

  it('rejects a same-SHA branch switch between preflight and the push', async () => {
    const path = checkout('push-switched');
    commit(path, 'pending.txt');
    const remote = remoteHead('push-switched');
    git(path, ['branch', 'other-before-push']);
    expect(git(path, ['rev-parse', 'other-before-push'])).toBe(
      git(path, ['rev-parse', 'HEAD']),
    );
    onProgress = ({ phase }): void => {
      if (phase === 'pushing')
        git(path, ['checkout', '-q', 'other-before-push']);
    };
    exact(
      await push('push-switched', { expectedHeadBranch: 'push-switched' }),
      failedResponse('The branch changed. Start a new push.', false),
    );
    assertFailureProgress(
      'push-switched',
      'The branch changed. Start a new push.',
      ['pushing'],
    );
    expect(remoteHead('push-switched')).toBe(remote);
    expect(() => remoteHead('other-before-push')).toThrow();
  });

  it('reports no commits ahead and releases the lock after rejection', async () => {
    const path = checkout('no-ahead');
    await expect(push('no-ahead')).rejects.toMatchObject({
      message: 'No repos had commits to push.',
    });
    exact(progress(), []);
    commit(path, 'later.txt');
    expect((await push('no-ahead')).repos).toEqual([success]);
  });
});

for (const shipping of [true, false]) {
  it(`${shipping ? 'commit-and-push' : 'push-only'} refuses a branch change during fetch`, async () => {
    const name = shipping ? 'commit-fetch-race' : 'push-fetch-race';
    const path = checkout(name);
    const before = git(path, ['rev-parse', 'HEAD']);
    const other = `${name}-other`;
    git(path, ['branch', other]);
    if (shipping) writeFileSync(join(path, 'pending.txt'), 'pending\n');
    else commit(path, 'local.txt');
    const remote = advanceOrigin(name);
    hook(
      'reference-transaction',
      `if [ "$1" = committed ]; then
  while read -r old new ref; do
    if [ "$ref" = "refs/remotes/origin/${name}" ]; then
      git symbolic-ref HEAD refs/heads/${other}
    fi
  done
fi`,
    );
    const result = shipping
      ? await ship(name)
      : await push(name, {
          pullFirst: true,
          expectedHeadBranch: name,
          repoIds: [SINGLE_REPO_USAGE_REPO_ID],
        });
    exact(
      result,
      failedResponse('The branch changed. Start a new push.', shipping),
    );
    assertFailureProgress(
      name,
      'The branch changed. Start a new push.',
      shipping ? [] : ['pushing'],
    );
    expect(git(path, ['branch', '--show-current'])).toBe(other);
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
    expect(remoteHead(name)).toBe(remote);
    expect(() => remoteHead(other)).toThrow();
  });
}

it('commit-and-push keeps the local commit after a non-fast-forward rejection', async () => {
  const path = checkout('ship-nff');
  const remote = advanceOrigin('ship-nff');
  writeFileSync(join(path, 'pending.txt'), 'pending\n');
  const { result, commands } = await traceGit(() => ship('ship-nff'));
  expectPushWithoutForce(commands);
  const error = result.failedRepos[0]?.error;
  expect(error).toMatch(/^Command failed: \S+ push -u origin HEAD\n/);
  expect(error).toMatch(/\[rejected\].*(non-fast-forward|fetch first)/);
  if (error === undefined) throw new Error('Expected the failed push message');
  exact(result, failedResponse(error, true));
  assertFailureProgress('ship-nff', error, [
    'staging',
    'committing',
    'pushing',
  ]);
  expect(remoteHead('ship-nff')).toBe(remote);
  expect(git(path, ['log', '-1', '--format=%s'])).toBe('Ship every change');
  expect(git(path, ['status', '--porcelain'])).toBe('');
});

it('a pending push cancellation waits for the pre-push hook and the remote write', async () => {
  const path = checkout('cancel-push');
  const tip = commit(path, 'pending.txt');
  const result = await duringHook(
    'pre-push',
    () => push('cancel-push', { operationId: 'push-op' }),
    async (pending) => {
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      exact(await cancel('cancel-push', 'push-op'), {
        accepted: true,
        reason: 'cancel_requested',
      });
      expect(remoteHead('cancel-push')).not.toBe(tip);
      expect(settled).toBe(false);
    },
  );
  exact(result, {
    repos: [],
    skippedRepos: [],
    failedRepos: [],
    cancelled: true,
  });
  expect(remoteHead('cancel-push')).toBe(tip);
  exact(progress(), [
    {
      projectId: WORKSPACE,
      worktreeId: 'cancel-push',
      phase: 'pushing',
      repoName: 'repo',
    },
  ]);
  expect(requestRefresh).not.toHaveBeenCalled();
});

for (const shipping of [true, false]) {
  describe(shipping ? 'commit-and-push refusals' : 'push-only refusals', () => {
    const run = shipping ? ship : push;
    it('refuses read-only workspaces and unsafe identifiers before Git', async () => {
      await expect(
        invoke(
          shipping
            ? IPC_CHANNELS.githubCommitAndPush
            : IPC_CHANNELS.githubPushOnly,
          { projectId: 'shared-container-viewer', worktreeId: 'wt' },
        ),
      ).rejects.toMatchObject({
        message: 'Shared-container recipient workspaces are read-only',
      });
      for (const [field, value] of [
        ['projectId', '../escape'],
        ['worktreeId', '../escape'],
        ['operationId', '../op'],
      ] as const) {
        await expect(
          invoke(
            shipping
              ? IPC_CHANNELS.githubCommitAndPush
              : IPC_CHANNELS.githubPushOnly,
            { projectId: WORKSPACE, worktreeId: 'wt', [field]: value },
          ),
        ).rejects.toMatchObject({
          message: `Invalid ${field}: must be lowercase alphanumeric with hyphens`,
        });
      }
      exact(progress(), []);
    });
    it('refuses Split-locked worktrees before staging or pushing', async () => {
      const name = shipping ? 'split-commit' : 'split-push';
      const path = checkout(name);
      const before = git(path, ['rev-parse', 'HEAD']);
      writeFileSync(join(path, 'dirty.txt'), 'dirty\n');
      acquireSplitLock(WORKSPACE, name);
      try {
        await expect(run(name)).rejects.toMatchObject({
          message:
            'This worktree is locked while a Split PR is in progress; running a Git action is unavailable until it finishes.',
        });
      } finally {
        releaseSplitLock(WORKSPACE, name);
      }
      expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
      expect(git(path, ['status', '--porcelain'])).toBe('?? dirty.txt');
    });
  });
}

it('failed user fetch clears freshness, creates no commit, and keeps the remote untouched', async () => {
  const path = checkout('fetch-failed');
  const before = git(path, ['rev-parse', 'HEAD']);
  writeFileSync(join(path, 'pending.txt'), 'pending\n');
  await seedFreshness(path);
  const offline = join(dir, 'offline.git');
  renameSync(origin, offline);
  try {
    const result = await ship('fetch-failed');
    const error = result.failedRepos[0]?.error;
    expect(error).toMatch(/^Command failed: \S+ fetch origin\n/);
    exact(result, failedResponse(error, true));
    if (error === undefined)
      throw new Error('Expected the failed fetch message');
    assertFailureProgress('fetch-failed', error);
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(path, ['status', '--porcelain'])).toBe('?? pending.txt');
    await freshness(path);
  } finally {
    renameSync(offline, origin);
  }
});

it('cancel never kills an active commit, excludes concurrent actions, and prevents the subsequent push', async () => {
  const path = checkout('cancel-commit');
  const remote = remoteHead('cancel-commit');
  writeFileSync(join(path, 'pending.txt'), 'pending\n');
  const result = await duringHook(
    'pre-commit',
    () => ship('cancel-commit', { operationId: 'cancel-op' }),
    async (pending) => {
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      exact(await cancel('cancel-commit', 'wrong-op'), {
        accepted: false,
        reason: 'not_active',
      });
      await expect(push('cancel-commit')).rejects.toMatchObject({
        message: 'A Git action is already active for this worktree',
      });
      await expect(ship('cancel-commit')).rejects.toMatchObject({
        message: 'A Git action is already active for this worktree',
      });
      await expect(
        runPrAction({
          workspaceLocalId: WORKSPACE,
          worktreeLocalId: 'cancel-commit',
          action: 'push',
        }),
      ).rejects.toMatchObject({
        code: 'execution_failed',
        message: 'A Git action is already active for this worktree',
      });
      exact(await cancel('cancel-commit', 'cancel-op'), {
        accepted: true,
        reason: 'cancel_requested',
      });
      exact(await cancel('cancel-commit', 'cancel-op'), {
        accepted: true,
        reason: 'cancel_requested',
      });
      expect(settled).toBe(false);
    },
  );
  exact(result, {
    repos: [],
    skippedRepos: [],
    failedRepos: [],
    agentResolutionRepos: [],
    cancelled: true,
  });
  expect(git(path, ['log', '-1', '--format=%s'])).toBe('Ship every change');
  expect(git(path, ['status', '--porcelain'])).toBe('');
  expect(remoteHead('cancel-commit')).toBe(remote);
  exact(progress(), [
    {
      projectId: WORKSPACE,
      worktreeId: 'cancel-commit',
      phase: 'staging',
      repoName: 'repo',
    },
    {
      projectId: WORKSPACE,
      worktreeId: 'cancel-commit',
      phase: 'committing',
      repoName: 'repo',
    },
  ]);
  exact(await cancel('cancel-commit', 'cancel-op'), {
    accepted: false,
    reason: 'not_active',
  });
  exact(await push('cancel-commit'), {
    repos: [success],
    skippedRepos: [],
    failedRepos: [],
  });
});

describe('Portal commit_and_push / push baseline', () => {
  it.each(['commit_and_push', 'push'] as const)(
    '%s mutates the real checkout and refreshes Portal state',
    async (action) => {
      const name = action === 'push' ? 'portal-push' : 'portal-commit';
      const path = checkout(name);
      if (action === 'push') commit(path, 'existing.txt');
      writeFileSync(join(path, 'pending.txt'), 'pending\n');
      const command: PortalCommandEnvelope<PortalPrActionPayload> = {
        id: `command-${name}`,
        sequence: 1,
        type: 'portal.pr.action',
        createdAt: '2026-11-06T00:00:00.000Z',
        expiresAt: null,
        payload: {
          workspaceLocalId: WORKSPACE,
          worktreeLocalId: name,
          ...(action === 'push'
            ? { action }
            : { action, commitMessage: '  Portal commit  ' }),
        },
      };
      const context = {
        getWindow: (): BrowserWindow | null => null,
        enqueueEvent: jest.fn(),
        complete: jest.fn<
          ReturnType<PortalAdapterContext['complete']>,
          Parameters<PortalAdapterContext['complete']>
        >(),
        fail: jest.fn(),
      } satisfies PortalAdapterContext;
      await handlePortalPrAction(command, context);
      const state = {
        workspaceLocalId: WORKSPACE,
        worktreeLocalId: name,
        number: null,
        url: null,
      };
      expect(context.fail).not.toHaveBeenCalled();
      expect(context.complete).toHaveBeenCalledTimes(1);
      expect(context.complete).toHaveBeenCalledWith(command, state);
      exact(context.complete.mock.calls[0]?.[1], state);
      expect(context.enqueueEvent).toHaveBeenCalledTimes(1);
      const payloadMatcher: unknown = expect.objectContaining({
        scope: 'pr',
        entities: [expect.objectContaining({ payload: state })],
      });
      expect(context.enqueueEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'portal.state.delta',
          commandId: command.id,
          payload: payloadMatcher,
        }),
      );
      expect(remoteHead(name)).toBe(git(path, ['rev-parse', 'HEAD']));
      expect(git(path, ['status', '--porcelain'])).toBe(
        action === 'push' ? '?? pending.txt' : '',
      );
      if (action === 'commit_and_push')
        expect(git(path, ['log', '-1', '--format=%s'])).toBe('Portal commit');
      exact(progress(), []);
    },
  );
  it('rejects blank messages and read-only mutations', async () => {
    await expect(
      runPrAction({
        workspaceLocalId: WORKSPACE,
        worktreeLocalId: 'wt',
        action: 'commit_and_push',
        commitMessage: '  ',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_payload',
      message: 'commitMessage is required.',
    });
    await expect(
      runPrAction({
        workspaceLocalId: 'shared-container-viewer',
        worktreeLocalId: 'wt',
        action: 'push',
      }),
    ).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'Shared-container recipient workspaces are read-only',
    });
  });
});

it.each([100_000, 100_001])(
  'keeps a %i-character message, Unicode and literal shell syntax without truncation',
  async (length) => {
    const name = `long-message-${length}`;
    const path = checkout(name);
    const message =
      'Ship café 🚀\n\n$(not-a-command) "quoted"; --amend\n'.padEnd(
        length,
        'x',
      );
    expect(message.length).toBe(length);
    writeFileSync(join(path, 'message.txt'), 'message\n');
    const result = await ship(name, {
      messages: [
        // Stable identity wins over a stale display name and its conflicting message.
        {
          repoId: SINGLE_REPO_USAGE_REPO_ID,
          repoName: 'old-name',
          message: ` \n${message}\n `,
        },
        { repoName: 'repo', message: 'Wrong message' },
      ],
    });
    exact(result, committedResponse(path));
    const raw = execFileSync(
      'git',
      ['-C', path, 'cat-file', 'commit', 'HEAD'],
      { encoding: 'utf8' },
    );
    expect(raw.slice(raw.indexOf('\n\n') + 2)).toBe(`${message}\n`);
    expect(remoteHead(name)).toBe(git(path, ['rev-parse', 'HEAD']));
  },
);

it('explicit commitOnly keeps a remote branch untouched and does not fetch or push', async () => {
  const path = checkout('explicit-local');
  const before = remoteHead('explicit-local');
  writeFileSync(join(path, 'pending.txt'), 'pending\n');
  const { result, commands } = await traceGit(() =>
    ship('explicit-local', { commitOnly: true }),
  );
  exact(result, committedResponse(path, 'commit'));
  expect(remoteHead('explicit-local')).toBe(before);
  expect(
    commands.filter((args) => args[0] === 'fetch' || args[0] === 'push'),
  ).toEqual([]);
  exact(
    progress(),
    expectedProgress('explicit-local', [
      'staging',
      'committing',
      'done',
      'done',
    ]),
  );
});

it('missing reviewed messages fail before staging and leave dirty bytes untouched', async () => {
  const name = 'missing-reviewed';
  const path = checkout(name);
  const before = git(path, ['rev-parse', 'HEAD']);
  writeFileSync(join(path, 'pending.txt'), 'pending\n');
  const error =
    'Missing reviewed commit message for "repo". Regenerate the preview before committing.';
  exact(
    await ship(name, { messages: [], requireReviewedMessages: true }),
    failedResponse(error, true),
  );
  assertFailureProgress(name, error);
  expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
  expect(remoteHead(name)).toBe(before);
  expect(git(path, ['status', '--porcelain'])).toBe('?? pending.txt');
});

it('a real pre-commit veto leaves the index staged and never pushes', async () => {
  const name = 'hook-veto';
  const path = checkout(name);
  const before = git(path, ['rev-parse', 'HEAD']);
  writeFileSync(join(path, 'pending.txt'), 'pending\n');
  hook('pre-commit', 'echo "golden hook veto" >&2\nexit 1');
  const { result, commands } = await traceGit(() => ship(name));
  const error = result.failedRepos[0]?.error;
  expect(error).toMatch(
    /^Command failed: \S+ commit -m Ship every change\ngolden hook veto\n$/,
  );
  exact(result, failedResponse(error, true));
  if (error === undefined) throw new Error('Expected the commit hook failure');
  assertFailureProgress(name, error, ['staging', 'committing']);
  expect(commands.some((args) => args[0] === 'push')).toBe(false);
  expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
  expect(remoteHead(name)).toBe(before);
  expect(git(path, ['status', '--porcelain'])).toBe('A  pending.txt');
});

for (const shipping of [true, false]) {
  it(`${shipping ? 'commit-and-push' : 'push-only'} returns the exact initial branch-mismatch failure`, async () => {
    const name = shipping ? 'wrong-initial-commit' : 'wrong-initial-push';
    const path = checkout(name);
    const before = git(path, ['rev-parse', 'HEAD']);
    writeFileSync(join(path, 'pending.txt'), 'pending\n');
    const error = shipping
      ? 'The branch changed. Start a new commit and push.'
      : 'The branch changed. Start a new push.';
    exact(
      await (shipping ? ship : push)(name, {
        expectedHeadBranch: 'not-this-branch',
      }),
      failedResponse(error, shipping),
    );
    assertFailureProgress(name, error);
    expect(git(path, ['status', '--porcelain'])).toBe('?? pending.txt');
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
    expect(remoteHead(name)).toBe(before);
  });

  it(`${shipping ? 'commit-and-push' : 'push-only'} currently pushes a concurrently advanced local HEAD on the same branch`, async () => {
    const name = shipping ? 'commit-local-race' : 'push-local-race';
    const path = checkout(name);
    if (shipping) writeFileSync(join(path, 'pending.txt'), 'pending\n');
    else commit(path, 'pending.txt');
    let prepared = '';
    let concurrent = '';
    onProgress = ({ phase }): void => {
      if (phase !== 'pushing') return;
      prepared = git(path, ['rev-parse', 'HEAD']);
      concurrent = commit(path, 'concurrent.txt');
    };
    const { result, commands } = await traceGit<
      CommitAndPushResponse | PushOnlyResponse
    >(() => (shipping ? ship : push)(name, { expectedHeadBranch: name }));
    expectPushWithoutForce(commands);
    exact(
      result,
      shipping
        ? {
            repos: [
              {
                ...identity,
                commitHash: prepared,
                status: 'success',
                operation: 'commit_and_push',
              },
            ],
            skippedRepos: [],
            failedRepos: [],
            agentResolutionRepos: [],
          }
        : { repos: [success], skippedRepos: [], failedRepos: [] },
    );
    expect(prepared).toMatch(/^[a-f0-9]{40}$/);
    expect(concurrent).not.toBe(prepared);
    expect(git(path, ['rev-parse', 'HEAD~1'])).toBe(prepared);
    expect(remoteHead(name)).toBe(concurrent);
  });

  it(`${shipping ? 'commit-and-push' : 'push-only'} refuses a concurrent remote advance without changing either tip or forcing`, async () => {
    const name = shipping ? 'commit-remote-race' : 'push-remote-race';
    const path = checkout(name);
    if (shipping) writeFileSync(join(path, 'pending.txt'), 'pending\n');
    else commit(path, 'pending.txt');
    let remote = '';
    onProgress = ({ phase }): void => {
      if (phase === 'pushing') remote = advanceOrigin(name);
    };
    const { result, commands } = await traceGit<
      CommitAndPushResponse | PushOnlyResponse
    >(() => (shipping ? ship : push)(name, { expectedHeadBranch: name }));
    // Fixture commands use `git -C`; only the application's push starts with `push`.
    expectPushWithoutForce(commands);
    const error = result.failedRepos[0]?.error;
    expect(error).toMatch(/^Command failed: \S+ push -u origin HEAD\n/);
    expect(error).toMatch(/\[rejected\].*(non-fast-forward|fetch first)/);
    exact(result, failedResponse(error, shipping));
    expect(remote).toMatch(/^[a-f0-9]{40}$/);
    expect(remoteHead(name)).toBe(remote);
    expect(git(path, ['rev-parse', 'HEAD'])).not.toBe(remote);
  });
}

it.each(['dirty-commit', 'clean-commit', 'push'] as const)(
  'rechecks the branch after the pre-push pull (%s)',
  async (mode) => {
    const name = `pull-race-${mode}`;
    const path = checkout(name);
    commit(path, 'local.txt');
    const remote = advanceOrigin(name);
    if (mode === 'dirty-commit')
      writeFileSync(join(path, 'pending.txt'), 'pending\n');
    const other = `${name}-other`;
    hook(
      'post-rewrite',
      `git update-ref refs/heads/${other} "$(git rev-parse HEAD)"\ngit symbolic-ref HEAD refs/heads/${other}`,
    );
    const { result, commands } = await traceGit<
      CommitAndPushResponse | PushOnlyResponse
    >(() =>
      mode === 'push'
        ? push(name, {
            pullFirst: true,
            expectedHeadBranch: name,
            repoIds: [SINGLE_REPO_USAGE_REPO_ID],
          })
        : ship(name, { pullFirst: true }),
    );
    exact(
      result,
      failedResponse('The branch changed. Start a new push.', mode !== 'push'),
    );
    assertFailureProgress(
      name,
      'The branch changed. Start a new push.',
      mode === 'push' ? ['pushing', 'pulling'] : ['pulling'],
    );
    expect(git(path, ['branch', '--show-current'])).toBe(other);
    expect(git(path, ['rev-parse', other])).toBe(
      git(path, ['rev-parse', name]),
    );
    expect(remoteHead(name)).toBe(remote);
    expect(() => remoteHead(other)).toThrow();
    expect(commands.some((args) => args[0] === 'push')).toBe(false);
    expect(git(path, ['status', '--porcelain'])).toBe(
      mode === 'dirty-commit' ? '?? pending.txt' : '',
    );
  },
);

/** A local Git remote transport, not a live GitHub call or a mocked Git error. */
async function withRejectedHttps<T>(run: () => Promise<T>): Promise<T> {
  const helpers = mkdtempSync(join(dir, 'https-helper-'));
  writeFileSync(
    join(helpers, 'git-remote-https'),
    `#!/bin/sh
printf "fatal: Authentication failed for '%s'\\n" "$2" >&2
exit 1
`,
    { mode: 0o755 },
  );
  const previous = process.env.GIT_EXEC_PATH;
  process.env.GIT_EXEC_PATH = helpers;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.GIT_EXEC_PATH;
    else process.env.GIT_EXEC_PATH = previous;
    rmSync(helpers, { recursive: true, force: true });
  }
}

for (const shipping of [true, false]) {
  it(`${shipping ? 'commit-and-push' : 'push-only'} classifies an HTTPS GitHub push credential failure using the pushurl, not the local fetch URL`, async () => {
    const name = shipping ? 'auth-commit' : 'auth-push';
    const path = checkout(name);
    const before = remoteHead(name);
    if (shipping) writeFileSync(join(path, 'pending.txt'), 'pending\n');
    else commit(path, 'pending.txt');
    git(path, [
      'config',
      'remote.origin.pushurl',
      'https://github.com/golden/repo.git',
    ]);
    try {
      const result = await withRejectedHttps<
        CommitAndPushResponse | PushOnlyResponse
      >(() => (shipping ? ship : push)(name));
      const error = result.failedRepos[0]?.error;
      expect(error).toMatch(
        /^Command failed: \S+ push -u origin HEAD\nfatal: Authentication failed for 'https:\/\/github.com\/golden\/repo.git'\n/,
      );
      exact(result, {
        repos: [],
        skippedRepos: [],
        failedRepos: [
          {
            ...identity,
            error,
            status: 'failed',
            failureCode: 'github_not_authenticated',
            ...(shipping ? { commitPrepared: true } : {}),
          },
        ],
        ...(shipping ? { agentResolutionRepos: [] } : {}),
      });
      if (error === undefined)
        throw new Error('Expected HTTPS authentication failure');
      assertFailureProgress(
        name,
        error,
        shipping ? ['staging', 'committing', 'pushing'] : ['pushing'],
      );
      expect(git(path, ['status', '--porcelain'])).toBe('');
      expect(remoteHead(name)).toBe(before);
      expect(git(path, ['rev-parse', 'HEAD'])).not.toBe(before);
      expect(requestRefresh).not.toHaveBeenCalled();
    } finally {
      git(repo, ['config', '--unset', 'remote.origin.pushurl']);
    }
  });
}

it('an HTTPS fetch auth failure is not reported as a prepared commit', async () => {
  const name = 'fetch-auth-commit';
  const path = checkout(name);
  const before = remoteHead(name);
  writeFileSync(join(path, 'pending.txt'), 'pending\n');
  git(repo, [
    'remote',
    'set-url',
    'origin',
    'https://github.com/golden/repo.git',
  ]);
  try {
    const result = await withRejectedHttps(() => ship(name));
    const error = result.failedRepos[0]?.error;
    expect(error).toMatch(
      /^Command failed: \S+ fetch origin\nfatal: Authentication failed for 'https:\/\/github.com\/golden\/repo.git'\n/,
    );
    exact(result, {
      repos: [],
      skippedRepos: [],
      failedRepos: [
        {
          ...identity,
          error,
          status: 'failed',
          failureCode: 'github_not_authenticated',
          commitPrepared: false,
        },
      ],
      agentResolutionRepos: [],
    });
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(path, ['status', '--porcelain'])).toBe('?? pending.txt');
    expect(remoteHead(name)).toBe(before);
  } finally {
    git(repo, ['remote', 'set-url', 'origin', origin]);
  }
});

it.each(['commit_and_push', 'push'] as const)(
  'Portal %s preserves auth-failure classification and the local commit',
  async (action) => {
    const name = `portal-auth-${action === 'push' ? 'push' : 'commit'}`;
    const path = checkout(name);
    const before = remoteHead(name);
    if (action === 'push') commit(path, 'pending.txt');
    else writeFileSync(join(path, 'pending.txt'), 'pending\n');
    git(repo, [
      'config',
      'remote.origin.pushurl',
      'https://github.com/golden/repo.git',
    ]);
    try {
      await expect(
        withRejectedHttps(() =>
          runPrAction({
            workspaceLocalId: WORKSPACE,
            worktreeLocalId: name,
            ...(action === 'push'
              ? { action }
              : { action, commitMessage: 'Portal auth commit' }),
          }),
        ),
      ).rejects.toMatchObject({
        code: 'github_not_connected',
        message: 'Connect GitHub on the desktop, then retry.',
      });
      expect(git(path, ['rev-parse', 'HEAD'])).not.toBe(before);
      expect(remoteHead(name)).toBe(before);
      expect(git(path, ['status', '--porcelain'])).toBe('');
      exact(progress(), []);
    } finally {
      git(repo, ['config', '--unset', 'remote.origin.pushurl']);
    }
  },
);

function multiMember(name: string, id: string): string {
  const path = join(
    dataDir,
    'workspaces',
    MULTI,
    'worktrees',
    name,
    'repos',
    id,
  );
  execFileSync('git', ['clone', '-q', origin, path], { stdio: 'pipe' });
  identify(path);
  git(path, [
    'checkout',
    '-q',
    '-b',
    `${name}-${id}`,
    '--track',
    'origin/main',
  ]);
  return path;
}
function multiConfig(ids: string[]): void {
  writeJson(join(dataDir, 'workspaces', MULTI, 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: ids.map((id) => ({
      id,
      name: `Repo ${id}`,
      repoPath: join(dir, `${id}-src`),
    })),
  });
}
function vetoPush(path: string): void {
  const hooks = mkdtempSync(join(dir, 'veto-hooks-'));
  writeFileSync(
    join(hooks, 'pre-push'),
    '#!/bin/sh\necho "multi push veto" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  git(path, ['config', 'core.hooksPath', hooks]);
}

for (const shipping of [true, false]) {
  it(`${shipping ? 'commit-and-push' : 'push-only'} keeps mixed multi-repository successes, skips and failures independent`, async () => {
    const name = shipping ? 'multi-commit' : 'multi-push';
    const ids = ['a-failed', 'b-current', 'c-untracked', 'd-success'];
    multiConfig(ids);
    const members = new Map(ids.map((id) => [id, multiMember(name, id)]));
    const member = (id: string): string => {
      const path = members.get(id);
      if (!path) throw new Error(`Missing member ${id}`);
      return path;
    };
    const before = git(member('b-current'), ['rev-parse', 'HEAD']);
    for (const id of ['a-failed', 'd-success']) {
      if (shipping) writeFileSync(join(member(id), 'pending.txt'), 'pending\n');
      else commit(member(id), 'pending.txt');
    }
    vetoPush(member('a-failed'));
    git(member('c-untracked'), ['branch', '--unset-upstream']);
    writeFileSync(join(member('c-untracked'), 'pending.txt'), 'pending\n');
    const request = {
      projectId: MULTI,
      worktreeId: name,
      // Each member deliberately has its own branch; no single continuation branch applies.
      expectedHeadBranch: undefined,
      ...(shipping
        ? {
            messages: ids.map((id) => ({
              repoId: id,
              repoName: `Repo ${id}`,
              message: `Commit ${id}`,
            })),
          }
        : {}),
    };
    const result = shipping
      ? await ship(name, request)
      : await push(name, request);
    const error = result.failedRepos[0]?.error;
    expect(error).toMatch(/^Command failed: \S+ push -u origin HEAD\n/);
    expect(error).toContain('multi push veto');
    exact(result, {
      repos: [
        {
          repoId: 'd-success',
          repoName: 'Repo d-success',
          ...(shipping
            ? { commitHash: git(member('d-success'), ['rev-parse', 'HEAD']) }
            : {}),
          status: 'success',
          ...(shipping ? { operation: 'commit_and_push' } : {}),
        },
      ],
      skippedRepos: [
        {
          repoId: 'b-current',
          repoName: 'Repo b-current',
          reason: shipping ? 'no_uncommitted_changes' : 'no_commits_ahead',
        },
        {
          repoId: 'c-untracked',
          repoName: 'Repo c-untracked',
          reason: 'no_remote_tracking',
        },
      ],
      failedRepos: [
        {
          repoId: 'a-failed',
          repoName: 'Repo a-failed',
          error,
          status: 'failed',
        },
      ],
      ...(shipping ? { agentResolutionRepos: [] } : {}),
    });
    const phases = shipping
      ? (['staging', 'committing', 'pushing'] as const)
      : (['pushing'] as const);
    exact(progress(), [
      ...phases.map((phase) => ({
        projectId: MULTI,
        worktreeId: name,
        phase,
        repoName: 'Repo a-failed',
      })),
      {
        projectId: MULTI,
        worktreeId: name,
        phase: 'error',
        repoName: 'Repo a-failed',
        error,
      },
      ...[...phases, 'done'].map((phase) => ({
        projectId: MULTI,
        worktreeId: name,
        phase,
        repoName: 'Repo d-success',
      })),
      { projectId: MULTI, worktreeId: name, phase: 'done' },
    ]);
    expect(() => remoteHead(`${name}-a-failed`)).toThrow();
    expect(remoteHead(`${name}-d-success`)).toBe(
      git(member('d-success'), ['rev-parse', 'HEAD']),
    );
    expect(git(member('a-failed'), ['status', '--porcelain'])).toBe('');
    expect(git(member('b-current'), ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(member('c-untracked'), ['status', '--porcelain'])).toBe(
      '?? pending.txt',
    );
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(requestRefresh).toHaveBeenCalledWith(MULTI, name, true);
  });
}

it.each(['commit_and_push', 'push'] as const)(
  'Portal %s reports partial multi-repository mutation results and still refreshes',
  async (action) => {
    const name =
      action === 'push' ? 'multi-portal-push' : 'multi-portal-commit';
    multiConfig(['a-failed', 'd-success']);
    const failed = multiMember(name, 'a-failed');
    const successful = multiMember(name, 'd-success');
    for (const path of [failed, successful]) {
      if (action === 'push') commit(path, 'pending.txt');
      else writeFileSync(join(path, 'pending.txt'), 'pending\n');
    }
    vetoPush(failed);
    const result = await runPrAction({
      workspaceLocalId: MULTI,
      worktreeLocalId: name,
      ...(action === 'push'
        ? { action }
        : { action, commitMessage: 'Mixed Portal commit' }),
    });
    if (!('mutationResult' in result) || !result.mutationResult)
      throw new Error('Expected partial Portal result');
    const error = result.mutationResult.failedRepos[0]?.error;
    expect(error).toContain('multi push veto');
    exact(result, {
      workspaceLocalId: MULTI,
      worktreeLocalId: name,
      number: null,
      url: null,
      mutationResult: {
        repos: [{ repoId: 'd-success', repoName: 'Repo d-success' }],
        failedRepos: [
          {
            repoId: 'a-failed',
            repoName: 'Repo a-failed',
            status: 'failed',
            error,
          },
        ],
      },
    });
    expect(remoteHead(`${name}-d-success`)).toBe(
      git(successful, ['rev-parse', 'HEAD']),
    );
    expect(() => remoteHead(`${name}-a-failed`)).toThrow();
    expect(git(failed, ['status', '--porcelain'])).toBe('');
    exact(progress(), []);
  },
);

it.each(['commit_and_push', 'push'] as const)(
  'Portal %s shares the Split exclusion guard',
  async (action) => {
    const name = `portal-split-${action === 'push' ? 'push' : 'commit'}`;
    const path = checkout(name);
    const before = remoteHead(name);
    writeFileSync(join(path, 'pending.txt'), 'pending\n');
    acquireSplitLock(WORKSPACE, name);
    try {
      await expect(
        runPrAction({
          workspaceLocalId: WORKSPACE,
          worktreeLocalId: name,
          ...(action === 'push'
            ? { action }
            : { action, commitMessage: 'Blocked' }),
        }),
      ).rejects.toMatchObject({
        code: 'execution_failed',
        message:
          'This worktree is locked while a Split PR is in progress; running a Git action is unavailable until it finishes.',
      });
    } finally {
      releaseSplitLock(WORKSPACE, name);
    }
    expect(git(path, ['rev-parse', 'HEAD'])).toBe(before);
    expect(remoteHead(name)).toBe(before);
    expect(git(path, ['status', '--porcelain'])).toBe('?? pending.txt');
    exact(progress(), []);
  },
);

it('an active Portal push excludes desktop mutations until the real Git child exits', async () => {
  const name = 'portal-lock';
  const path = checkout(name);
  const tip = commit(path, 'pending.txt');
  const result = await duringHook(
    'pre-push',
    () =>
      runPrAction({
        workspaceLocalId: WORKSPACE,
        worktreeLocalId: name,
        action: 'push',
      }),
    async () => {
      for (const run of [ship, push]) {
        await expect(run(name)).rejects.toMatchObject({
          message: 'A Git action is already active for this worktree',
        });
      }
    },
  );
  exact(result, {
    workspaceLocalId: WORKSPACE,
    worktreeLocalId: name,
    number: null,
    url: null,
  });
  expect(remoteHead(name)).toBe(tip);
  exact(await cancel(name, 'not-a-desktop-operation'), {
    accepted: false,
    reason: 'not_active',
  });
});

it('cancellation is refused during refresh and after completion, without undoing the push', async () => {
  const name = 'refresh-cancel';
  const path = checkout(name);
  const tip = commit(path, 'pending.txt');
  let refreshing: Promise<unknown> | undefined;
  jest.mocked(requestRefresh).mockImplementationOnce(() => {
    refreshing = cancel(name, 'refresh-op');
  });
  exact(await push(name, { operationId: 'refresh-op' }), {
    repos: [success],
    skippedRepos: [],
    failedRepos: [],
  });
  expect(refreshing).toBeDefined();
  exact(await refreshing, { accepted: false, reason: 'refreshing' });
  exact(await cancel(name, 'refresh-op'), {
    accepted: false,
    reason: 'not_active',
  });
  expect(remoteHead(name)).toBe(tip);
});
