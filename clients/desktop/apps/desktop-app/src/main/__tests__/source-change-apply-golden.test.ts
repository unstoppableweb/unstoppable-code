import { installRoutedW5GoldenStore } from '../lib/__tests__/fixtures/w5-routed-golden-store';
// CAN-5940 D1: captured before changing source-change apply's Git route.
import { execFileSync, type ExecFileOptions } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import type * as Util from 'node:util';
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
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
const mockSent: { channel: string; payload: unknown }[] = [];
jest.mock('../lib/window-send', () => ({
  sendToWindow: (_window: unknown, channel: string, payload: unknown): number =>
    mockSent.push({ channel, payload }),
}));
let mockPruneStarted = Promise.withResolvers<void>();
const mockCommands: {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}[] = [];
jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof ChildProcess>('node:child_process');
  const { promisify } = jest.requireActual<typeof Util>('node:util');
  const execFile = jest.fn(actual.execFile);
  Object.defineProperty(execFile, promisify.custom, {
    value: (
      command: string,
      args: string[],
      options: ExecFileOptions,
    ): Promise<unknown> => {
      mockCommands.push({
        args,
        cwd: options.cwd?.toString(),
        env: options.env,
      });
      if (args.join(' ') === 'worktree prune') mockPruneStarted.resolve();
      return promisify(actual.execFile)(command, args, options);
    },
  });
  return { ...actual, execFile };
});
const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    name: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): typeof mockHandlers => mockHandlers.set(name, handler),
}));
jest.mock('../lib/project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../lib/workspace-worktree-runtime', () => ({
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
  startWorkspaceRepoSetupAndDiscovery: jest.fn(),
  resolveWorkspaceWorktreeBranchName: jest.fn(() => Promise.resolve('task')),
}));
jest.mock('../lib/workspace-reference-repo-poller', () => ({
  requestRefresh: jest.fn(),
  startPolling: jest.fn(),
  stopPolling: jest.fn(),
}));
jest.mock('../lib/org-member-multi-repo-sync-deps', () => ({
  getOrgMemberMultiRepoSync: (): {
    applySourceChanges(
      id: string,
      request: unknown,
      run: () => Promise<unknown>,
    ): Promise<unknown>;
  } => ({
    applySourceChanges: (
      _id: string,
      _request: unknown,
      run: () => Promise<unknown>,
    ): Promise<unknown> => run(),
  }),
}));

import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { registerProjectHandlers } from '../ipc/projects';
import { registerWorkspaceHandlers } from '../ipc/workspaces';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { createWorktree, removeWorktree, pruneWorktrees } from '../lib/git';
import * as gitEffects from '../lib/git';
import * as animals from '../lib/animals';
import {
  registerUserEnvironmentInjector,
  registerSecretsEnvInjector,
} from '@canopy/execution-engine/pipelines/config-paths';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'source-golden',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read'],
};
let root: string;
let data: string;
let runtime: ReturnType<typeof createDesktopRuntime>;
let saved: NodeJS.ProcessEnv;
let savedForTest: NodeJS.ProcessEnv;
function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env))
    if (!(key in snapshot)) delete process.env[key];
  Object.assign(process.env, snapshot);
}
function git(cwd: string, args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    env,
  }).trim();
}

