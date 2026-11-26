import { installRoutedW5GoldenStore } from '../lib/__tests__/fixtures/w5-routed-golden-store';
// CAN-4070 rule: captured on the unchanged `worktree:health-check` IPC handler
// before CAN-5136 routed it through `worker.git.worktree.health.get`. Real
// data root, workspace records, registries and Git checkouts; only IPC
// registration is mocked. `checkedAt` and other timestamps are normalized.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectWorktreeHealth,
  toWorkerGitWorktreeHealthResult,
} from '@canopy/core-runtime/node/git';
import { connectCanopyClient } from '@canopy/core-client/node';
import {
  deriveLocalAuthorityIdentity,
  hostLocalAuthorityObservation,
} from '@canopy/core-platform';
import {
  WORKER_FILESYSTEM_GRANTS,
  WORKER_GIT_GRANTS,
  WorkerGitWorktreeHealthGetParamsSchema,
  WorkerGitWorktreeHealthGetResultSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';

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

import { registerWorktreeHandlers } from '../ipc/worktrees';
import { registerCodeReviewTarget } from '../lib/code-review-registry';
import { registerPlanExploreTarget } from '../lib/plan-explore-registry';
import { getSharedContainerRunRootDir } from '../lib/paths';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import {
  createDaemonGitRoute,
  type DaemonGitQueryClient,
  type DaemonGitRoute,
} from '../canopy-runtime/daemon-git-route';
import {
  ELECTRON_DAEMON_DEFINITIONS,
  type ElectronDaemonClient,
} from '../canopy-runtime/electron-daemon-host';
import {
  startCanopyDaemon,
  type RunningCanopyDaemon,
} from '../../../../core-daemon/src/daemon';
import { createElectronDaemonCallerLifetime } from '../canopy-runtime/electron-daemon-caller-lifetime';
import { createElectronDaemonConnectionService } from '../canopy-runtime/electron-daemon-connection';
import {
  deferred,
  FakeSender,
} from '../canopy-runtime/__tests__/daemon-files-route-harness';
import * as worktreeHealthModule from '../lib/worktree-health';
import * as gitModule from '../lib/git';
import * as gitExecutableModule from '../lib/git-executable';
import * as workingDirectoryModule from '@canopy/desktop-shared/node/lib/working-directory';
import {
  desktopWorktreeHealthSources,
  workspaceManifestReadable,
} from '../lib/worktree-health';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from '../lib/resolve-worktree';
import {
  getWorkspaceType,
  registerWorkspaceTypes,
} from '../lib/workspace-registry';

jest.setTimeout(120_000);

let dir: string;
let dataDir: string;
let originalDataDir: string | undefined;
// A hook or parent Git process must not redirect the checks' own Git.
const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
] as const;
const originalGitEnv = new Map<string, string | undefined>();

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

function workspaceDir(id: string): string {
  return join(dataDir, 'workspaces', id);
}

function worktreeDir(workspaceId: string, worktreeId: string): string {
  return join(workspaceDir(workspaceId), 'worktrees', worktreeId);
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'golden@example.com']);
  git(path, ['config', 'user.name', 'Golden']);
  writeFileSync(join(path, 'README.md'), 'readme\n');
  git(path, ['add', '.']);
  git(path, ['commit', '-q', '-m', 'init']);
}

function addCheckout(repo: string, path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  git(repo, ['worktree', 'add', '-q', '--detach', path]);
}

function plainDir(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'notes.txt'), 'not a repository\n');
}

function dotGitFile(path: string, contents: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, '.git'), contents);
}

function workspaceEntry(id: string, type: string, order: number): object {
  return { id, name: id, type, color: '#38BDF8', collapsed: false, order };
}

interface Row {
  id: string;
  includedRepoIds?: string[];
  healthIssue?: object;
  splitRecoveryRequired?: boolean;
}

function writeWorktrees(workspaceId: string, rows: Row[]): void {
  writeJson(join(workspaceDir(workspaceId), 'worktrees.json'), {
    version: 1,
    worktrees: rows.map((row) => ({
      branchName: row.id,
      createdAt: '2026-10-26T00:00:00.000Z',
      ...row,
    })),
  });
}

const SINGLE_WS = 'single-ws';
const MULTI_WS = 'multi-ws';
const MULTI_NO_SOURCE_WS = 'multi-no-source-ws';
const COWORK_WS = 'cowork-ws';
// Hand-edited configuration: repository ids no canonical scope would carry.
const ODD_IDS_WS = 'odd-ids-ws';
// Indexed, with a worktree list, but no workspace manifest.
const NO_MANIFEST_WS = 'no-manifest-ws';
// Indexed, with a worktree list, but a manifest that is not JSON.
const INVALID_MANIFEST_WS = 'invalid-manifest-ws';
// Indexed, with a worktree list, and a manifest whose stored owner is malformed.
const MALFORMED_OWNER_WS = 'malformed-owner-ws';
// Indexed single-repo manifests main normalizes but the daemon's recorded
// reader refuses, one per refusal.
// Indexed multi-repo workspaces whose recorded paths the daemon's reader
// drops (empty, relative or NUL) while main keeps them: the two readers
// would disagree on the verdict, so these stay in process too.
const RELATIVE_SOURCE_WS = 'relative-source-ws';
const RELATIVE_REPO_WS = 'relative-repo-ws';
const PATH_DIVERGENT = [RELATIVE_SOURCE_WS, RELATIVE_REPO_WS];
const REFUSED_MANIFESTS: Readonly<Record<string, Record<string, unknown>>> = {
  'repos-null-ws': { version: 1, type: 'single-repo', repos: null },
  'repo-name-ws': {
    version: 1,
    type: 'single-repo',
    repos: [{ id: 'alpha', name: 7, repoPath: '/tmp' }],
  },
  'repo-id-ws': {
    version: 1,
    type: 'single-repo',
    repos: [{ id: 'Not_Safe', name: 'A', repoPath: '/tmp' }],
  },
  'type-unknown-ws': { version: 1, type: 'weird', repos: [] },
  'other-workspace-ws': {
    version: 1,
    type: 'single-repo',
    repos: [],
    workspaceId: 'someone-else',
  },
  'other-target-ws': {
    version: 1,
    type: 'single-repo',
    repos: [],
    targetId: 'elsewhere',
  },
  'other-authority-ws': {
    version: 1,
    type: 'single-repo',
    repos: [],
    authorityId: 'another-authority',
  },
};
const CONTAINER = 'container-01';
const STALE_ISSUE = {
  status: 'broken',
  code: 'missing-worktree-path',
  message: 'Worktree directory does not exist.',
  checkedAt: '2026-10-01T00:00:00.000Z',
  worktreePath: '/stale',
};

const repos: Record<string, string> = {};

