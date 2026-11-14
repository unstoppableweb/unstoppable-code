import { installRoutedW5GoldenStore } from '../lib/__tests__/fixtures/w5-routed-golden-store';
// CAN-4070 rule: captured on the unchanged `worktree:health-check` IPC handler
// before CAN-5136 routed it through `worker.git.worktree.health.get`. Real
// data root, workspace records, registries and Git checkouts; only IPC
// registration is mocked. `checkedAt` and other timestamps are normalized.
import { execFileSync } from 'node:child_process';
import {
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
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
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
): Promise<Record<string, unknown>> {
  const handler = mockHandlers.get(IPC_CHANNELS.worktreeHealthCheck);
  if (!handler) throw new Error('worktree:health-check was not registered');
  const before = worktreeLists();
  let outcome: Outcome;
  let responseWorktree: unknown;
  try {
    const event: Partial<IpcMainInvokeEvent> = {};
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
