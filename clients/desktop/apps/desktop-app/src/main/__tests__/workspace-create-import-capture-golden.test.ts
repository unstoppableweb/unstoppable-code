// CAN-4096 Capture (CAN-7937): create and import on the unchanged handlers,
// before they move into core. Real data root, W5 commit log (Electron-main
// rows), Git and clone-job registry; IPC registration, observability and
// worktree discovery are mocked. A Git shim parks or fails `git clone`.
import type * as LegacyStorage from '../lib/__tests__/fixtures/w5-legacy-storage';
import type * as TsxWorkerThreads from '../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<
      typeof LegacyStorage
    >('../lib/__tests__/fixtures/w5-legacy-storage')
    .createLegacyW5StorageMock(),
);
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CoreWorkspaceCreateParamsSchema,
  CoreWorkspaceImportParamsSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { readErrorClassification } from '@canopy/protocol/app-errors/classification';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

const mockHandlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));

import { registerWorkspaceHandlers } from '../ipc/workspaces';
import { registerCloneJobHandlers } from '../ipc/clone-jobs';
import { toIpcRejection } from '../ipc/app-error-rejection';
import { shutdownCloneJobs } from '../services/clone-jobs-host';
import {
  onScriptActionsRepositoryAdd,
  type ScriptActionsRepositoryAdd,
} from '../services/script-actions-lifecycle';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { W5CommitLogHost } from '../w5-commit-log/commit-log-host';
import {
  __setDesktopW5FileStoreForTests,
  createW5CommitLogFileStore,
  getW5IdentityStore,
} from '../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../lib/w5-file-store';
import { isRecord } from '../lib/type-guards';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { listWorkEntryIds } from '../lib/cowork-work-entries';
import { discoverExternalProjects } from '../external-projects/discovery';
import { importExternalProjects } from '../external-projects/import';
import { closeChatSearchService } from '../chat-search/service';
import { disposeElectronDaemonConnections } from '../canopy-runtime/electron-daemon-access';

jest.setTimeout(120_000);

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};
const AUTH_FAILURE =
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled";

let dir = '';
let dataDir = '';
let gateDir = '';
let originalDataDir: string | undefined;
let originalGit: string | undefined;
let host: W5CommitLogHost;
let runtime: DesktopCanopyDispatcher;
const adds: ScriptActionsRepositoryAdd[] = [];
let stopListening = (): void => undefined;

function git(cwd: string, ...args: string[]): string {
  const identity = ['-c', 'user.name=T', '-c', 'user.email=t@example.com'];
  return execFileSync('git', ['-C', cwd, ...identity, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

/** A `file://` origin: remote matching ignores plain paths. */
function origin(name: string): string {
  const seed = join(dir, 'seeds', name);
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'commit', '--allow-empty', '-qm', 'initial');
  const bare = join(dir, 'origins', `${name}.git`);
  git(dir, 'clone', '-q', '--bare', seed, bare);
  return `file://${bare}`;
}

/** One shim per file (the Git path is cached): `hold` parks, `auth` fails. */
function installGitShim(): void {
  gateDir = join(dir, 'gate');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim();
  const shim = join(dir, 'git.sh');
  const script = [
    '#!/bin/sh',
    'case " $* " in *" clone "*)',
    `  touch "${gateDir}/entered.$$"`,
    `  while [ -f "${gateDir}/hold" ]; do sleep 0.05; done`,
    `  if [ -f "${gateDir}/auth" ]; then echo "${AUTH_FAILURE}" >&2; exit 128; fi;;`,
    'esac',
    `exec "${realGit}" "$@"`,
  ];
  writeFileSync(shim, `${script.join('\n')}\n`, { mode: 0o755 });
  originalGit = process.env.CANOPY_GIT_EXECUTABLE;
  process.env.CANOPY_GIT_EXECUTABLE = shim;
}

function gate(...modes: ('hold' | 'auth')[]): void {
  rmSync(gateDir, { recursive: true, force: true });
  mkdirSync(gateDir, { recursive: true });
  for (const mode of modes) writeFileSync(join(gateDir, mode), '');
}

async function heldClone(): Promise<void> {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (readdirSync(gateDir).some((name) => name.startsWith('entered.')))
      return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('git clone never reached the gate');
}

function release(): void {
  rmSync(join(gateDir, 'hold'), { force: true });
}

function ipc(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  return Promise.resolve().then(() => handler({}, ...args));
}

function addFromRemote(request: object): Promise<unknown> {
  return ipc(IPC_CHANNELS.workspaceAddFromRemote, request);
}

async function cloneJobs(): Promise<unknown> {
  return scrub(await ipc(IPC_CHANNELS.cloneJobsList));
}

function scrub(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).split(dir).join('<root>'));
}