let closeW5Store: (() => Promise<void>) | undefined;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-health-golden-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  for (const key of GIT_ENV_KEYS) {
    originalGitEnv.set(key, process.env[key]);
    delete process.env[key];
  }

  for (const name of ['single', 'source', 'alpha', 'beta', 'gamma'])
    initRepo((repos[name] = join(dir, 'clones', name)));

  // Single-repo checkouts, one per health outcome.
  const single = (id: string): string => worktreeDir(SINGLE_WS, id);
  addCheckout(repos.single, single('healthy'));
  addCheckout(repos.single, single('unlisted'));
  plainDir(single('no-git'));
  initRepo(single('git-dir'));
  initRepo(single('bare'));
  git(single('bare'), ['config', 'core.bare', 'true']);
  dotGitFile(single('no-gitdir-line'), 'not a gitdir pointer\n');
  dotGitFile(
    single('missing-gitdir'),
    `gitdir: ${join(dir, 'admin', 'missing')}\n`,
  );
  dotGitFile(single('relative-gitdir'), 'gitdir: ../../admin/relative\n');
  mkdirSync(join(dir, 'admin'), { recursive: true });
  writeFileSync(join(dir, 'admin', 'file'), 'not a directory\n');
  dotGitFile(single('file-gitdir'), `gitdir: ${join(dir, 'admin', 'file')}\n`);

  // Multi-repo worktrees: a source-backed root and configured members.
  const multi = (id: string): string => worktreeDir(MULTI_WS, id);
  const member = (id: string, repoId: string): string =>
    join(multi(id), 'repos', repoId);
  addCheckout(repos.source, multi('all-healthy'));
  for (const repoId of ['alpha', 'beta', 'gamma'])
    addCheckout(repos[repoId], member('all-healthy', repoId));

  // Untracked: no includedRepoIds, so every directory under repos/ is checked.
  addCheckout(repos.source, multi('untracked'));
  addCheckout(repos.alpha, member('untracked', 'alpha'));
  plainDir(member('untracked', 'notes'));

  // Tracked: includedRepoIds names alpha, so beta, gamma and notes are skipped.
  addCheckout(repos.source, multi('tracked'));
  addCheckout(repos.alpha, member('tracked', 'alpha'));
  plainDir(member('tracked', 'notes'));

  addCheckout(repos.source, multi('one-broken'));
  addCheckout(repos.alpha, member('one-broken', 'alpha'));
  dotGitFile(
    member('one-broken', 'beta'),
    `gitdir: ${join(dir, 'admin', 'beta-missing')}\n`,
  );

  addCheckout(repos.source, multi('unnamed-broken'));
  plainDir(member('unnamed-broken', 'gamma'));

  // A member issue, then the root's: the order never depends on readdir.
  plainDir(multi('two-broken'));
  dotGitFile(
    member('two-broken', 'alpha'),
    `gitdir: ${join(dir, 'admin', 'two-broken-alpha')}\n`,
  );

  plainDir(multi('root-broken'));
  for (const repoId of ['alpha', 'beta', 'gamma'])
    addCheckout(repos[repoId], member('root-broken', repoId));

  // Without a source repository the root is never validated.
  const noSource = (id: string): string => worktreeDir(MULTI_NO_SOURCE_WS, id);
  plainDir(noSource('plain-root'));
  addCheckout(repos.alpha, join(noSource('plain-root'), 'repos', 'alpha'));
  initRepo(noSource('git-root'));
  dotGitFile(
    join(noSource('git-root'), 'repos', 'alpha'),
    'not a gitdir pointer\n',
  );

  // Repository ids outside an identifier's bounds, one missing and one present.
  plainDir(worktreeDir(ODD_IDS_WS, 'odd'));
  plainDir(join(worktreeDir(ODD_IDS_WS, 'odd'), 'repos', 'd'.repeat(200)));

  // A shared-container viewer run directory holding its own checkout.
  initRepo(getSharedContainerRunRootDir(CONTAINER));

  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      workspaceEntry(SINGLE_WS, 'single-repo', 0),
      workspaceEntry(MULTI_WS, 'multi-repo', 1),
      workspaceEntry(MULTI_NO_SOURCE_WS, 'multi-repo', 2),
      workspaceEntry(COWORK_WS, 'cowork', 3),
      workspaceEntry(ODD_IDS_WS, 'multi-repo', 4),
    ],
  });
  writeJson(join(workspaceDir(SINGLE_WS), 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repos.single,
    repos: [],
  });
  writeWorktrees(SINGLE_WS, [
    { id: 'healthy', healthIssue: STALE_ISSUE, splitRecoveryRequired: true },
    { id: 'missing' },
    { id: 'no-git' },
    { id: 'git-dir' },
    { id: 'bare' },
    { id: 'no-gitdir-line' },
    { id: 'missing-gitdir' },
    { id: 'relative-gitdir' },
    { id: 'file-gitdir' },
  ]);
  const configured = [
    { id: 'alpha', name: 'Alpha', repoPath: repos.alpha },
    { id: 'beta', name: 'Beta', repoPath: repos.beta },
    { id: 'gamma', name: '', repoPath: repos.gamma },
  ];
  writeJson(join(workspaceDir(MULTI_WS), 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: repos.source,
    repos: configured,
  });
  writeWorktrees(MULTI_WS, [
    { id: 'all-healthy', healthIssue: STALE_ISSUE },
    { id: 'untracked' },
    { id: 'tracked', includedRepoIds: ['alpha'] },
    { id: 'one-broken', includedRepoIds: ['alpha', 'beta'] },
    { id: 'unnamed-broken', includedRepoIds: ['gamma'] },
    { id: 'two-broken', includedRepoIds: ['alpha'] },
    { id: 'root-broken' },
    { id: 'root-missing' },
  ]);
  writeJson(join(workspaceDir(MULTI_NO_SOURCE_WS), 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [{ id: 'alpha', name: 'Alpha', repoPath: repos.alpha }],
  });
  writeWorktrees(MULTI_NO_SOURCE_WS, [
    { id: 'plain-root', includedRepoIds: ['alpha'] },
    { id: 'git-root', includedRepoIds: ['alpha'] },
  ]);
  writeJson(join(workspaceDir(ODD_IDS_WS), 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [
      { id: '', name: 'Empty', repoPath: repos.alpha },
      { id: 'c'.repeat(600), name: 'Long', repoPath: repos.beta },
    ],
  });
  writeWorktrees(ODD_IDS_WS, [{ id: 'odd' }]);
  writeJson(join(workspaceDir(COWORK_WS), 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
  });

  await registerCodeReviewTarget(`${SINGLE_WS}--healthy`, {
    projectId: SINGLE_WS,
    worktreeId: 'healthy',
  });
  await registerCodeReviewTarget(`${SINGLE_WS}--missing`, {
    projectId: SINGLE_WS,
    worktreeId: 'missing',
  });
  await registerCodeReviewTarget('viewer--scope', {
    projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    worktreeId: CONTAINER,
  });
  await registerPlanExploreTarget('plan-01', {
    projectId: MULTI_WS,
    worktreeId: 'untracked',
  });
  await registerPlanExploreTarget('plan-tracked', {
    projectId: MULTI_WS,
    worktreeId: 'tracked',
  });
  // A row a check recording under the chat scope's own id would rewrite.
  writeWorktrees(PLAN_EXPLORE_CHAT_PROJECT_ID, [
    { id: 'plan-tracked', healthIssue: STALE_ISSUE },
  ]);

  registerHandlers();
  closeW5Store = await installRoutedW5GoldenStore();
});

// The grants every desktop IPC caller carries (desktop-ipc-caller.ts).
const desktopCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [
    'worker.filesystem.read',
    'core.workspace.read',
    'core.chat.read',
    'core.chat.write',
    'core.worktree.read',
  ],
};

let runtime: DesktopCanopyDispatcher | undefined;

function registerHandlers(): void {
  runtime = createDesktopRuntime();
  registerWorktreeHandlers(() => null, {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
  });
}