function json(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function repo(name: string): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, ['init', '-qb', 'main']);
  git(path, ['config', 'user.name', 'Golden']);
  git(path, ['config', 'user.email', 'golden@example.com']);
  json(join(path, 'canopy.json'), { version: 1, repos: [] });
  writeFileSync(join(path, '.gitignore'), 'repos/\n');
  git(path, ['add', '.']);
  git(path, ['commit', '-qm', 'initial']);
  return path;
}
async function ipc(channel: string, request: unknown): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error('missing handler');
  return handler({}, request);
}
let closeW5Store: (() => Promise<void>) | undefined;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'source-apply-golden-')));
  data = join(root, 'data');
  saved = { ...process.env };
  process.env.CANOPY_DATA_DIR = data;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const window = new BrowserWindow();
  runtime = createDesktopRuntime();
  registerProjectHandlers(
    () => window,
    runtime,
    () => caller,
  );
  registerWorkspaceHandlers(() => window, {
    dispatcher: runtime,
    resolveCaller: () => caller,
  });
  registerWorkspaceTypes(
    new Map([
      ['single', 'single-repo'],
      ['multi', 'multi-repo'],
    ]),
  );
  json(join(data, 'workspaces/index.json'), {
    version: 1,
    workspaces: [
      { id: 'single', name: 'Single', type: 'single-repo' },
      { id: 'multi', name: 'Multi', type: 'multi-repo' },
    ],
  });
  closeW5Store = await installRoutedW5GoldenStore();
});
afterAll(async () => {
  await closeW5Store?.();
  await settleDetachedWork();
  await runtime?.shutdown();
  restoreEnv(saved);
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  savedForTest = { ...process.env };
});
// A test's environment changes end with it, even when it times out before
// its own cleanup runs; otherwise later cases' Git calls hit its repository.
afterEach(() => {
  registerUserEnvironmentInjector(null);
  registerSecretsEnvInjector(null);
  restoreEnv(savedForTest);
});
it.each(['single', 'multi'] as const)(
  'pins %s existing-target IPC response and applied event bytes',
  async (id) => {
    const source = repo(id);
    const checkout = join(data, 'workspaces', id, 'worktrees/task');
    git(source, ['worktree', 'add', '-qb', 'task', checkout]);
    json(join(data, 'workspaces', id, 'workspace.json'), {
      version: 1,
      type: id === 'single' ? 'single-repo' : 'multi-repo',
      repoPath: id === 'single' ? source : undefined,
      sourceRepoPath: id === 'multi' ? source : undefined,
      repos: [],
    });
    json(join(data, 'workspaces', id, 'worktrees.json'), {
      version: 1,
      worktrees: [{ id: 'task', branchName: 'task', createdAt: 'now' }],
    });
    const request = {
      [id === 'single' ? 'projectId' : 'workspaceId']: id,
      clientRequestId: 'capture-1',
      target: { mode: 'existing', worktreeId: 'task' },
      ...(id === 'single'
        ? { scripts: { test: 'echo test' } }
        : { workspaceScripts: { test: 'echo test' } }),
    };
    mockSent.length = 0;
    const response = await ipc(
      id === 'single'
        ? IPC_CHANNELS.projectApplySourceChanges
        : IPC_CHANNELS.workspaceApplySourceChanges,
      request,
    );
    expect(JSON.stringify(response)).toBe(
      JSON.stringify({
        worktreeId: 'task',
        branchName: 'task',
        createdWorktree: false,
        ...(id === 'multi' ? { localRepoBindingsUpdated: false } : {}),
        referenceRepoPath: source,
      }),
    );
    expect(JSON.stringify(mockSent)).toBe(
      JSON.stringify([
        {
          channel:
            id === 'single'
              ? IPC_CHANNELS.projectSourceChangesApplied
              : IPC_CHANNELS.workspaceSourceChangesApplied,
          payload: {
            clientRequestId: 'capture-1',
            [id === 'single' ? 'projectId' : 'workspaceId']: id,
            worktreeId: 'task',
            branchName: 'task',
            createdWorktree: false,
          },
        },
      ]),
    );
    const manifest: unknown = JSON.parse(
      readFileSync(join(checkout, 'canopy.json'), 'utf8'),
    );
    expect(manifest).toHaveProperty('scripts', { test: 'echo test' });
    await expect(
      ipc(
        id === 'single'
          ? IPC_CHANNELS.projectApplySourceChanges
          : IPC_CHANNELS.workspaceApplySourceChanges,
        { ...request, target: { mode: 'existing', worktreeId: 'absent' } },
      ),
    ).rejects.toMatchObject({
      message: 'Project worktree absent was not found',
    });
  },
);
// Every step spawns Git, so on a loaded CI shard this case alone outlasts
// Jest's 5 s default.
it('preserves create/remove/prune effects, branch reuse and hook suppression', async () => {
  const source = repo('effects');
  const target = join(root, 'checkout');
  const marker = join(root, 'hook');
  writeFileSync(
    join(source, '.git/hooks/post-checkout'),
    `#!/bin/sh\necho ran > '${marker}'\n`,
    { mode: 0o755 },
  );
  Object.assign(process.env, {
    GIT_DIR: join(source, '.git'),
    GIT_INDEX_FILE: join(source, '.git/index'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'canopy.golden',
    GIT_CONFIG_VALUE_0: 'inherited',
    GIT_TERMINAL_PROMPT: '1',
    GCM_INTERACTIVE: 'always',
  });
  registerUserEnvironmentInjector(() => ({ CANOPY_GOLDEN_USER: 'excluded' }));
  registerSecretsEnvInjector(() => ({ CANOPY_GOLDEN_SECRET: 'excluded' }));
  mockCommands.length = 0;
  expect(await createWorktree(source, target, 'task')).toBe('task');
  expect(git(target, ['branch', '--show-current'])).toBe('task');
  await removeWorktree(source, target);
  await pruneWorktrees(source);
  expect(await createWorktree(source, target, 'task')).toBe('task');
  await removeWorktree(source, target);
  expect(() => readFileSync(marker)).toThrow();
  const writes = mockCommands.filter(
    ({ args }) => args.includes('worktree') && !args.includes('list'),
  );
  expect(writes.map(({ args, cwd }) => ({ args, cwd }))).toEqual([
    {
      args: [
        '-c',
        'core.hooksPath=/dev/null',
        'worktree',
        'add',
        '-b',
        'task',
        target,
      ],
      cwd: source,
    },
    { args: ['worktree', 'remove', '--force', target], cwd: source },
    { args: ['worktree', 'prune'], cwd: source },
    {
      args: [
        '-c',
        'core.hooksPath=/dev/null',
        'worktree',
        'add',
        target,
        'task',
      ],
      cwd: source,
    },
    { args: ['worktree', 'remove', '--force', target], cwd: source },
  ]);
  for (const { env } of writes) {
    expect(env?.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env?.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env?.PATH).toBeTruthy();
    expect(env?.GIT_DIR).toBe(join(source, '.git'));
    expect(env?.GIT_INDEX_FILE).toBe(join(source, '.git/index'));
    expect(env?.GIT_CONFIG_COUNT).toBe('1');
    expect(env?.GIT_CONFIG_KEY_0).toBe('canopy.golden');
    expect(env?.GIT_CONFIG_VALUE_0).toBe('inherited');
    expect(env?.CANOPY_GOLDEN_USER).toBeUndefined();
    expect(env?.CANOPY_GOLDEN_SECRET).toBeUndefined();
    expect(env?.GIT_TERMINAL_PROMPT).toBe(process.env.GIT_TERMINAL_PROMPT);
    expect(env?.GCM_INTERACTIVE).toBe(process.env.GCM_INTERACTIVE);
  }
}, 30_000);

it('adds a new member before binding publication and removes it after binding removal, with fallback prune', async () => {
  const member = repo('new-member');
  const target = { mode: 'existing', worktreeId: 'task' };
  await expect(
    ipc(IPC_CHANNELS.workspaceApplySourceChanges, {
      workspaceId: 'multi',
      target,
      repoAdds: [
        {
          repoId: 'api',
          repoName: 'API',
          repoPath: member,
          remoteUrl: 'https://example.invalid/api.git',
        },
      ],
    }),
  ).resolves.toEqual({
    worktreeId: 'task',
    branchName: 'task',
    createdWorktree: false,
    localRepoBindingsUpdated: true,
    referenceRepoPath: join(root, 'multi'),
  });
  await settleDetachedWork();
  const path = join(data, 'workspaces/multi/worktrees/task/repos/api');
  expect(git(path, ['branch', '--show-current'])).toBe('task');
  const failure = jest
    .spyOn(gitEffects, 'removeWorktree')
    .mockRejectedValueOnce(new Error('legacy removal failure'));
  mockCommands.length = 0;
  mockPruneStarted = Promise.withResolvers<void>();
  await expect(
    ipc(IPC_CHANNELS.workspaceApplySourceChanges, {
      workspaceId: 'multi',
      target,
      repoRemovals: ['api'],
    }),
  ).resolves.toEqual({
    worktreeId: 'task',
    branchName: 'task',
    createdWorktree: false,
    localRepoBindingsUpdated: true,
    referenceRepoPath: join(root, 'multi'),
  });
  await settleDetachedWork();
  failure.mockRestore();
  expect(() => readFileSync(join(path, '.git'))).toThrow();
  await mockPruneStarted.promise;
  expect(
    mockCommands
      .filter(({ args }) => args.join(' ') === 'worktree prune')
      .map(({ cwd }) => cwd),
  ).toEqual([member]);
});

// Real Git setup, fetches and worktree writes need the sibling's 30 s budget
// on loaded CI shards, rather than Jest's 5 s default.
it('starts a new branch at origin default after parallel preparation and preserves occupied-branch errors', async () => {
  const source = repo('origin-default');
  const remote = join(root, 'origin-default.git');
  git(source, ['clone', '--bare', source, remote]);
  git(source, ['remote', 'add', 'origin', remote]);
  const original = git(source, ['rev-parse', 'HEAD']);
  writeFileSync(join(source, 'local-only'), 'not on origin');
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'local only']);
  const target = join(root, 'origin-default-checkout');
  mockCommands.length = 0;
  expect(await createWorktree(source, target, 'topic')).toBe('topic');
  expect(git(target, ['rev-parse', 'HEAD'])).toBe(original);
  const commands = mockCommands
    .filter(({ cwd }) => cwd === source)
    .map(({ args }) => args.join(' '));
  const branchProbe = commands.indexOf(
    'show-ref --verify --quiet refs/heads/topic',
  );
  const fetch = commands.indexOf('fetch origin');
  const defaultBranch = commands.indexOf('ls-remote --symref origin HEAD');
  expect(fetch).toBeGreaterThanOrEqual(0);
  expect(defaultBranch).toBeGreaterThanOrEqual(0);
  expect(branchProbe).toBeGreaterThan(fetch);
  expect(branchProbe).toBeGreaterThan(defaultBranch);
  expect(commands).toContain(
    `-c core.hooksPath=/dev/null -c core.warnAmbiguousRefs=false worktree add -b topic ${target} refs/remotes/origin/main`,
  );
  await expect(
    createWorktree(source, join(root, 'occupied'), 'topic'),
  ).rejects.toThrow(/is already (?:used by worktree|checked out at)/);
  // afterAll removes this entire fixture. App process cleanup would scan the
  // host even though this creation case launches no worktree processes.
}, 30_000);