/** The rejection; Git's own errors come from another realm. */
async function rejection(
  work: Promise<unknown>,
): Promise<Record<string, unknown>> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!isRecord(error)) throw new Error('expected a rejection');
  return error;
}

function indexIds(): string[] {
  const index = join(dataDir, 'workspaces', 'index.json');
  if (!existsSync(index)) return [];
  const parsed: unknown = JSON.parse(readFileSync(index, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.workspaces)) return [];
  return parsed.workspaces.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : [],
  );
}

async function reservedIds(): Promise<string[]> {
  const rows = (await getW5IdentityStore()?.readReservations()) ?? [];
  return rows.flatMap(({ diagnostics }) =>
    isRecord(diagnostics) && typeof diagnostics.workspaceId === 'string'
      ? [diagnostics.workspaceId]
      : [],
  );
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'create-capture-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
  host = new W5CommitLogHost({
    root: join(dataDir, 'workspaces'),
    dbPath: join(dataDir, 'w5', 'commit-log.sqlite'),
    workerEntry: join(
      __dirname,
      '../lib/__tests__/fixtures/w5-commit-log-source-worker.ts',
    ),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  runtime = createDesktopRuntime();
  setDesktopCanopyRuntime(runtime);
  registerWorkspaceHandlers(() => null, {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => caller,
  });
  registerCloneJobHandlers();
  installGitShim();
  stopListening = onScriptActionsRepositoryAdd((event) => adds.push(event));
});

afterAll(async () => {
  stopListening();
  // The import's worktree opens the search index and daemon leases, whose
  // timers would outlive the suite.
  await closeChatSearchService();
  await disposeElectronDaemonConnections();
  setDesktopCanopyRuntime(null);
  await runtime.shutdown();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalGit === undefined) delete process.env.CANOPY_GIT_EXECUTABLE;
  else process.env.CANOPY_GIT_EXECUTABLE = originalGit;
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await settleDetachedWork();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

beforeEach(() => {
  gate();
  adds.length = 0;
});

test('CAN-4466: a GitHub credential failure rejects workspace:add-from-remote as GitHubAuthFailureError; its clone job keeps the plain error', async () => {
  gate('auth');
  const destinationDir = join(dir, 'auth');
  const remoteUrl = 'https://github.com/acme/private.git';
  const typed = await rejection(addFromRemote({ remoteUrl, destinationDir }));
  const message = String(typed.message);
  expect(typed.name).toBe('GitHubAuthFailureError');
  // The message is the clone's own, unchanged.
  expect(isRecord(typed.cause) && typed.cause.message).toBe(message);
  expect(message).toContain(AUTH_FAILURE);
  expect(readErrorClassification(typed)).toEqual({
    code: 'external.sign_in_required',
  });
  // What crosses IPC keeps the name the renderer offers sign-in on.
  const wire: unknown = JSON.parse(
    toIpcRejection(IPC_CHANNELS.workspaceAddFromRemote, typed).message,
  );
  expect(wire).toMatchObject({
    appError: { code: 'external.sign_in_required' },
    legacy: `GitHubAuthFailureError: ${message}`,
  });
  // The same failure from another host stays a plain error.
  const other = await rejection(
    addFromRemote({
      remoteUrl: 'https://git.example.com/acme/private.git',
      destinationDir: join(dir, 'auth-other'),
    }),
  );
  expect(other.name).toBe('Error');

  gate('hold', 'auth');
  const job = rejection(
    addFromRemote({ remoteUrl, destinationDir, jobId: 'job-auth' }),
  );
  await heldClone();
  await ipc(IPC_CHANNELS.cloneJobsBackground, 'job-auth');
  release();
  expect(await job).toMatchObject({
    name: 'GitHubAuthFailureError',
    message: AUTH_FAILURE,
  });
  expect(await cloneJobs()).toEqual([
    expect.objectContaining({
      id: 'job-auth',
      destinationPath: '<root>/auth/private-2',
      status: 'failed',
      error:
        'Failed to clone the repository. Check the URL and access, then try again.',
    }),
  ]);
  await ipc(IPC_CHANNELS.cloneJobsDismiss, 'job-auth');
  // Each failed clone keeps its checkout and identity for recovery.
  expect(readdirSync(destinationDir).sort()).toEqual(['private', 'private-2']);
  expect(readdirSync(join(dir, 'auth-other'))).toEqual(['private']);
  expect(await reservedIds()).toEqual(['private', 'private-2', 'private-3']);
  expect(indexIds()).toEqual([]);
});

test('clone-jobs:cancel removes the checkout and releases the identity; a backgrounded job keeps its outcome until dismissed', async () => {
  const remoteUrl = origin('beta');
  const destinationDir = join(dir, 'cancel');
  gate('hold');
  const cancelled = rejection(
    addFromRemote({ remoteUrl, destinationDir, jobId: 'job-cancel' }),
  );
  await heldClone();
  expect(await cloneJobs()).toEqual([
    expect.objectContaining({
      id: 'job-cancel',
      destinationPath: '<root>/cancel/beta',
      status: 'running',
      cancellable: true,
    }),
  ]);
  expect(await reservedIds()).toContain('beta');
  await ipc(IPC_CHANNELS.cloneJobsCancel, 'job-cancel');
  expect(await cancelled).toMatchObject({
    name: 'CloneCancelledError',
    message: 'Clone cancelled',
  });
  expect(readdirSync(destinationDir)).toEqual([]);
  expect(await reservedIds()).not.toContain('beta');
  expect(await cloneJobs()).toEqual([]);

  // The released id and path are free again for the next job.
  gate('hold');
  const job = addFromRemote({ remoteUrl, destinationDir, jobId: 'job-bg' });
  await heldClone();
  await expect(ipc(IPC_CHANNELS.cloneJobsBackground, 'job-bg')).resolves.toBe(
    true,
  );
  release();
  expect(scrub(await job)).toMatchObject({
    id: 'beta',
    repoPath: '<root>/cancel/beta',
  });
  expect(await cloneJobs()).toEqual([
    expect.objectContaining({
      id: 'job-bg',
      status: 'succeeded',
      workspaceId: 'beta',
    }),
  ]);
  await ipc(IPC_CHANNELS.cloneJobsDismiss, 'job-bg');
  expect(await cloneJobs()).toEqual([]);
  // Only the clone that finished announces its project.
  expect(adds).toEqual([
    expect.objectContaining({
      projectId: 'beta',
      repoIds: ['__single_repo__'],
    }),
  ]);
});

test('script detection is notified after each code-project create, never for a Cowork folder', async () => {
  const single = await ipc(IPC_CHANNELS.workspaceCreateNew, { name: 'One' });
  const multi = await ipc(IPC_CHANNELS.workspaceCreate, { name: 'Many' });
  const folder = join(dir, 'notes');
  mkdirSync(folder);
  const cowork = await ipc(IPC_CHANNELS.workspaceAddFromFolder, {
    repoPath: folder,
  });
  expect(cowork).toMatchObject({ id: 'notes', type: 'cowork' });
  expect(isRecord(cowork) && cowork.scriptActionsOperationId).toBeUndefined();
  expect(adds).toEqual([
    {
      projectId: 'one',
      repoIds: ['__single_repo__'],
      operationId: isRecord(single) && single.scriptActionsOperationId,
    },
    {
      projectId: 'many',
      repoIds: ['__workspace_root__'],
      operationId: isRecord(multi) && multi.scriptActionsOperationId,
    },
  ]);
});

test('a manifest import reuses a published member by remote, but clones a URL it lists twice into <name> and <name>-2', async () => {
  const shared = origin('shared');
  const dup = origin('dup');
  const destinationDir = join(dir, 'members');
  await addFromRemote({ remoteUrl: shared, destinationDir });
  const suite = join(dir, 'suite');
  mkdirSync(suite);
  git(suite, 'init', '-q', '-b', 'main');
  const repos = [
    { id: 'shared', name: 'shared', url: shared },
    { id: 'dup-a', name: 'dup', url: dup },
    { id: 'dup-b', name: 'dup', url: dup },
  ];
  writeFileSync(
    join(suite, 'canopy.json'),
    JSON.stringify({ version: 1, repos }),
  );
  git(suite, 'add', '.');
  git(suite, 'commit', '-qm', 'manifest');
  adds.length = 0;

  const imported = await ipc(IPC_CHANNELS.workspaceImportFromRepo, {
    repoPath: suite,
  });
  expect(scrub(imported)).toMatchObject({
    workspace: {
      id: 'suite',
      repos: [
        { id: 'shared', repoPath: '<root>/members/shared' },
        { id: 'dup-a', repoPath: '<root>/data/repos/dup' },
        { id: 'dup-b', repoPath: '<root>/data/repos/dup-2' },
      ],
    },
    clonedRepoIds: ['dup-a', 'dup-b'],
  });
  // The first copy becomes its own project; children announce nothing.
  expect(indexIds().filter((id) => /^(dup|shared)/.test(id))).toEqual([
    'shared',
    'dup',
  ]);
  expect(adds).toEqual([
    expect.objectContaining({
      projectId: 'suite',
      repoIds: ['shared', 'dup-a', 'dup-b', '__workspace_root__'],
    }),
  ]);
});

test('core.workspace.create replays a keyed empty create; the wire refuses temporary and import sources', async () => {
  const options = (
    idempotencyKey: string,
  ): Parameters<typeof runtime.instruction>[2] => ({
    caller: { ...caller, grants: ['core.workspace.write'] },
    metadata: { idempotencyKey },
  });
  const create = (
    name: string,
    idempotencyKey: string,
    temporary = false,
  ): Promise<unknown> =>
    runtime.instruction(
      'core.workspace.create',
      CoreWorkspaceCreateParamsSchema.parse({
        name,
        source: { kind: 'empty', workspaceKind: 'single_repo' },
        temporary,
        _meta: { idempotencyKey },
      }),
      options(idempotencyKey),
    );
  const created = await create('Wire App', 'key-1');
  expect(created).toMatchObject({
    workspace: { workspaceId: 'wire-app', kind: 'single_repo' },
    operation: null,
  });
  await expect(create('Wire App', 'key-1')).resolves.toEqual(created);
  await expect(create('Other App', 'key-1')).rejects.toThrow(
    'This request was already completed with different details.',
  );
  // The replay neither created nor announced a second project.
  expect(indexIds().filter((id) => id.startsWith('wire-'))).toEqual([
    'wire-app',
  ]);
  expect(adds.map((event) => event.projectId)).toEqual(['wire-app']);
  await expect(create('Wire App', 'key-2')).resolves.toMatchObject({
    workspace: { workspaceId: 'wire-app-2' },
  });

  await expect(create('Temp App', 'key-3', true)).rejects.toThrow(
    'Temporary projects are unavailable on this host.',
  );
  await expect(
    runtime.instruction(
      'core.workspace.import',
      CoreWorkspaceImportParamsSchema.parse({
        source: { kind: 'git_url', value: 'https://example.invalid/a/b.git' },
        name: 'b',
        _meta: { idempotencyKey: 'key-4' },
      }),
      options('key-4'),
    ),
  ).rejects.toThrow(
    'Cloning a project under a chosen name is unavailable on this host.',
  );
  expect(indexIds()).not.toContain('temp-app');
  expect(indexIds()).not.toContain('b');
});

function writeRollout(codexHome: string, id: string, cwd: string): string {
  const name = `rollout-2026-11-03T10-00-00-${id}.jsonl`;
  const file = join(codexHome, 'sessions', '2026', '11', '03', name);
  mkdirSync(dirname(file), { recursive: true });
  const timestamp = '2026-11-03T10:00:00.000Z';
  const records = [
    { timestamp, type: 'session_meta', payload: { id, timestamp, cwd } },
    {
      timestamp,
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Plan the release' },
    },
  ];
  writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return file;
}

// Chosen folders live outside the OS-temp roots discovery excludes.
test('external import registers a Git folder without a manifest and a plain folder as Cowork, and rolls back the empty chat destination of each', async () => {
  const fixture = realpathSync(
    mkdtempSync(join(homedir(), '.canopy-create-capture-')),
  );
  const savedCodexHome = process.env.CODEX_HOME;
  try {
    const repo = join(fixture, 'canopy-app');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '--allow-empty', '-qm', 'initial');
    const folder = join(fixture, 'meeting-notes');
    mkdirSync(folder);
    const codexHome = join(fixture, 'codex');
    process.env.CODEX_HOME = codexHome;
    const rollouts = [
      writeRollout(codexHome, '01a16b49-4d4b-7460-aee8-869cae2029a1', repo),
      writeRollout(codexHome, '01a16b49-4d4b-7460-aee8-869cae2029a2', folder),
    ];
    const scan = await discoverExternalProjects({ providers: ['codex'] });
    const byRoot = new Map(scan.candidates.map((c) => [c.rootPath, c]));
    expect(byRoot.get(repo)).toMatchObject({ kind: 'git', sessionCount: 1 });
    expect(byRoot.get(folder)).toMatchObject({ kind: 'folder' });
    // Each chat then fails to read, so the destination made for it is undone.
    for (const rollout of rollouts) rmSync(rollout);

    const { results } = await importExternalProjects({
      scanId: scan.scanId,
      selections: [repo, folder].map((root) => ({
        candidateId: byRoot.get(root)?.id ?? root,
        importChats: true,
      })),
    });
    expect(results).toMatchObject(
      ['single-repo', 'cowork'].map((workspaceType) => ({
        status: 'imported',
        workspaceType,
        chatsImported: 0,
        chatsSkipped: 1,
      })),
    );
    const [gitId, coworkId] = results.map((result) => result.workspaceId ?? '');
    expect(indexIds()).toEqual(expect.arrayContaining([gitId, coworkId]));
    // The repository is registered as it is: no manifest is written into it.
    expect(existsSync(join(repo, 'canopy.json'))).toBe(false);
    // The single-repo rollback archives its worktree and deletes its branch.
    const worktrees = join(dataDir, 'workspaces', gitId, 'worktrees.json');
    expect(JSON.parse(readFileSync(worktrees, 'utf8'))).toMatchObject({
      worktrees: [],
    });
    expect(git(repo, 'branch', '--format=%(refname:short)')).toBe('main');
    // The Cowork rollback removes its Work Entry.
    await expect(listWorkEntryIds(coworkId)).resolves.toEqual([]);
    expect(adds).toEqual([
      expect.objectContaining({
        projectId: gitId,
        repoIds: ['__single_repo__'],
      }),
    ]);
  } finally {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    rmSync(fixture, { recursive: true, force: true });
  }
});

// Last: quit stops untracked clones for the rest of this process.
test('quit inside a background clone job keeps its checkout and identity; a retry takes the next id and path', async () => {
  const remoteUrl = origin('gamma');
  const destinationDir = join(dir, 'quit');
  gate('hold');
  const job = rejection(
    addFromRemote({ remoteUrl, destinationDir, jobId: 'job-quit' }),
  );
  await heldClone();
  await ipc(IPC_CHANNELS.cloneJobsBackground, 'job-quit');

  await shutdownCloneJobs();
  expect(await job).toMatchObject({ name: 'CloneCancelledError' });
  // Unlike a failure, quit drops even a background job.
  expect(await cloneJobs()).toEqual([]);
  expect(readdirSync(destinationDir)).toEqual(['gamma']);
  expect(await reservedIds()).toContain('gamma');
  expect(indexIds()).not.toContain('gamma');

  release();
  const retry = addFromRemote({ remoteUrl, destinationDir, jobId: 'job-2' });
  expect(scrub(await retry)).toMatchObject({
    id: 'gamma-2',
    repoPath: '<root>/quit/gamma-2',
  });
  expect(readdirSync(destinationDir).sort()).toEqual(['gamma', 'gamma-2']);
});