afterAll(async () => {
  await closeW5Store?.();
  await runtime?.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  originalGitEnv.forEach((value: string | undefined, key: string) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  rmSync(dir, { recursive: true, force: true });
});

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// Git's stderr differs by Git version, and the executable path by host. A
// child-process error from another Jest realm fails `instanceof Error`, so
// the check reports its fallback first line here.
const GIT_FAILURE =
  /^(?:Git health check failed|Command failed: \S+ rev-parse --is-inside-work-tree)\n[\s\S]+$/;

function scrubText(value: string): string {
  const failure = GIT_FAILURE.exec(value);
  if (failure)
    return `${failure[0].split('\n')[0].replace(/^Command failed: \S+/, 'Command failed: <git>')}\n<git stderr>`;
  return value
    .split(dir)
    .join('<root>')
    .replace(ISO, '<time>')
    .replace(UUID, '<uuid>')
    .replace(
      /([a-z])\1{99,}/g,
      (run, letter: string) => `<${run.length} ${letter}>`,
    );
}

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrub(entry)]),
    );
  return value;
}

// Thrown errors may come from another Jest realm, so read their fields
// instead of relying on `instanceof Error`.
function describeError(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null)
    return { thrown: String(error) };
  const code: unknown = Reflect.get(error, 'code');
  return {
    name: String(Reflect.get(error, 'name')),
    message: scrubText(String(Reflect.get(error, 'message'))),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

type Outcome = { response: string } | { error: Record<string, unknown> };

/**
 * The response as IPC delivers it: insertion-ordered keys, with the
 * properties that are present but `undefined` spelled out.
 */
function exactJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry: unknown) => (entry === undefined ? '<undefined>' : entry),
    2,
  );
}

/** Every worktree list in the data root, keyed by workspace directory. */
function worktreeLists(): Record<string, string> {
  const root = join(dataDir, 'workspaces');
  const lists: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name, 'worktrees.json');
    if (entry.isDirectory() && existsSync(path))
      lists[entry.name] = readFileSync(path, 'utf8');
  }
  return lists;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;

/**
 * The fields the health record owns on the stored row; the stored issue
 * drops undefined properties, as JSON does.
 */
function storedHealth(
  list: string | undefined,
  worktreeId: string,
  responseWorktree: unknown,
): unknown {
  const rows = field(list ? JSON.parse(list) : null, 'worktrees');
  const stored: unknown = Array.isArray(rows)
    ? rows.find((entry: unknown) => field(entry, 'id') === worktreeId)
    : undefined;
  if (typeof stored !== 'object' || stored === null) return null;
  const healthIssue = scrub(field(stored, 'healthIssue'));
  const responseIssue = field(responseWorktree, 'healthIssue');
  return {
    healthIssue:
      healthIssue !== undefined &&
      JSON.stringify(healthIssue) === JSON.stringify(responseIssue)
        ? '<the response issue>'
        : (healthIssue ?? null),
    splitRecoveryRequired: field(stored, 'splitRecoveryRequired') ?? null,
  };
}

/**
 * One health check: its outcome (the exact response or the thrown error), the
 * worktree lists it changed, and the stored row of the checked worktree.
 */
async function check(
  request: unknown,
  row?: { workspaceId: string; worktreeId: string },
  event: unknown = {},
): Promise<Record<string, unknown>> {
  const handler = mockHandlers.get(IPC_CHANNELS.worktreeHealthCheck);
  if (!handler) throw new Error('worktree:health-check was not registered');
  const before = worktreeLists();
  let outcome: Outcome;
  let responseWorktree: unknown;
  try {
    const response = scrub(await handler(event, request));
    responseWorktree =
      typeof response === 'object' && response !== null
        ? Reflect.get(response, 'worktree')
        : undefined;
    outcome = { response: exactJson(response) };
  } catch (error) {
    outcome = { error: describeError(error) };
  }
  const after = worktreeLists();
  const changedLists = Object.keys({ ...before, ...after })
    .filter((key) => before[key] !== after[key])
    .sort();
  return {
    outcome,
    changedLists,
    ...(row
      ? {
          recordedRow: storedHealth(
            after[row.workspaceId],
            row.worktreeId,
            responseWorktree,
          ),
        }
      : {}),
  };
}

const single = (worktreeId: string): Promise<Record<string, unknown>> =>
  check(
    { projectId: SINGLE_WS, worktreeId },
    { workspaceId: SINGLE_WS, worktreeId },
  );
const multi = (
  worktreeId: string,
  workspaceId = MULTI_WS,
): Promise<Record<string, unknown>> =>
  check({ projectId: workspaceId, worktreeId }, { workspaceId, worktreeId });

describe('worktree:health-check single-repo worktrees', () => {
  it('clears a stored issue and the split recovery flag on a healthy checkout', async () => {
    expect(await single('healthy')).toMatchSnapshot();
  });

  it('records a missing worktree directory', async () => {
    expect(await single('missing')).toMatchSnapshot();
  });

  it('records a directory without Git metadata', async () => {
    expect(await single('no-git')).toMatchSnapshot();
  });

  it('confirms a .git directory with Git', async () => {
    expect(await single('git-dir')).toMatchSnapshot('work tree');
    expect(await single('bare')).toMatchSnapshot('bare');
  });

  it('classifies .git files by their gitdir pointer', async () => {
    for (const worktreeId of [
      'no-gitdir-line',
      'missing-gitdir',
      'relative-gitdir',
      'file-gitdir',
    ])
      expect(await single(worktreeId)).toMatchSnapshot(worktreeId);
  });

  it('answers with a best-effort row for a worktree missing from the list', async () => {
    expect(await single('unlisted')).toMatchSnapshot();
  });
});

describe('worktree:health-check multi-repo worktrees', () => {
  it('clears a stored issue when the root and every member are healthy', async () => {
    expect(await multi('all-healthy')).toMatchSnapshot();
  });

  it('checks every directory under repos/ without includedRepoIds', async () => {
    expect(await multi('untracked')).toMatchSnapshot();
  });

  it('checks only included repositories and skips payload directories', async () => {
    expect(await multi('tracked')).toMatchSnapshot();
  });

  it('carries the Git error of a single repository issue', async () => {
    expect(await multi('one-broken')).toMatchSnapshot();
  });

  it('names a present repository by its configured name, even when empty', async () => {
    expect(await multi('unnamed-broken')).toMatchSnapshot();
  });

  it('reports the first issue code and no Git error for several issues', async () => {
    expect(await multi('two-broken')).toMatchSnapshot();
  });

  it('reports a source-backed root that is not a checkout', async () => {
    expect(await multi('root-broken')).toMatchSnapshot();
  });

  it('records a missing worktree root without repository issues', async () => {
    expect(await multi('root-missing')).toMatchSnapshot();
  });

  it('reports configured repository ids of any length', async () => {
    expect(await multi('odd', ODD_IDS_WS)).toMatchSnapshot();
  });

  it('never validates the root of a workspace without a source repository', async () => {
    expect(await multi('plain-root', MULTI_NO_SOURCE_WS)).toMatchSnapshot(
      'plain root',
    );
    expect(await multi('git-root', MULTI_NO_SOURCE_WS)).toMatchSnapshot(
      'Git root',
    );
  });
});