it.each(['single', 'multi'] as const)(
  'preserves %s failed-add IPC error bytes without an applied event or worktree record',
  async (id) => {
    const legacyError = new Error(
      'legacy worktree add failed\n  fatal: branch is occupied\n',
    );
    const create = jest
      .spyOn(gitEffects, 'createWorktree')
      .mockRejectedValueOnce(legacyError);
    const name = jest
      .spyOn(animals, 'generateUniqueAnimalName')
      .mockReturnValue('failed-target');
    const recordsPath = join(data, 'workspaces', id, 'worktrees.json');
    const recordsBefore = readFileSync(recordsPath, 'utf8');
    mockSent.length = 0;
    try {
      await expect(
        ipc(
          id === 'single'
            ? IPC_CHANNELS.projectApplySourceChanges
            : IPC_CHANNELS.workspaceApplySourceChanges,
          {
            [id === 'single' ? 'projectId' : 'workspaceId']: id,
            clientRequestId: 'capture-failed-add',
            target: { mode: 'new', existingWorktreeIds: [] },
          },
        ),
      ).rejects.toBe(legacyError);
      expect(create).toHaveBeenCalledTimes(1);
      expect(mockSent).toEqual([]);
      expect(readFileSync(recordsPath, 'utf8')).toBe(recordsBefore);
    } finally {
      create.mockRestore();
      name.mockRestore();
    }
  },
);