describe('worktree:health-check scopes', () => {
  // CAN-5460: a registry-backed chat scope is checked as the real worktree it
  // borrows, under that workspace's records, and the real row is recorded;
  // nothing is recorded under the chat scope's own id.
  it('checks a registry-backed chat scope as its real worktree', async () => {
    expect(
      await check(
        {
          projectId: CODE_REVIEW_CHAT_PROJECT_ID,
          worktreeId: `${SINGLE_WS}--healthy`,
        },
        { workspaceId: SINGLE_WS, worktreeId: 'healthy' },
      ),
    ).toMatchSnapshot('code review, healthy');
    expect(
      await check(
        {
          projectId: CODE_REVIEW_CHAT_PROJECT_ID,
          worktreeId: `${SINGLE_WS}--missing`,
        },
        { workspaceId: SINGLE_WS, worktreeId: 'missing' },
      ),
    ).toMatchSnapshot('code review, missing');
    // Like the real check of multi-ws/untracked, this also reports the
    // configured beta and gamma checkouts that are missing.
    expect(
      await check(
        { projectId: PLAN_EXPLORE_CHAT_PROJECT_ID, worktreeId: 'plan-01' },
        { workspaceId: MULTI_WS, worktreeId: 'untracked' },
      ),
    ).toMatchSnapshot('plan explore');
  });

  it("judges a chat scope by the real workspace's repositories and includedRepoIds", async () => {
    const untracked = await check(
      { projectId: PLAN_EXPLORE_CHAT_PROJECT_ID, worktreeId: 'plan-01' },
      { workspaceId: MULTI_WS, worktreeId: 'untracked' },
    );
    expect(
      JSON.parse(String(field(untracked.outcome, 'response'))),
    ).toMatchObject({
      healthy: false,
      issue: {
        code: 'missing-repository',
        repoIssues: [
          { repoId: 'beta', repoName: 'Beta', code: 'missing-repository' },
          { repoId: 'gamma', code: 'missing-repository' },
          { repoId: 'notes', code: 'missing-git-metadata' },
        ],
      },
    });
    // includedRepoIds names alpha only: beta and gamma are not expected, and
    // repos/notes is an untracked payload directory.
    const tracked = await check(
      { projectId: PLAN_EXPLORE_CHAT_PROJECT_ID, worktreeId: 'plan-tracked' },
      { workspaceId: MULTI_WS, worktreeId: 'tracked' },
    );
    expect(tracked).toMatchSnapshot('tracked');
    expect(
      JSON.parse(String(field(tracked.outcome, 'response'))),
    ).toMatchObject({ healthy: true, worktree: { id: 'tracked' } });
    expect(tracked.changedLists).not.toContain(PLAN_EXPLORE_CHAT_PROJECT_ID);
  });

  it('keeps the registry errors of unregistered chat scopes', async () => {
    expect(
      await check({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'unregistered--scope',
      }),
    ).toMatchSnapshot('code review');
    expect(
      await check({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'unregistered-plan',
      }),
    ).toMatchSnapshot('plan explore');
  });

  // Recorded debt (CAN-4107 D9): a run directory has no workspace records, so
  // it keeps today's response.
  it('checks a shared-container run directory a registry entry borrows', async () => {
    expect(
      await check({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'viewer--scope',
      }),
    ).toMatchSnapshot();
  });

  it('checks cowork, standalone chat, App Advisor and unknown scopes', async () => {
    for (const request of [
      { projectId: COWORK_WS, worktreeId: 'home' },
      { projectId: STANDALONE_CHAT_PROJECT_ID, worktreeId: COWORK_WS },
      { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'home' },
      { projectId: 'ghost-ws', worktreeId: 'feature-01' },
    ])
      expect(await check(request)).toMatchSnapshot(request.projectId);
  });

  // validateId bounds no length; a canonical scope carries at most 512.
  it('checks identifiers longer than a canonical scope carries', async () => {
    expect(
      await check({ projectId: 'a'.repeat(513), worktreeId: 'feature-01' }),
    ).toMatchSnapshot('long project');
    expect(
      await check({ projectId: SINGLE_WS, worktreeId: 'b'.repeat(513) }),
    ).toMatchSnapshot('long worktree');
  });
});

describe('worktree:health-check refusals', () => {
  it('refuses the shared-container viewer before validating the worktree', async () => {
    for (const request of [
      { projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID, worktreeId: CONTAINER },
      { projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID, worktreeId: '' },
      { projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID, worktreeId: 7 },
    ])
      expect(await check(request)).toMatchSnapshot(JSON.stringify(request));
  });

  it('keeps identifier validation messages', async () => {
    for (const request of [
      { projectId: 'Bad', worktreeId: 'healthy' },
      { projectId: '', worktreeId: 'healthy' },
      { projectId: 42, worktreeId: 'healthy' },
      { projectId: SINGLE_WS, worktreeId: '' },
      { projectId: SINGLE_WS, worktreeId: '../escape' },
      { projectId: SINGLE_WS },
    ])
      expect(await check(request)).toMatchSnapshot(JSON.stringify(request));
  });
});

// CAN-4729: on macOS and Linux the check is served by the daemon, whose answer
// carries codes only (q-49). The response and recorded row stay byte for byte:
// a broken worktree's private detail is diagnosed again in main (CAN-7188).
describe('worktree:health-check through the daemon route (CAN-4729)', () => {
  const lifetime = createElectronDaemonCallerLifetime();
  // The daemon's answer: the same check, without main's capture.
  const query = jest.fn(async (...args: unknown[]) => {
    const { scope } = WorkerGitWorktreeHealthGetParamsSchema.parse(args[1]);
    return toWorkerGitWorktreeHealthResult(
      await inspectWorktreeHealth(
        desktopWorktreeHealthSources(
          scope.workspaceId,
          scope.worktreeId,
          resolveWorktreeCwd(scope.workspaceId, scope.worktreeId),
        ),
      ),
    );
  });
  const connection = new AbortController();
  const fake: DaemonGitQueryClient = { signal: connection.signal, query };
  // Holds a check inside its manifest read, to retire its document meanwhile.
  let manifestHook: (() => Promise<void>) | undefined;
  let deadlineMs: number | undefined;
  // The production-connection block swaps in the bundled daemon's client.
  let client: DaemonGitQueryClient = fake;
  let authorityId = 'local-desktop';
  const route = (platform: 'darwin' | 'linux' | 'win32'): DaemonGitRoute =>
    createDaemonGitRoute({
      lifetime,
      platform,
      workspaceType: getWorkspaceType,
      resolveWorktreeTargetIds,
      // Production's check (electron-daemon-git-access.ts), with a test pause.
      workspaceManifestReadable: async (workspaceId): Promise<boolean> => {
        await manifestHook?.();
        return workspaceManifestReadable(workspaceId);
      },
      hostContext: () => Promise.resolve({ authorityId }),
      connections: () => ({
        get: (): Promise<{ client: DaemonGitQueryClient }> =>
          Promise.resolve({ client }),
      }),
      ...(deadlineMs !== undefined && { queryDeadlineMs: deadlineMs }),
    });
  const register = (platform?: 'darwin' | 'linux' | 'win32'): void => {
    if (!runtime) throw new Error('The runtime did not start.');
    const selected = platform && route(platform);
    registerWorktreeHandlers(() => null, {
      dispatcher: runtime,
      resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
      ...(selected && { daemonGitRoute: (): DaemonGitRoute => selected }),
    });
  };
  const event = { sender: new FakeSender(1) };
  // As the sidebar read registers them; an unregistered workspace stays in process.
  beforeAll(() => {
    // Still indexed and listed, but its workspace manifest is gone.
    const indexPath = join(dataDir, 'workspaces', 'index.json');
    const index = field(
      JSON.parse(readFileSync(indexPath, 'utf8')) as unknown,
      'workspaces',
    );
    if (!Array.isArray(index)) throw new Error('No workspace index.');
    const entries: unknown[] = index;
    writeJson(indexPath, {
      version: 1,
      workspaces: [
        ...entries,
        workspaceEntry(NO_MANIFEST_WS, 'single-repo', 5),
        workspaceEntry(INVALID_MANIFEST_WS, 'single-repo', 6),
        workspaceEntry(MALFORMED_OWNER_WS, 'single-repo', 7),
        ...Object.keys(REFUSED_MANIFESTS).map((id, index) =>
          workspaceEntry(id, 'single-repo', 8 + index),
        ),
        ...PATH_DIVERGENT.map((id, index) =>
          workspaceEntry(id, 'multi-repo', 20 + index),
        ),
      ],
    });
    writeWorktrees(NO_MANIFEST_WS, [{ id: 'gone' }]);
    writeWorktrees(INVALID_MANIFEST_WS, [{ id: 'gone' }]);
    writeWorktrees(MALFORMED_OWNER_WS, [{ id: 'gone' }]);
    writeJson(join(workspaceDir(MALFORMED_OWNER_WS), 'workspace.json'), {
      version: 1,
      type: 'single-repo',
      repos: [],
      owner: 42,
    });
    for (const [id, manifest] of Object.entries(REFUSED_MANIFESTS)) {
      writeWorktrees(id, [{ id: 'gone' }]);
      writeJson(join(workspaceDir(id), 'workspace.json'), manifest);
    }
    // A plain (broken) root with a healthy member checkout.
    for (const id of PATH_DIVERGENT) {
      plainDir(worktreeDir(id, 'plain-root'));
      addCheckout(
        repos.alpha,
        join(worktreeDir(id, 'plain-root'), 'repos', 'alpha'),
      );
      writeWorktrees(id, [{ id: 'plain-root', includedRepoIds: ['alpha'] }]);
    }
    writeJson(join(workspaceDir(RELATIVE_SOURCE_WS), 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: 'relative/source',
      repos: [{ id: 'alpha', name: 'Alpha', repoPath: repos.alpha }],
    });
    writeJson(join(workspaceDir(RELATIVE_REPO_WS), 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'alpha', name: 'Alpha', repoPath: 'relative/alpha' }],
    });
    writeFileSync(
      join(workspaceDir(INVALID_MANIFEST_WS), 'workspace.json'),
      '{ not json',
    );
    registerWorkspaceTypes(
      new Map([
        [SINGLE_WS, 'single-repo'],
        [MULTI_WS, 'multi-repo'],
        [COWORK_WS, 'cowork'],
        [NO_MANIFEST_WS, 'single-repo'],
        [INVALID_MANIFEST_WS, 'single-repo'],
        [MALFORMED_OWNER_WS, 'single-repo'],
        ...Object.keys(REFUSED_MANIFESTS).map((id): [string, 'single-repo'] => [
          id,
          'single-repo',
        ]),
        ...PATH_DIVERGENT.map((id): [string, 'multi-repo'] => [
          id,
          'multi-repo',
        ]),
        [MULTI_NO_SOURCE_WS, 'multi-repo'],
      ]),
    );
  });
  const ROUTED_CASES = [
    [SINGLE_WS, 'healthy'],
    [SINGLE_WS, 'missing'],
    [SINGLE_WS, 'no-git'],
    [MULTI_WS, 'all-healthy'],
    [MULTI_WS, 'one-broken'],
    [MULTI_WS, 'two-broken'],
    [MULTI_WS, 'root-missing'],
  ] as const;
  // Manifests the daemon refuses but main still records an issue for.
  const UNREADABLE_MANIFESTS = [
    NO_MANIFEST_WS,
    INVALID_MANIFEST_WS,
    MALFORMED_OWNER_WS,
    ...Object.keys(REFUSED_MANIFESTS),
  ].map((workspaceId) => ({
    request: { projectId: workspaceId, worktreeId: 'gone' },
    row: { workspaceId, worktreeId: 'gone' },
  }));
  /** The check resolved and wrote a fresh issue, not the seeded one. */
  const assertRecordedFresh = (
    routed: Record<string, unknown>,
    workspaceId: string,
  ): void => {
    expect(Reflect.get(routed, 'changedLists')).toEqual([workspaceId]);
    expect(JSON.stringify(routed)).not.toContain(STALE_ISSUE.worktreePath);
    expect(JSON.stringify(routed)).toContain('missing-worktree-path');
    expect(Object.keys(Reflect.get(routed, 'outcome') ?? {})).toEqual([
      'response',
    ]);
    expect(
      Reflect.get(Reflect.get(routed, 'recordedRow') ?? {}, 'healthIssue'),
    ).toBe('<the response issue>');
  };
  // The daemon's health host refuses cowork records; these stay in process.
  const COWORK_CASES = [
    { projectId: COWORK_WS, worktreeId: 'home' },
    { projectId: STANDALONE_CHAT_PROJECT_ID, worktreeId: COWORK_WS },
  ];
  /**
   * Gives the row a stale issue and split recovery, as a check finds them,
   * and returns the list's exact text so a second leg can start from it.
   */
  const seedStale = (row: {
    workspaceId: string;
    worktreeId: string;
  }): string => {
    const path = join(workspaceDir(row.workspaceId), 'worktrees.json');
    const rows = field(
      JSON.parse(readFileSync(path, 'utf8')) as unknown,
      'worktrees',
    );
    if (!Array.isArray(rows)) throw new Error(`No worktree list at ${path}.`);
    writeJson(path, {
      version: 1,
      worktrees: rows.map((entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        field(entry, 'id') === row.worktreeId
          ? { ...entry, healthIssue: STALE_ISSUE, splitRecoveryRequired: true }
          : entry,
      ),
    });
    return readFileSync(path, 'utf8');
  };
  /**
   * Asserts the routed check answers and records as the in-process one, each
   * starting from the same stale row, so neither leg cleans up for the other.
   */
  const sameAsInProcess = async (
    platform: 'darwin' | 'linux',
    request: { projectId: string; worktreeId: string },
    row?: { workspaceId: string; worktreeId: string },
  ): Promise<Record<string, unknown>> => {
    register();
    const seeded = row && seedStale(row);
    const inProcess = await check(request, row, event);
    register(platform);
    if (row && seeded)
      writeFileSync(
        join(workspaceDir(row.workspaceId), 'worktrees.json'),
        seeded,
      );
    const routed = await check(request, row, event);
    expect(routed).toEqual(inProcess);
    return routed;
  };
  /** A health answer without its check time. */
  const verdict = (result: unknown): unknown => {
    const parsed = WorkerGitWorktreeHealthGetResultSchema.parse(result);
    return parsed.healthy
      ? parsed
      : { code: parsed.issue.code, repoIssues: parsed.issue.repoIssues };
  };
  // A healthy check clears the stale issue and split recovery it found.
  const HEALTHY_ROWS = new Set(['healthy', 'all-healthy']);
  const assertCleared = async (
    platform: 'darwin' | 'linux',
    workspaceId: string,
    worktreeId: string,
  ): Promise<void> => {
    const row = { workspaceId, worktreeId };
    register(platform);
    seedStale(row);
    const routed = await check(
      { projectId: workspaceId, worktreeId },
      row,
      event,
    );
    expect(Reflect.get(routed, 'recordedRow')).toEqual({
      healthIssue: null,
      splitRecoveryRequired: null,
    });
  };
  afterAll(() => {
    registerWorkspaceTypes(new Map());
    lifetime.disposeAll();
    register();
  });

  it.each(['darwin', 'linux'] as const)(
    'answers as in process on %s, asking the daemon for every check',
    async (platform) => {
      for (const [workspaceId, worktreeId] of ROUTED_CASES) {
        query.mockClear();
        await sameAsInProcess(
          platform,
          { projectId: workspaceId, worktreeId },
          { workspaceId, worktreeId },
        );
        // Counts only: a failure must not print the forwarded environment.
        expect(query.mock.calls.length).toBe(1);
        if (HEALTHY_ROWS.has(worktreeId))
          await assertCleared(platform, workspaceId, worktreeId);
      }
    },
  );

  it.each(['darwin', 'linux'] as const)(
    'records a missing or unreadable manifest in process on %s, with no daemon contact',
    async (platform) => {
      for (const { request, row } of UNREADABLE_MANIFESTS) {
        query.mockClear();
        const routed = await sameAsInProcess(platform, request, row);
        expect(query.mock.calls.length).toBe(0);
        assertRecordedFresh(routed, request.projectId);
      }
    },
  );

  it.each(['darwin', 'linux'] as const)(
    'keeps a workspace whose recorded paths the daemon would drop in process on %s, with no daemon contact',
    async (platform) => {
      for (const workspaceId of PATH_DIVERGENT) {
        query.mockClear();
        const routed = await sameAsInProcess(
          platform,
          { projectId: workspaceId, worktreeId: 'plain-root' },
          { workspaceId, worktreeId: 'plain-root' },
        );
        expect(query.mock.calls.length).toBe(0);
        expect(Reflect.get(routed, 'changedLists')).toEqual([workspaceId]);
      }
      // Main validates the plain root against the recorded source: broken,
      // with the issue it found recorded.
      const routed = await sameAsInProcess(
        platform,
        { projectId: RELATIVE_SOURCE_WS, worktreeId: 'plain-root' },
        { workspaceId: RELATIVE_SOURCE_WS, worktreeId: 'plain-root' },
      );
      expect(JSON.stringify(routed)).toContain('missing-git-metadata');
      expect(
        Reflect.get(Reflect.get(routed, 'recordedRow') ?? {}, 'healthIssue'),
      ).toBe('<the response issue>');
    },
  );

  it('cancels a check whose document navigates while its manifest is read', async () => {
    const row = { workspaceId: SINGLE_WS, worktreeId: 'healthy' };
    const list = join(workspaceDir(SINGLE_WS), 'worktrees.json');
    const sender = new FakeSender(1);
    // The document already holds an owner from its earlier requests.
    lifetime.ownerFor(sender);
    const entered = deferred();
    const release = deferred();
    manifestHook = async (): Promise<void> => {
      entered.resolve();
      await release.promise;
    };
    try {
      register('darwin');
      const seeded = seedStale(row);
      query.mockClear();
      const pending = check(
        { projectId: SINGLE_WS, worktreeId: 'healthy' },
        row,
        { sender },
      );
      await entered.promise;
      sender.emit('did-navigate');
      release.resolve();
      const outcome = await pending;
      expect(query.mock.calls.length).toBe(0);
      expect(Object.keys(Reflect.get(outcome, 'outcome') ?? {})).toEqual([
        'error',
      ]);
      expect(readFileSync(list, 'utf8')).toBe(seeded);
    } finally {
      manifestHook = undefined;
      release.resolve();
    }
  });

  /** Settles within `ms`, or answers that the check is still pending. */
  const within = <T>(pending: Promise<T>, ms: number): Promise<T | 'pending'> =>
    Promise.race([
      pending,
      new Promise<'pending'>((resolve) =>
        setTimeout(() => resolve('pending'), ms),
      ),
    ]);

  // Checkouts main confirms with Git (a single-repo root; a multi-repo root
  // with no source repository), which the daemon calls broken. The second
  // look pauses in one source while the document navigates.
  it.each([
    ['readWorkspace', SINGLE_WS, 'healthy'],
    ['listRepositoryEntries', MULTI_NO_SOURCE_WS, 'git-root'],
  ] as const)(
    'cancels a check whose document navigates while a broken verdict is diagnosed again (paused in %s)',
    async (pausedIn, workspaceId, worktreeId) => {
      const row = { workspaceId, worktreeId };
      const list = join(workspaceDir(workspaceId), 'worktrees.json');
      const sender = new FakeSender(1);
      lifetime.ownerFor(sender);
      const entered = deferred();
      const release = deferred();
      const actual =
        worktreeHealthModule.desktopWorktreeHealthSources.bind(null);
      let gitLaunches = 0;
      // Every Git launch the second look makes: repository listing and confirmation.
      const listing = jest.spyOn(gitModule, 'isGitRepo');
      const sources = jest
        .spyOn(worktreeHealthModule, 'desktopWorktreeHealthSources')
        .mockImplementationOnce((...args) => {
          const real = actual(...args);
          const paused =
            <T>(read: () => Promise<T>) =>
            async (): Promise<T> => {
              entered.resolve();
              await release.promise;
              return read();
            };
          return {
            ...real,
            ...(pausedIn === 'readWorkspace'
              ? { readWorkspace: paused(() => real.readWorkspace()) }
              : {
                  listRepositoryEntries: paused(() =>
                    real.listRepositoryEntries(),
                  ),
                }),
            confirmWorkTree: (
              path,
            ): ReturnType<typeof real.confirmWorkTree> => {
              gitLaunches += 1;
              return real.confirmWorkTree(path);
            },
          };
        });
      query.mockImplementationOnce(() =>
        Promise.resolve({
          healthy: false,
          issue: {
            code: 'invalid-git-worktree',
            checkedAt: new Date().toISOString(),
            repoIssues: null,
          },
        }),
      );
      try {
        register('darwin');
        const seeded = seedStale(row);
        query.mockClear();
        const pending = check({ projectId: workspaceId, worktreeId }, row, {
          sender,
        });
        await entered.promise;
        listing.mockClear();
        sender.emit('did-navigate');
        release.resolve();
        const outcome = await pending;
        // The paused read finishes, but no new Git starts after the cancel.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(gitLaunches + listing.mock.calls.length).toBe(0);
        expect(query.mock.calls.length).toBe(1);
        expect(Object.keys(Reflect.get(outcome, 'outcome') ?? {})).toEqual([
          'error',
        ]);
        expect(readFileSync(list, 'utf8')).toBe(seeded);
      } finally {
        release.resolve();
        sources.mockRestore();
        listing.mockRestore();
      }
    },
  );

  // The same second looks, paused inside the Git helpers' own setup (their
  // executable lookup) instead: a health Git command that had not started
  // never starts. The lookup's own discovery probe is a known limit.
  (process.platform === 'win32' ? it.skip : it).each([
    [SINGLE_WS, 'healthy'],
    [MULTI_NO_SOURCE_WS, 'git-root'],
  ] as const)(
    'starts no health Git command after a navigation while Git setup is paused (%s/%s)',
    async (workspaceId, worktreeId) => {
      const row = { workspaceId, worktreeId };
      const list = join(workspaceDir(workspaceId), 'worktrees.json');
      const sender = new FakeSender(1);
      lifetime.ownerFor(sender);
      const entered = deferred();
      const release = deferred();
      // Counts every Git process main actually starts.
      const marker = join(dir, `git-launches-${worktreeId}`);
      const countingGit = join(dir, `counting-git-${worktreeId}`);
      writeFileSync(
        countingGit,
        `#!/bin/sh\necho launch >> '${marker}'\nexec /usr/bin/git "$@"\n`,
      );
      chmodSync(countingGit, 0o755);
      const launches = (): number =>
        existsSync(marker)
          ? readFileSync(marker, 'utf8').split('\n').filter(Boolean).length
          : 0;
      const resolveGit =
        gitExecutableModule.getResolvedGitExecutableForSpawn.bind(null);
      const setup = jest
        .spyOn(gitExecutableModule, 'getResolvedGitExecutableForSpawn')
        .mockImplementation(async (): Promise<string> => {
          // Only the second look, which runs after the daemon answered.
          if (query.mock.calls.length === 0) return resolveGit();
          entered.resolve();
          await release.promise;
          return countingGit;
        });
      query.mockImplementationOnce(() =>
        Promise.resolve({
          healthy: false,
          issue: {
            code: 'invalid-git-worktree',
            checkedAt: new Date().toISOString(),
            repoIssues: null,
          },
        }),
      );
      try {
        register('darwin');
        const seeded = seedStale(row);
        query.mockClear();
        const pending = check({ projectId: workspaceId, worktreeId }, row, {
          sender,
        });
        await entered.promise;
        sender.emit('did-navigate');
        release.resolve();
        const outcome = await pending;
        // Long enough for a started Git to have written its line, under load.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        expect(launches()).toBe(0);
        expect(query.mock.calls.length).toBe(1);
        expect(Object.keys(Reflect.get(outcome, 'outcome') ?? {})).toEqual([
          'error',
        ]);
        expect(readFileSync(list, 'utf8')).toBe(seeded);
      } finally {
        release.resolve();
        setup.mockRestore();
      }
    },
  );

  // Cancelled before the executable lookup: the listing's Git helper stops
  // without looking the executable up, so no discovery runs for it.
  it('looks up no Git executable after a navigation while the listing checks its directory', async () => {
    const row = { workspaceId: MULTI_NO_SOURCE_WS, worktreeId: 'git-root' };
    const list = join(workspaceDir(MULTI_NO_SOURCE_WS), 'worktrees.json');
    const sender = new FakeSender(1);
    lifetime.ownerFor(sender);
    const entered = deferred();
    const release = deferred();
    const assertDirectory =
      workingDirectoryModule.assertWorkingDirectoryAvailable.bind(null);
    const directory = jest
      .spyOn(workingDirectoryModule, 'assertWorkingDirectoryAvailable')
      .mockImplementation(async (...args): Promise<void> => {
        // Only the second look, which runs after the daemon answered.
        if (query.mock.calls.length === 0) return assertDirectory(...args);
        entered.resolve();
        await release.promise;
        return assertDirectory(...args);
      });
    const lookup = jest.spyOn(
      gitExecutableModule,
      'getResolvedGitExecutableForSpawn',
    );
    query.mockImplementationOnce(() =>
      Promise.resolve({
        healthy: false,
        issue: {
          code: 'invalid-git-worktree',
          checkedAt: new Date().toISOString(),
          repoIssues: null,
        },
      }),
    );
    try {
      register('darwin');
      const seeded = seedStale(row);
      query.mockClear();
      const pending = check(
        { projectId: MULTI_NO_SOURCE_WS, worktreeId: 'git-root' },
        row,
        { sender },
      );
      await entered.promise;
      lookup.mockClear();
      sender.emit('did-navigate');
      release.resolve();
      const outcome = await pending;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(lookup.mock.calls.length).toBe(0);
      expect(Object.keys(Reflect.get(outcome, 'outcome') ?? {})).toEqual([
        'error',
      ]);
      expect(readFileSync(list, 'utf8')).toBe(seeded);
    } finally {
      release.resolve();
      directory.mockRestore();
      lookup.mockRestore();
    }
  });

  it('settles a check whose manifest read never returns, on navigation and at the deadline', async () => {
    const row = { workspaceId: SINGLE_WS, worktreeId: 'healthy' };
    const list = join(workspaceDir(SINGLE_WS), 'worktrees.json');
    manifestHook = (): Promise<void> => new Promise(() => undefined);
    try {
      // Navigation retires the document while the read hangs.
      const sender = new FakeSender(1);
      lifetime.ownerFor(sender);
      register('darwin');
      const seeded = seedStale(row);
      query.mockClear();
      const navigated = check(
        { projectId: SINGLE_WS, worktreeId: 'healthy' },
        row,
        { sender },
      );
      sender.emit('did-navigate');
      const cancelled = await within(navigated, 2_000);
      if (cancelled === 'pending')
        throw new Error('The check did not settle on navigation.');
      expect(Object.keys(Reflect.get(cancelled, 'outcome') ?? {})).toEqual([
        'error',
      ]);
      // The deadline ends a hung read with no navigation.
      deadlineMs = 100;
      register('darwin');
      const timedOut = await within(
        check({ projectId: SINGLE_WS, worktreeId: 'healthy' }, row, {
          sender: new FakeSender(1),
        }),
        2_000,
      );
      expect(timedOut).not.toBe('pending');
      expect(JSON.stringify(timedOut)).toContain('took too long');
      expect(query.mock.calls.length).toBe(0);
      expect(readFileSync(list, 'utf8')).toBe(seeded);
    } finally {
      manifestHook = undefined;
      deadlineMs = undefined;
    }
  });

  it.each(['darwin', 'linux'] as const)(
    'keeps cowork and standalone chat checks in process on %s, with no daemon contact',
    async (platform) => {
      for (const request of COWORK_CASES) {
        query.mockClear();
        await sameAsInProcess(platform, request);
        expect(query.mock.calls.length).toBe(0);
      }
    },
  );

  // The lean gate (CAN-4729): the route over Electron's production client
  // definitions, served by the bundled daemon's own health host.
  const posix = process.platform === 'win32' ? describe.skip : describe;
  posix('over the production connection to the bundled daemon', () => {
    let daemon: RunningCanopyDaemon | undefined;
    let production: ElectronDaemonClient | undefined;
    const connected = (): ElectronDaemonClient => {
      if (!production) throw new Error('The daemon did not start.');
      return production;
    };
    beforeAll(async () => {
      // The daemon publishes its runtime files only under a private root.
      chmodSync(dataDir, 0o700);
      daemon = await startCanopyDaemon({
        dataRoot: dataDir,
        runtimeMode: 'dev',
        buildVersion: 'test',
        brandId: 'canopy',
        secureDataRoot: join(dir, 'secure'),
        coworkManagedDirName: '.canopy',
        environment: {
          HOME: dir,
          TMPDIR: tmpdir(),
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        },
      });
      const { descriptor } = daemon;
      production = await connectCanopyClient({
        endpoint: {
          kind: 'socket',
          path: descriptor.endpoint.path,
          auth: {
            secret: readFileSync(descriptor.tokenRef, 'utf8'),
            dataRootHash: createHash('sha256').update(dataDir).digest('hex'),
          },
        },
        clientName: 'worktree-health',
        clientVersion: '0',
        definitions: ELECTRON_DAEMON_DEFINITIONS,
      });
      await production.instruction('core.client.lease.acquire', {
        clientInstanceId: 'worktree-health',
        interfaceKind: 'desktop',
        label: 'Worktree health',
        interactive: true,
        foreground: true,
        renewalIntervalMs: 15_000,
        _meta: { idempotencyKey: 'worktree-health-lease' },
      });
      ({ authorityId } = await deriveLocalAuthorityIdentity(
        { brandId: 'canopy', dataRoot: dataDir },
        hostLocalAuthorityObservation(),
      ));
      client = production;
    });
    afterAll(async () => {
      client = fake;
      authorityId = 'local-desktop';
      await production?.close();
      await daemon?.stop('test');
    });

    it("keeps a window's in-flight Files read while a health check takes its Git-read session", async () => {
      const running = daemon;
      if (!running) throw new Error('The daemon did not start.');
      const { descriptor } = running;
      const connections = createElectronDaemonConnectionService({
        enabled: true,
        authorityId,
        attach: () =>
          connectCanopyClient({
            endpoint: {
              kind: 'socket',
              path: descriptor.endpoint.path,
              auth: {
                secret: readFileSync(descriptor.tokenRef, 'utf8'),
                dataRootHash: createHash('sha256')
                  .update(dataDir)
                  .digest('hex'),
              },
            },
            clientName: 'worktree-health-window',
            clientVersion: '0',
            definitions: ELECTRON_DAEMON_DEFINITIONS,
          }),
      });
      const owner = new AbortController();
      const window = {
        principalId: 'local-desktop-user',
        clientInstanceId: 'window-1',
        authorityId,
        interfaceKind: 'desktop' as const,
      };
      try {
        const files = await connections.get(
          { ...window, grants: [WORKER_FILESYSTEM_GRANTS.read] },
          owner.signal,
        );
        const reading = files.client.query('worker.filesystem.roots.list', {
          scope: { workspaceId: SINGLE_WS, worktreeId: 'healthy', authorityId },
        });
        const git = await connections.get(
          { ...window, grants: [WORKER_GIT_GRANTS.read] },
          owner.signal,
        );
        await expect(reading).resolves.toBeDefined();
        expect(files.signal.aborted).toBe(false);
        await expect(
          git.client.query('worker.git.worktree.health.get', {
            scope: {
              workspaceId: SINGLE_WS,
              worktreeId: 'healthy',
              authorityId,
            },
          }),
        ).resolves.toEqual({ healthy: true });
        // Each grant set keeps its own session: asking again reuses it.
        expect(
          await connections.get(
            { ...window, grants: [WORKER_FILESYSTEM_GRANTS.read] },
            owner.signal,
          ),
        ).toBe(files);
        expect(files.signal.aborted).toBe(false);
        // A window keeps a few sessions at once; a fifth grant set closes the
        // oldest.
        for (const grants of [
          [WORKER_GIT_GRANTS.write],
          [WORKER_FILESYSTEM_GRANTS.read, WORKER_GIT_GRANTS.read],
        ])
          await connections.get({ ...window, grants }, owner.signal);
        expect(files.signal.aborted).toBe(false);
        await connections.get(
          {
            ...window,
            grants: [WORKER_FILESYSTEM_GRANTS.read, WORKER_GIT_GRANTS.write],
          },
          owner.signal,
        );
        expect(files.signal.aborted).toBe(true);
        expect(git.signal.aborted).toBe(false);
      } finally {
        owner.abort();
        await connections.dispose();
      }
    });

    it('answers healthy and broken worktrees as in process', async () => {
      const asked = jest.spyOn(connected(), 'query');
      try {
        for (const [workspaceId, worktreeId] of ROUTED_CASES) {
          asked.mockClear();
          await sameAsInProcess(
            'darwin',
            { projectId: workspaceId, worktreeId },
            { workspaceId, worktreeId },
          );
          expect(asked.mock.calls.length).toBe(1);
          // The daemon's own verdict, not main's re-diagnosis of a broken one.
          expect(verdict(await asked.mock.results[0]?.value)).toEqual(
            verdict(
              toWorkerGitWorktreeHealthResult(
                await inspectWorktreeHealth(
                  desktopWorktreeHealthSources(
                    workspaceId,
                    worktreeId,
                    resolveWorktreeCwd(workspaceId, worktreeId),
                  ),
                ),
              ),
            ),
          );
          if (HEALTHY_ROWS.has(worktreeId))
            await assertCleared('darwin', workspaceId, worktreeId);
        }
      } finally {
        asked.mockRestore();
      }
    });

    it('records missing and unreadable manifests in process, which the daemon would refuse', async () => {
      for (const { request } of UNREADABLE_MANIFESTS)
        await expect(
          connected().query('worker.git.worktree.health.get', {
            scope: {
              workspaceId: request.projectId,
              worktreeId: request.worktreeId,
              authorityId,
            },
          }),
        ).rejects.toMatchObject({
          payload: { code: 'worker.git.worktree.scopeUnsupported' },
        });
      const asked = jest.spyOn(connected(), 'query');
      try {
        for (const { request, row } of UNREADABLE_MANIFESTS) {
          asked.mockClear();
          const routed = await sameAsInProcess('darwin', request, row);
          expect(asked.mock.calls.length).toBe(0);
          assertRecordedFresh(routed, request.projectId);
        }
      } finally {
        asked.mockRestore();
      }
    });

    it('keeps a workspace whose recorded paths the daemon would drop in process', async () => {
      // The daemon drops the relative source path, skips the root and calls
      // the broken worktree healthy; recording that would clear its issue.
      expect(
        await connected().query('worker.git.worktree.health.get', {
          scope: {
            workspaceId: RELATIVE_SOURCE_WS,
            worktreeId: 'plain-root',
            authorityId,
          },
        }),
      ).toEqual({ healthy: true });
      const asked = jest.spyOn(connected(), 'query');
      try {
        for (const workspaceId of PATH_DIVERGENT) {
          asked.mockClear();
          const routed = await sameAsInProcess(
            'darwin',
            { projectId: workspaceId, worktreeId: 'plain-root' },
            { workspaceId, worktreeId: 'plain-root' },
          );
          expect(asked.mock.calls.length).toBe(0);
          expect(Reflect.get(routed, 'changedLists')).toEqual([workspaceId]);
        }
      } finally {
        asked.mockRestore();
      }
    });

    it('keeps cowork in process, which the daemon would refuse', async () => {
      await expect(
        connected().query('worker.git.worktree.health.get', {
          scope: { workspaceId: COWORK_WS, worktreeId: 'home', authorityId },
        }),
      ).rejects.toMatchObject({
        payload: { code: 'worker.git.worktree.scopeUnsupported' },
      });
      const asked = jest.spyOn(connected(), 'query');
      try {
        for (const request of COWORK_CASES) {
          await sameAsInProcess('darwin', request);
          expect(asked.mock.calls.length).toBe(0);
        }
      } finally {
        asked.mockRestore();
      }
    });
  });

  it('keeps Windows on the in-process check, with no daemon contact', async () => {
    register();
    const inProcess = await check(
      { projectId: SINGLE_WS, worktreeId: 'missing' },
      { workspaceId: SINGLE_WS, worktreeId: 'missing' },
      event,
    );
    register('win32');
    query.mockClear();
    expect(
      await check(
        { projectId: SINGLE_WS, worktreeId: 'missing' },
        { workspaceId: SINGLE_WS, worktreeId: 'missing' },
        event,
      ),
    ).toEqual(inProcess);
    expect(query).not.toHaveBeenCalled();
  });
});