it.each(['single', 'multi'] as const)(
  'pins %s new-target IPC response and applied event bytes through the actual Git route',
  async (id) => {
    const name = jest
      .spyOn(animals, 'generateUniqueAnimalName')
      .mockReturnValue('new-target');
    mockSent.length = 0;
    try {
      const response = await ipc(
        id === 'single'
          ? IPC_CHANNELS.projectApplySourceChanges
          : IPC_CHANNELS.workspaceApplySourceChanges,
        {
          [id === 'single' ? 'projectId' : 'workspaceId']: id,
          clientRequestId: 'capture-new',
          target: { mode: 'new', existingWorktreeIds: [] },
        },
      );
      expect(JSON.stringify(response)).toBe(
        JSON.stringify({
          worktreeId: 'new-target',
          branchName: 'new-target',
          createdWorktree: true,
          ...(id === 'multi' ? { localRepoBindingsUpdated: false } : {}),
          referenceRepoPath: join(root, id),
        }),
      );
      expect(JSON.stringify(mockSent)).toBe(
        JSON.stringify([
          {
            channel:
              id === 'single'
                ? IPC_CHANNELS.projectSourceChangesApplied
                : IPC_CHANNELS.workspaceSourceChangesApplied,
            payload: {
              clientRequestId: 'capture-new',
              [id === 'single' ? 'projectId' : 'workspaceId']: id,
              worktreeId: 'new-target',
              branchName: 'new-target',
              createdWorktree: true,
            },
          },
        ]),
      );
      await settleDetachedWork();
      expect(
        git(join(data, 'workspaces', id, 'worktrees/new-target'), [
          'branch',
          '--show-current',
        ]),
      ).toBe('new-target');
    } finally {
      name.mockRestore();
    }
  },
);
