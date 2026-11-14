import { installRoutedW5GoldenStore } from '../lib/__tests__/fixtures/w5-routed-golden-store';
// CAN-4070 rule: captured on the unchanged `worktree:list-branches` and
// `home:list-branch-targets` IPC handlers before CAN-4107 routed them through
// `worker.git.branch.list`. Real data root, workspace records, registries,
// Git checkouts, bare origins and default-branch freshness file; only IPC
// registration is mocked.
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeWorktreeBaseBranch,
  type PortalCommandEnvelope,
} from '@canopy/protocol/portal';
import { baseBranchRef } from '@canopy/ui-app';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  decodeCanopyError,
  encodeCanopyError,
  WorkerGitBranchListParamsSchema,
  WorkerGitBranchSchema,
  type CanopyCallerDescriptor,
  type WorkerGitBranchListParams,
  type WorkerGitBranchListResult,
} from '@canopy/protocol/canopy-core';
import {
  CanopyClientError,
  type CanopyClientQueryOptions,
} from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import { createGitReadHost } from '@canopy/core-platform';
import {
  createGitBranch,
  checkoutGitBranch,
  createRecordedWorkerGitHosts,
  createWorkerGitBranchListHandlers,
  type GitRepositoryRead,
} from '@canopy/core-runtime/node/git';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
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
import { registerHomeSurfaceHandlers } from '../ipc/home-surface';
import { handlePortalWorktreeBranchesList } from '../portal/adapters/worktree-adapter';
import { createSingleRepoWorktree } from '../lib/worktree-service';
import {
  createOptionsForNewWorktreeBaseTarget,
  defaultNewWorktreeBaseTarget,
} from '../../renderer/src/stores/homeComposerStore';
import { recordGitDefaultBranch } from '../lib/git-default-branch-freshness';
import { DEFAULT_BRANCH_FRESHNESS_TTL_MS } from '../lib/git-default-branch';
import { registerCodeReviewTarget } from '../lib/code-review-registry';
import { registerPlanExploreTarget } from '../lib/plan-explore-registry';
import { getSharedContainerRunRootDir } from '../lib/paths';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import {
  createDaemonGitRoute,
  type DaemonGitRoute,
  type DaemonGitRouteOptions,
} from '../canopy-runtime/daemon-git-route';
import { createElectronDaemonCallerLifetime } from '../canopy-runtime/electron-daemon-caller-lifetime';
import { FakeSender } from '../canopy-runtime/__tests__/daemon-files-route-harness';
import * as gitHelpers from '../lib/git';
import { refreshWorktreeDiffStats } from '../services/worktree-diff-stats-cache';
import * as defaultBranchHelpers from '../lib/git-default-branch';
import * as freshnessStore from '../lib/git-default-branch-freshness';
import { READ_ROUTE_TABLE } from '../canopy-runtime/daemon-read-route-guard';

import { AutomationsService } from '../automations/service';
import * as chatService from '../services/chat-service';
import * as hostBridge from '../remote-control/host/bridge-window';
import { RemoteHostSession } from '../remote-control/host/host-session';
import { RemoteHostConnection } from '../remote-control/client/host-connection';
import { RemoteUploadStore } from '../remote-control/host/uploads';
import { RpcPeer } from '../remote-control/transport/rpc-peer';
import type { SecureSession } from '../remote-control/transport/session-manager';
import type * as WaitDiagnostics from '../observability/chat-wait-diagnostics';

jest.mock('../observability/chat-wait-diagnostics', () => {
  const actual = jest.requireActual<typeof WaitDiagnostics>(
    '../observability/chat-wait-diagnostics',
  );
  return {
    ...actual,
    startChatWaitOperation: (
      options: Parameters<typeof actual.startChatWaitOperation>[0],
    ): WaitDiagnostics.ChatWaitOperation =>
      actual.startChatWaitOperation({
        ...options,
        record: (): void => undefined,
      }),
  };
});
import {
  HelloResultSchema,
  InvokeParamsSchema,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../remote-control/remote-protocol';
import { InMemoryRelayHub } from '../remote-control/__tests__/in-memory-relay';
import {
  createTestDevice,
  openControlSession,
} from '../remote-control/__tests__/session-pair';
import { type AutomationCreateRequest } from '@canopy/desktop-shared/types';
import { getAutomationsFilePath } from '../lib/paths';
import { stopPolling } from '../lib/github-poller';

jest.setTimeout(120_000);

let dir: string;
let dataDir: string;
let originalDataDir: string | undefined;

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

function commit(path: string, file: string): void {
  writeFileSync(join(path, file), `${file}\n`);
  git(path, ['add', '.']);
  git(path, ['commit', '-q', '-m', file]);
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'golden@example.com']);
  git(path, ['config', 'user.name', 'Golden']);
  commit(path, 'README.md');
}

/** A bare origin with main, develop and release; its HEAD names main. */
function createOrigin(name: string): string {
  const seed = join(dir, 'seeds', name);
  initRepo(seed);
  git(seed, ['branch', 'develop']);
  git(seed, ['branch', 'release']);
  const origin = join(dir, 'origins', `${name}.git`);
  mkdirSync(join(origin, '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
    stdio: 'pipe',
  });
  return origin;
}

function cloneOrigin(origin: string, name: string): string {
  const path = join(dir, 'clones', name);
  mkdirSync(join(path, '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', origin, path], { stdio: 'pipe' });
  git(path, ['config', 'user.email', 'golden@example.com']);
  git(path, ['config', 'user.name', 'Golden']);
  return path;
}

function originHead(repo: string): string {
  try {
    return git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  } catch {
    return '(unset)';
  }
}

async function seedFreshness(
  repo: string,
  defaultBranch: string,
  resolvedAt: number,
): Promise<void> {
  await recordGitDefaultBranch({
    identity: {
      commonDir: realpathSync(join(repo, '.git')),
      originUrl: git(repo, ['remote', 'get-url', 'origin']),
    },
    defaultBranch,
    resolvedAt,
  });
}

function workspaceEntry(id: string, type: string, order: number): object {
  return { id, name: id, type, color: '#38BDF8', collapsed: false, order };
}

function writeWorktrees(workspaceId: string, ids: string[]): void {
  writeJson(join(workspaceDir(workspaceId), 'worktrees.json'), {
    version: 1,
    worktrees: ids.map((id) => ({
      id,
      branchName: id,
      createdAt: '2026-10-26T00:00:00.000Z',
    })),
  });
}

function addSingleRepoWorkspace(id: string, repo: string): void {
  writeJson(join(workspaceDir(id), 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repo,
    repos: [],
  });
}

const FRESH_WS = 'fresh-ws';
const STALE_WS = 'stale-ws';
const REPAIR_WS = 'repair-ws';
const OFFLINE_WS = 'offline-ws';
const OFFLINE_STALE_WS = 'offline-stale-ws';
const OFFLINE_CONVENTIONAL_WS = 'offline-conventional-ws';
const NO_ORIGIN_WS = 'no-origin-ws';
const MULTI_WS = 'multi-ws';
const MULTI_NO_SOURCE_WS = 'multi-no-source-ws';
const COWORK_WS = 'cowork-ws';
const WORKTREE = 'feature-01';
const OTHER_WORKTREE = 'feature-02';
const CONTAINER = 'container-01';

const repos: Record<string, string> = {};
const origins: Record<string, string> = {};
let freshnessPath: string;
let closeW5Store: (() => Promise<void>) | undefined;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-branch-list-golden-')));
  dataDir = join(dir, 'data');
  freshnessPath = join(dataDir, 'git-default-branch-freshness.json');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;

  for (const id of [
    FRESH_WS,
    STALE_WS,
    REPAIR_WS,
    OFFLINE_WS,
    OFFLINE_STALE_WS,
    OFFLINE_CONVENTIONAL_WS,
    MULTI_WS,
  ]) {
    origins[id] = createOrigin(id);
    repos[id] = cloneOrigin(origins[id], id);
  }
  // A fetched branch that exists only on the remote, plus a local-only one.
  git(join(dir, 'seeds', FRESH_WS), ['branch', 'remote-only']);
  git(join(dir, 'seeds', FRESH_WS), [
    'push',
    '-q',
    origins[FRESH_WS],
    'remote-only',
  ]);
  git(repos[FRESH_WS], ['fetch', '-q', 'origin']);
  git(repos[FRESH_WS], ['branch', 'local-only']);
  git(repos[FRESH_WS], [
    'worktree',
    'add',
    '-q',
    '-b',
    WORKTREE,
    worktreeDir(FRESH_WS, WORKTREE),
  ]);
  git(repos[FRESH_WS], [
    'worktree',
    'add',
    '-q',
    '-b',
    OTHER_WORKTREE,
    worktreeDir(FRESH_WS, OTHER_WORKTREE),
  ]);
  for (const id of [
    STALE_WS,
    REPAIR_WS,
    OFFLINE_WS,
    OFFLINE_STALE_WS,
    OFFLINE_CONVENTIONAL_WS,
  ])
    git(repos[id], [
      'worktree',
      'add',
      '-q',
      '-b',
      WORKTREE,
      worktreeDir(id, WORKTREE),
    ]);

  // Stale and divergent local origin/HEAD knowledge.
  git(repos[STALE_WS], ['remote', 'set-head', 'origin', 'develop']);
  git(repos[REPAIR_WS], ['remote', 'set-head', 'origin', 'develop']);
  // Offline: origin points at a missing repository.
  for (const id of [OFFLINE_WS, OFFLINE_STALE_WS, OFFLINE_CONVENTIONAL_WS])
    git(repos[id], [
      'remote',
      'set-url',
      'origin',
      join(dir, 'origins', 'missing.git'),
    ]);
  git(repos[OFFLINE_STALE_WS], ['remote', 'set-head', 'origin', '-d']);
  git(repos[OFFLINE_CONVENTIONAL_WS], ['remote', 'set-head', 'origin', '-d']);

  repos[NO_ORIGIN_WS] = join(dir, 'clones', NO_ORIGIN_WS);
  initRepo(repos[NO_ORIGIN_WS]);
  git(repos[NO_ORIGIN_WS], ['branch', 'topic']);
  git(repos[NO_ORIGIN_WS], [
    'worktree',
    'add',
    '-q',
    '-b',
    WORKTREE,
    worktreeDir(NO_ORIGIN_WS, WORKTREE),
  ]);

  // Multi-repo: a source-backed root checkout and one member checkout.
  const memberOrigin = createOrigin('member');
  repos.member = cloneOrigin(memberOrigin, 'member');
  git(repos[MULTI_WS], [
    'worktree',
    'add',
    '-q',
    '-b',
    WORKTREE,
    worktreeDir(MULTI_WS, WORKTREE),
  ]);
  git(repos.member, [
    'worktree',
    'add',
    '-q',
    '-b',
    WORKTREE,
    join(worktreeDir(MULTI_WS, WORKTREE), 'repos', 'member'),
  ]);

  // A shared-container viewer run directory holding its own checkout.
  initRepo(getSharedContainerRunRootDir(CONTAINER));
  git(getSharedContainerRunRootDir(CONTAINER), ['branch', 'shared-topic']);

  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      ...[
        FRESH_WS,
        STALE_WS,
        REPAIR_WS,
        OFFLINE_WS,
        OFFLINE_STALE_WS,
        OFFLINE_CONVENTIONAL_WS,
        NO_ORIGIN_WS,
      ].map((id, order) => workspaceEntry(id, 'single-repo', order)),
      workspaceEntry(MULTI_WS, 'multi-repo', 20),
      workspaceEntry(MULTI_NO_SOURCE_WS, 'multi-repo', 21),
      workspaceEntry(COWORK_WS, 'cowork', 22),
    ],
  });
  for (const id of [
    FRESH_WS,
    STALE_WS,
    REPAIR_WS,
    OFFLINE_WS,
    OFFLINE_STALE_WS,
    OFFLINE_CONVENTIONAL_WS,
    NO_ORIGIN_WS,
  ]) {
    addSingleRepoWorkspace(id, repos[id]);
    writeWorktrees(
      id,
      id === FRESH_WS ? [WORKTREE, OTHER_WORKTREE] : [WORKTREE],
    );
  }
  writeJson(join(workspaceDir(MULTI_WS), 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: repos[MULTI_WS],
    repos: [{ id: 'member', name: 'member', repoPath: repos.member }],
  });
  writeWorktrees(MULTI_WS, [WORKTREE]);
  writeJson(join(workspaceDir(MULTI_NO_SOURCE_WS), 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [{ id: 'member', name: 'member', repoPath: repos.member }],
  });
  writeJson(join(workspaceDir(COWORK_WS), 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
  });

  const now = Date.now();
  await seedFreshness(repos[FRESH_WS], 'develop', now - 1_000);
  const stale = now - DEFAULT_BRANCH_FRESHNESS_TTL_MS - 60_000;
  await seedFreshness(repos[STALE_WS], 'release', stale);
  await seedFreshness(repos[OFFLINE_STALE_WS], 'release', stale);

  await registerCodeReviewTarget(`${FRESH_WS}--${WORKTREE}`, {
    projectId: FRESH_WS,
    worktreeId: WORKTREE,
  });
  await registerPlanExploreTarget('plan-01', {
    projectId: MULTI_WS,
    worktreeId: WORKTREE,
  });

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

function registerHandlers(
  daemonGitRoute?: () => DaemonGitRoute,
  unusedGit = false,
): void {
  const unused = (): never => {
    throw new Error('The direct Git runtime was touched.');
  };
  runtime = createDesktopRuntime(
    unusedGit
      ? {
          workerGitHost: {
            authorityId: desktopCaller.authorityId,
            resolveRepository: unused,
            reads: unused,
            now: unused,
          },
        }
      : {},
  );
  const accessors = {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
    ...(daemonGitRoute && { daemonGitRoute }),
  };
  registerWorktreeHandlers(() => null, accessors);
  registerHomeSurfaceHandlers(accessors);
}

afterAll(async () => {
  await closeW5Store?.();
  await runtime?.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function scrub(value: string): string {
  return value
    .split(dir)
    .join('<root>')
    .replace(ISO, '<time>')
    .replace(/spawn \S+ ENOENT/g, 'spawn <git> ENOENT');
}

// Child-process errors come from another Jest realm, so read their fields
// instead of relying on `instanceof Error`.
function describeError(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null)
    return { thrown: String(error) };
  const code: unknown = Reflect.get(error, 'code');
  return {
    name: String(Reflect.get(error, 'name')),
    message: scrub(String(Reflect.get(error, 'message'))),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

type Outcome = { result: unknown } | { error: Record<string, unknown> };

async function ipc(channel: string, request: unknown): Promise<Outcome> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  try {
    const event = { sender: routeSender };
    return { result: await handler(event, request) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

const routeSender = new FakeSender(1);

function freshnessBytes(): string {
  return existsSync(freshnessPath) ? readFileSync(freshnessPath, 'utf8') : '';
}

/** The freshness file with entry keys checked against their identity. */
function freshnessEntries(): unknown {
  const text = freshnessBytes();
  if (!text) return null;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const version: unknown = Reflect.get(parsed, 'version');
  const entries: unknown = Reflect.get(parsed, 'entries');
  if (typeof entries !== 'object' || entries === null) return parsed;
  return {
    version,
    entries: Object.entries(entries)
      .map(([key, value]: [string, unknown]) => {
        if (typeof value !== 'object' || value === null) return { key, value };
        const commonDir: unknown = Reflect.get(value, 'commonDir');
        const originHash: unknown = Reflect.get(value, 'originHash');
        const defaultBranch: unknown = Reflect.get(value, 'defaultBranch');
        return {
          keyMatchesCommonDir:
            typeof commonDir === 'string' &&
            key === createHash('sha256').update(commonDir).digest('hex'),
          commonDir: typeof commonDir === 'string' ? scrub(commonDir) : null,
          originHashLength:
            typeof originHash === 'string' ? originHash.length : null,
          defaultBranch,
          resolvedAt: scrub(String(Reflect.get(value, 'resolvedAt'))),
        };
      })
      .sort((left, right) =>
        String(left.commonDir).localeCompare(String(right.commonDir)),
      ),
  };
}

/** One IPC call with the default-branch effects it left behind. */
async function observe(
  channel: string,
  request: unknown,
  repo?: string,
): Promise<Record<string, unknown>> {
  const before = freshnessBytes();
  const beforeHead = repo ? originHead(repo) : undefined;
  const outcome = await ipc(channel, request);
  return {
    outcome,
    freshnessFileChanged: freshnessBytes() !== before,
    ...(repo
      ? { originHeadBefore: beforeHead, originHeadAfter: originHead(repo) }
      : {}),
  };
}

const listBranches = (
  request: unknown,
  repo?: string,
): Promise<Record<string, unknown>> =>
  observe(IPC_CHANNELS.worktreeListBranches, request, repo);
const branchTargets = (
  request: unknown,
  repo?: string,
): Promise<Record<string, unknown>> =>
  observe(IPC_CHANNELS.homeListBranchTargets, request, repo);

describe('worktree:list-branches', () => {
  it('serves a fresh stored default without a remote lookup or write', async () => {
    expect(
      await listBranches(
        { projectId: FRESH_WS, worktreeId: WORKTREE },
        repos[FRESH_WS],
      ),
    ).toMatchSnapshot();
  });

  it('revalidates a stale stored default, records it and repairs origin/HEAD', async () => {
    expect(
      await listBranches(
        { projectId: STALE_WS, worktreeId: WORKTREE },
        repos[STALE_WS],
      ),
    ).toMatchSnapshot();
    expect(freshnessEntries()).toMatchSnapshot('freshness after revalidation');
    // The recorded value is now fresh: a changed remote HEAD is not consulted.
    git(origins[STALE_WS], ['symbolic-ref', 'HEAD', 'refs/heads/develop']);
    expect(
      await listBranches(
        { projectId: STALE_WS, worktreeId: WORKTREE },
        repos[STALE_WS],
      ),
    ).toMatchSnapshot('after the record');
  });

  it('records a remote default without stored knowledge and repairs origin/HEAD', async () => {
    expect(
      await listBranches(
        { projectId: REPAIR_WS, worktreeId: WORKTREE },
        repos[REPAIR_WS],
      ),
    ).toMatchSnapshot();
  });

  it('falls back offline to local origin/HEAD, a stale value, then conventional refs', async () => {
    expect(
      await listBranches(
        { projectId: OFFLINE_WS, worktreeId: WORKTREE },
        repos[OFFLINE_WS],
      ),
    ).toMatchSnapshot('local origin/HEAD');
    expect(
      await listBranches(
        { projectId: OFFLINE_STALE_WS, worktreeId: WORKTREE },
        repos[OFFLINE_STALE_WS],
      ),
    ).toMatchSnapshot('stale stored value');
    expect(
      await listBranches(
        { projectId: OFFLINE_CONVENTIONAL_WS, worktreeId: WORKTREE },
        repos[OFFLINE_CONVENTIONAL_WS],
      ),
    ).toMatchSnapshot('conventional refs');
  });

  it('shows the cached default branch in the Portal catalogue and keeps a tag-shadowed remote branch', async () => {
    const command: PortalCommandEnvelope = {
      id: 'portal-branch-golden',
      sequence: 1,
      type: 'portal.worktree.branches.list',
      payload: {
        workspaceId: OFFLINE_STALE_WS,
        baseBranchEncoding: 'explicit-v2',
      },
      createdAt: '2026-11-11T00:00:00.000Z',
      expiresAt: null,
    };
    const complete = jest.fn();
    const fail = jest.fn();

    const repo = repos[OFFLINE_STALE_WS];
    git(repo, ['tag', 'origin/release']);
    git(repo, ['tag', 'main']);
    git(repo, ['update-ref', 'refs/heads/origin/release', 'refs/heads/main']);
    git(repo, ['update-ref', 'refs/heads/refs/heads/main', 'refs/heads/main']);
    try {
      await handlePortalWorktreeBranchesList(command, {
        sessionId: 'portal-branch-golden',
        getWindow: () => null,
        enqueueEvent: jest.fn(),
        complete,
        fail,
      });
    } finally {
      git(repo, ['tag', '-d', 'origin/release', 'main']);
      git(repo, ['update-ref', '-d', 'refs/heads/origin/release']);
      git(repo, ['update-ref', '-d', 'refs/heads/refs/heads/main']);
    }

    const branches: unknown = expect.arrayContaining([
      expect.objectContaining({
        name: 'main',
        hasLocalRef: true,
        hasRemoteRef: true,
      }),
      expect.objectContaining({
        name: 'origin/release',
        hasLocalRef: true,
        hasRemoteRef: false,
      }),
      expect.objectContaining({
        name: 'refs/heads/main',
        hasLocalRef: true,
        hasRemoteRef: false,
      }),
      expect.objectContaining({
        name: 'release',
        isRemote: true,
        hasRemoteRef: true,
        hasLocalRef: false,
      }),
    ]);
    expect(fail).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      command,
      expect.objectContaining({
        supported: true,
        defaultBranch: 'release',
        branches,
      }),
    );
  });

  it('lists a repository without origin and no default branch', async () => {
    expect(
      await listBranches(
        { projectId: NO_ORIGIN_WS, worktreeId: WORKTREE },
        repos[NO_ORIGIN_WS],
      ),
    ).toMatchSnapshot();
  });

  it('selects multi-repo checkouts by repository id', async () => {
    for (const repoId of [
      undefined,
      WORKSPACE_ROOT_REPO_ID,
      'member',
      'absent',
    ])
      expect(
        await listBranches({
          projectId: MULTI_WS,
          worktreeId: WORKTREE,
          ...(repoId === undefined ? {} : { repoId }),
        }),
      ).toMatchSnapshot(`repoId ${String(repoId)}`);
  });

  it('resolves registry-backed chat scopes to the real worktree', async () => {
    expect(
      await listBranches({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: `${FRESH_WS}--${WORKTREE}`,
      }),
    ).toMatchSnapshot('code review');
    expect(
      await listBranches({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: `${FRESH_WS}--${WORKTREE}`,
        repoId: WORKSPACE_ROOT_REPO_ID,
      }),
    ).toMatchSnapshot('code review workspace root');
    expect(
      await listBranches({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: `${FRESH_WS}--${WORKTREE}`,
        repoId: 'member',
      }),
    ).toMatchSnapshot('code review child repository');
    expect(
      await listBranches({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-01',
      }),
    ).toMatchSnapshot('plan explore');
    expect(
      await listBranches({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'unregistered--scope',
      }),
    ).toMatchSnapshot('unregistered code review');
    expect(
      await listBranches({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'unregistered-plan',
      }),
    ).toMatchSnapshot('unregistered plan explore');
  });

  it('lists a shared-container viewer run directory', async () => {
    expect(
      await listBranches({
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: CONTAINER,
      }),
    ).toMatchSnapshot();
  });

  it('keeps the failures of non-repository and unknown scopes', async () => {
    for (const request of [
      { projectId: COWORK_WS, worktreeId: 'home' },
      { projectId: 'ghost-ws', worktreeId: WORKTREE },
    ])
      expect(await listBranches(request)).toMatchSnapshot(request.projectId);
  });

  it('keeps identifier validation messages', async () => {
    for (const request of [
      { projectId: 'Bad', worktreeId: WORKTREE },
      { projectId: FRESH_WS, worktreeId: '' },
      { projectId: FRESH_WS, worktreeId: WORKTREE, repoId: 'Bad' },
      { projectId: FRESH_WS, worktreeId: WORKTREE, repoId: 42 },
    ])
      expect(await listBranches(request)).toMatchSnapshot(
        JSON.stringify(request),
      );
  });
});

describe('home:list-branch-targets', () => {
  it('reports the source branch state and clears it after an external first commit', async () => {
    const repo = repos[NO_ORIGIN_WS];
    const branch = 'unborn-home';
    git(repo, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    try {
      expect(
        await ipc(IPC_CHANNELS.homeListBranchTargets, {
          workspaceId: NO_ORIGIN_WS,
        }),
      ).toMatchObject({ result: { supported: true, headUnborn: true } });
      git(repo, [
        'commit',
        '--allow-empty',
        '-qm',
        'first commit on source branch',
      ]);
      expect(
        await ipc(IPC_CHANNELS.homeListBranchTargets, {
          workspaceId: NO_ORIGIN_WS,
        }),
      ).toMatchObject({ result: { supported: true, headUnborn: false } });
    } finally {
      git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      git(repo, ['branch', '-D', branch]);
    }
  });

  it('lists the reference repository of a single-repo workspace', async () => {
    expect(
      await branchTargets({ workspaceId: FRESH_WS }, repos[FRESH_WS]),
    ).toMatchSnapshot();
  });

  it('lists the source repository of a multi-repo workspace', async () => {
    expect(
      await branchTargets({ workspaceId: MULTI_WS }, repos[MULTI_WS]),
    ).toMatchSnapshot();
  });

  it('reports unsupported workspaces without a reference repository', async () => {
    for (const workspaceId of [MULTI_NO_SOURCE_WS, COWORK_WS, 'ghost-ws'])
      expect(await branchTargets({ workspaceId })).toMatchSnapshot(workspaceId);
  });

  it('keeps identifier validation messages', async () => {
    for (const workspaceId of ['Bad', '', 7])
      expect(await branchTargets({ workspaceId })).toMatchSnapshot(
        JSON.stringify(workspaceId),
      );
  });
});

// CAN-5501: the production adapter and IPC projections against the daemon's
// recorded Git host and fixed-command runner. Only the connection is in memory.
describe('daemon branch-list route equivalence', () => {
  const authorityId = 'authority-can-5501';
  const lifetime = createElectronDaemonCallerLifetime();
  const connection = new AbortController();
  const reads: GitRepositoryRead[] = [];
  const queryOptions: Array<CanopyClientQueryOptions | undefined> = [];
  const routes: DaemonGitRoute[] = [];
  let gitHost: ReturnType<typeof createGitReadHost>;
  let handlers: ReturnType<typeof createWorkerGitBranchListHandlers>;
  let branchHost: ReturnType<typeof createRecordedWorkerGitHosts>['branchList'];
  const query = jest.fn(
    async (
      _name: 'worker.git.branch.list',
      params: WorkerGitBranchListParams,
      options?: CanopyClientQueryOptions,
    ) => {
      queryOptions.push(options);
      try {
        return await handlers['worker.git.branch.list'](
          WorkerGitBranchListParamsSchema.parse(params),
          {
            requestId: 'route-test',
            caller: {
              ...desktopCaller,
              authorityId,
              grants: ['worker.git.read'],
            },
            signal: options?.signal ?? new AbortController().signal,
            metadata: options?.metadata ?? {},
            ...(options?.execution && { execution: options.execution }),
          },
        );
      } catch (error) {
        if (!(error instanceof CanopyOperationError)) throw error;
        throw new CanopyClientError(
          decodeCanopyError(
            JSON.parse(JSON.stringify(encodeCanopyError(error))),
          ),
        );
      }
    },
  );
  const hostContext = jest.fn(() => Promise.resolve({ authorityId }));
  const connections = jest.fn(() => ({
    get: (): Promise<{
      client: { signal: AbortSignal; query: typeof query };
    }> => Promise.resolve({ client: { signal: connection.signal, query } }),
  }));
  let executionSequence = 0;
  const execution = jest.fn(() => ({
    childEnvironment: {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      REQUEST: String(++executionSequence),
      PATH: process.env.PATH ?? '',
    },
  }));
  const routeFor = (
    overrides: Partial<DaemonGitRouteOptions> = {},
  ): DaemonGitRoute => {
    const route = createDaemonGitRoute({
      lifetime,
      hostContext,
      connections,
      workspaceType: () => 'single-repo',
      resolveWorktreeTargetIds: (projectId, worktreeId) => ({
        projectId,
        worktreeId,
      }),
      platform: 'darwin',
      selectable: new Set(['git.branch.list']),
      execution,
      ...overrides,
    });
    routes.push(route);
    return route;
  };
  const checkout: WorkerGitBranchListParams = {
    scope: { workspaceId: REPAIR_WS, worktreeId: WORKTREE },
    repository: { kind: 'checkout' },
  };
  const neverDirect = jest.fn(
    (): Promise<never> =>
      Promise.reject(new Error('Direct fallback was touched.')),
  );
  const list = (
    route: DaemonGitRoute,
    params = checkout,
    caller = desktopCaller,
  ): Promise<WorkerGitBranchListResult> =>
    route.branchList(params, { caller }, { sender: routeSender }, neverDirect);

  beforeAll(() => {
    // The same fixtures and records as the unchanged IPC golden above.
    gitHost = createGitReadHost({
      os: process.platform === 'linux' ? 'linux' : 'darwin',
      environment: process.env,
      probeDirectory: dir,
    });
    const hosts = createRecordedWorkerGitHosts({
      dataRoot: dataDir,
      authorityId,
      recordsTargetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      os: process.platform,
      arch: process.arch,
      git: {
        read: (read, cwd, invocation) => {
          reads.push(read);
          return gitHost.repository.readRepository({
            read,
            cwd,
            signal: invocation.signal,
            readSavedExecutablePath: () => Promise.resolve(''),
            ...(invocation.environment && {
              environment: invocation.environment,
            }),
          });
        },
        selectExecutable: (request) =>
          gitHost.repository.selectExecutable({
            ...request,
            readSavedExecutablePath: () => Promise.resolve(''),
          }),
      },
    });
    branchHost = hosts.branchList;
    handlers = createWorkerGitBranchListHandlers(branchHost);
  });
  afterAll(async () => {
    routes.forEach((route) => route.dispose());
    lifetime.disposeAll();
    await gitHost.stop(new AbortController().signal);
  });
  beforeEach(() => {
    query.mockClear();
    hostContext.mockClear();
    connections.mockClear();
    execution.mockClear();
    neverDirect.mockClear();
    reads.length = 0;
    queryOptions.length = 0;
  });

  it('keeps the legacy closed result and opts into verified source HEAD state', async () => {
    const route = routeFor();
    const params: WorkerGitBranchListParams = {
      scope: { workspaceId: NO_ORIGIN_WS },
      repository: { kind: 'reference' },
    };
    expect(await list(route, params)).not.toHaveProperty('headUnborn');
    expect(
      await list(route, { ...params, includeHeadState: true }),
    ).toHaveProperty('headUnborn', false);
    const repo = repos[NO_ORIGIN_WS];
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/unborn-daemon']);
    try {
      expect(
        await list(route, { ...params, includeHeadState: true }),
      ).toHaveProperty('headUnborn', true);
    } finally {
      git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
  });

  it('lists cached branch bases without consulting origin on the relay path', async () => {
    const result = await query('worker.git.branch.list', {
      ...checkout,
      allowRemoteLookup: false,
      defaultBranchHint: {
        defaultBranch: 'cached-base',
        resolvedAt: '2000-01-01T00:00:00.000Z',
      },
    });
    expect(result.branches.length).toBeGreaterThan(0);
    expect(result.defaultBranch).toBe('cached-base');
    expect(result.defaultBranchSource).toBe('stale-hint');
    expect(reads.some((read) => read.kind === 'remote-head')).toBe(false);
  });

  it('preserves the repositoryUnavailable code through the L0 error codec', () => {
    const error = new CanopyOperationError({
      kind: 'failed_precondition',
      code: 'worker.git.branch.repositoryUnavailable',
      message: 'The workspace has no source repository.',
      retry: { kind: 'never' },
    });
    const wire: unknown = JSON.parse(JSON.stringify(encodeCanopyError(error)));
    expect(decodeCanopyError(wire)).toEqual(error.payload);
    expect(
      new CanopyOperationError(decodeCanopyError(wire)).runtimeCause,
    ).toBeUndefined();
  });

  it('returns byte-identical checkout and reference IPC results without touching the direct runtime', async () => {
    const cases = [
      [
        IPC_CHANNELS.worktreeListBranches,
        { projectId: FRESH_WS, worktreeId: WORKTREE },
      ],
      [
        IPC_CHANNELS.worktreeListBranches,
        { projectId: MULTI_WS, worktreeId: WORKTREE },
      ],
      [
        IPC_CHANNELS.worktreeListBranches,
        {
          projectId: MULTI_WS,
          worktreeId: WORKTREE,
          repoId: WORKSPACE_ROOT_REPO_ID,
        },
      ],
      [
        IPC_CHANNELS.worktreeListBranches,
        { projectId: MULTI_WS, worktreeId: WORKTREE, repoId: 'member' },
      ],
      [IPC_CHANNELS.homeListBranchTargets, { workspaceId: FRESH_WS }],
      [IPC_CHANNELS.homeListBranchTargets, { workspaceId: MULTI_WS }],
    ] as const;
    const direct: Outcome[] = [];
    for (const [channel, request] of cases)
      direct.push(await ipc(channel, request));
    await runtime?.shutdown();
    registerHandlers(() => routeFor(), true);
    for (const [index, [channel, request]] of cases.entries())
      expect(JSON.stringify(await ipc(channel, request))).toBe(
        JSON.stringify(direct[index]),
      );
    expect(query).toHaveBeenCalledTimes(cases.length);
    expect(reads.filter((read) => read.kind === 'remote-head')).toHaveLength(0);
    expect(execution).toHaveBeenCalledTimes(cases.length);
    expect(queryOptions[0]?.execution).not.toEqual(queryOptions[1]?.execution);
    for (const [channel, request] of [
      [IPC_CHANNELS.homeListBranchTargets, { workspaceId: MULTI_NO_SOURCE_WS }],
      [IPC_CHANNELS.homeListBranchTargets, { workspaceId: COWORK_WS }],
    ] as const)
      expect(await ipc(channel, request)).toEqual({
        result: { supported: false, branches: [], defaultBranch: null },
      });
  });

  it('records one remote result and repairs origin/HEAD, then forwards the fresh hint without another write', async () => {
    await seedFreshness(
      repos[REPAIR_WS],
      'release',
      Date.now() - DEFAULT_BRANCH_FRESHNESS_TTL_MS - 60_000,
    );
    git(repos[REPAIR_WS], ['remote', 'set-head', 'origin', 'develop']);
    const record = jest.spyOn(freshnessStore, 'recordGitDefaultBranch');
    const repair = jest.spyOn(gitHelpers, 'setLocalRemoteHeadBranch');
    try {
      const route = routeFor();
      const remote = await list(route);
      expect(remote.defaultBranchSource).toBe('remote');
      expect(remote.defaultBranch).toBe('main');
      expect(record).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
      expect(originHead(repos[REPAIR_WS])).toBe('refs/remotes/origin/main');
      const before = freshnessBytes();
      const hinted = await list(route);
      expect(hinted).toEqual({ ...remote, defaultBranchSource: 'hint' });
      expect(freshnessBytes()).toBe(before);
      expect(record).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
      expect(reads.filter((read) => read.kind === 'remote-head')).toHaveLength(
        1,
      );
      expect(query.mock.calls[1]?.[1].defaultBranchHint?.defaultBranch).toBe(
        'main',
      );
    } finally {
      record.mockRestore();
      repair.mockRestore();
    }
  });

  it('keeps remote freshness attached to the identity observed before dispatch', async () => {
    const repo = repos[REPAIR_WS];
    const originUrl = git(repo, ['remote', 'get-url', 'origin']);
    const identity = {
      commonDir: realpathSync(join(repo, '.git')),
      originUrl,
    };
    query.mockImplementationOnce(() => {
      git(repo, ['remote', 'set-url', 'origin', origins[FRESH_WS]]);
      return Promise.resolve({
        branches: [],
        defaultBranch: 'main',
        defaultBranchSource: 'remote',
      });
    });
    try {
      await list(routeFor());
      expect(
        await freshnessStore.readGitDefaultBranchFreshness({
          ...identity,
          originUrl: origins[FRESH_WS],
        }),
      ).toBeNull();
      expect(
        await freshnessStore.readGitDefaultBranchFreshness(identity),
      ).toMatchObject({
        defaultBranch: 'main',
      });
      expect(neverDirect).not.toHaveBeenCalled();
    } finally {
      git(repo, ['remote', 'set-url', 'origin', originUrl]);
    }
  });

  it.each(['caller', 'deadline'] as const)(
    'drains accepted effects before success even when %s aborts during persistence',
    async (source) => {
      git(repos[REPAIR_WS], ['remote', 'set-head', 'origin', 'develop']);
      query.mockResolvedValueOnce({
        branches: [],
        defaultBranch: 'main',
        defaultBranchSource: 'remote',
      });
      const controller = new AbortController();
      const deadline = new AbortController();
      const timeout = jest
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(deadline.signal);
      const persist = freshnessStore.recordGitDefaultBranch;
      const record = jest
        .spyOn(freshnessStore, 'recordGitDefaultBranch')
        .mockImplementation((input) => {
          (source === 'caller' ? controller : deadline).abort();
          return persist(input);
        });
      try {
        const result = await routeFor().branchList(
          checkout,
          { caller: desktopCaller, signal: controller.signal },
          { sender: routeSender },
          neverDirect,
        );
        expect(result.defaultBranch).toBe('main');
        expect(record).toHaveBeenCalledTimes(1);
        expect(originHead(repos[REPAIR_WS])).toBe('refs/remotes/origin/main');
        expect(neverDirect).not.toHaveBeenCalled();
      } finally {
        record.mockRestore();
        timeout.mockRestore();
      }
    },
  );

  it('forwards only the identity-matched Electron hint, not a supplied hint', async () => {
    const readHint = jest
      .spyOn(defaultBranchHelpers, 'readDefaultBranchHint')
      .mockResolvedValueOnce(null);
    try {
      await list(routeFor(), {
        ...checkout,
        defaultBranchHint: {
          defaultBranch: 'unrelated-repository',
          resolvedAt: new Date().toISOString(),
        },
      });
      expect(query.mock.calls[0]?.[1].defaultBranchHint).toBeUndefined();
    } finally {
      readHint.mockRestore();
    }
  });

  it('normalizes a legacy timestamp without changing hint selection or writing freshness', async () => {
    const resolvedAt = new Date().toUTCString();
    const readHint = jest
      .spyOn(defaultBranchHelpers, 'readDefaultBranchHint')
      .mockResolvedValueOnce({ defaultBranch: 'release', resolvedAt });
    try {
      const before = freshnessBytes();
      const result = await list(routeFor());
      expect(result.defaultBranchSource).toBe('hint');
      expect(result.defaultBranch).toBe('release');
      expect(query.mock.calls[0]?.[1].defaultBranchHint?.resolvedAt).toBe(
        new Date(resolvedAt).toISOString(),
      );
      expect(reads.filter((read) => read.kind === 'remote-head')).toHaveLength(
        0,
      );
      expect(freshnessBytes()).toBe(before);
    } finally {
      readHint.mockRestore();
    }
  });

  it('keeps omitted hints additive, rejects malformed hints, and applies no effects to local or conventional results', async () => {
    for (const [workspaceId, source] of [
      [OFFLINE_WS, 'local-origin-head'],
      [OFFLINE_STALE_WS, 'stale-hint'],
      [OFFLINE_CONVENTIONAL_WS, 'conventional'],
      [NO_ORIGIN_WS, null],
    ] as const) {
      const before = freshnessBytes();
      const head = originHead(repos[workspaceId]);
      const result = await list(routeFor(), {
        scope: { workspaceId, worktreeId: WORKTREE },
        repository: { kind: 'checkout' },
      });
      expect(result.defaultBranchSource).toBe(source);
      expect(freshnessBytes()).toBe(before);
      expect(originHead(repos[workspaceId])).toBe(head);
    }
    expect(WorkerGitBranchListParamsSchema.safeParse(checkout).success).toBe(
      true,
    );
    for (const defaultBranchHint of [
      {},
      { defaultBranch: '', resolvedAt: 'bad' },
      { defaultBranch: 'main', resolvedAt: 'bad' },
    ])
      expect(
        WorkerGitBranchListParamsSchema.safeParse({
          ...checkout,
          defaultBranchHint,
        }).success,
      ).toBe(false);
  });

  it('uses the optional hint up to, but not including, its TTL boundary and rejects future freshness', async () => {
    const now = Date.now();
    const fixed = createWorkerGitBranchListHandlers({
      ...branchHost,
      now: () => now,
    });
    const context = {
      requestId: 'hint-boundary',
      caller: desktopCaller,
      metadata: {},
      signal: new AbortController().signal,
    };
    for (const [age, source] of [
      [0, 'hint'],
      [DEFAULT_BRANCH_FRESHNESS_TTL_MS - 1, 'hint'],
      [DEFAULT_BRANCH_FRESHNESS_TTL_MS, 'remote'],
      [-1, 'remote'],
    ] as const) {
      const result = await fixed['worker.git.branch.list'](
        {
          scope: { workspaceId: FRESH_WS },
          repository: { kind: 'reference' },
          defaultBranchHint: {
            defaultBranch: 'release',
            resolvedAt: new Date(now - age).toISOString(),
          },
        },
        context,
      );
      expect(result.defaultBranchSource).toBe(source);
      expect(result.defaultBranch).toBe(source === 'hint' ? 'release' : 'main');
    }
    const omitted = await fixed['worker.git.branch.list'](
      { scope: { workspaceId: FRESH_WS }, repository: { kind: 'reference' } },
      context,
    );
    expect(omitted.defaultBranchSource).toBe('remote');
    expect(omitted.defaultBranch).toBe('main');
    expect(reads.filter((read) => read.kind === 'remote-head')).toHaveLength(3);
  });

  it('refuses unresolved repositories before daemon contact rather than silently dropping effects', async () => {
    await expect(
      list(routeFor({ repositoryPath: () => Promise.resolve(null) })),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.branch.repositoryUnavailable' },
    });
    expect(hostContext).not.toHaveBeenCalled();
    expect(connections).not.toHaveBeenCalled();
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it.each([
    'unavailable',
    'deadline_exceeded',
    'capability_unavailable',
    'invalid_argument',
  ] as const)('keeps %s typed without fallback', async (kind) => {
    const before = freshnessBytes();
    const head = originHead(repos[REPAIR_WS]);
    query.mockRejectedValueOnce(
      new CanopyClientError({ kind, message: kind, retry: { kind: 'never' } }),
    );
    await expect(list(routeFor())).rejects.toMatchObject({ payload: { kind } });
    expect(freshnessBytes()).toBe(before);
    expect(originHead(repos[REPAIR_WS])).toBe(head);
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it('rejects a schema-skewed result and a host failure without fallback', async () => {
    query.mockResolvedValueOnce(
      Object.assign(
        { branches: [], defaultBranch: null, defaultBranchSource: null },
        { unexpected: true },
      ),
    );
    await expect(list(routeFor())).rejects.toMatchObject({
      payload: { kind: 'internal' },
    });
    await expect(
      list(
        routeFor({
          hostContext: () => Promise.reject(new Error('host failed')),
        }),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it('keeps connection setup failure typed without contacting the query or falling back', async () => {
    await expect(
      list(
        routeFor({
          connections: () => ({
            get: (): Promise<never> =>
              Promise.reject(
                new CanopyClientError({
                  kind: 'unavailable',
                  message: 'connection refused',
                  retry: { kind: 'never' },
                }),
              ),
          }),
        }),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    expect(query).not.toHaveBeenCalled();
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it('accepts an empty listing without writing freshness or origin/HEAD', async () => {
    const empty = {
      branches: [],
      defaultBranch: null,
      defaultBranchSource: null,
    };
    query.mockResolvedValueOnce(empty);
    const before = freshnessBytes();
    const head = originHead(repos[REPAIR_WS]);
    expect(await list(routeFor())).toEqual(empty);
    expect(freshnessBytes()).toBe(before);
    expect(originHead(repos[REPAIR_WS])).toBe(head);
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it('cancels a pre-retired request before host context or connection creation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      routeFor().branchList(
        checkout,
        { caller: desktopCaller, signal: controller.signal },
        { sender: routeSender },
        neverDirect,
      ),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    expect(hostContext).not.toHaveBeenCalled();
    expect(connections).not.toHaveBeenCalled();
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it('bounds a stalled query and never applies late effects or falls back', async () => {
    const deadline = new AbortController();
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(deadline.signal);
    let reply:
      | ((value: {
          branches: [];
          defaultBranch: string;
          defaultBranchSource: 'remote';
        }) => void)
      | undefined;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
          deadline.abort();
        }),
    );
    try {
      await expect(
        list(routeFor({ queryDeadlineMs: 1_000 })),
      ).rejects.toMatchObject({ payload: { kind: 'deadline_exceeded' } });
      expect(timeout).toHaveBeenCalledWith(1_000);
      expect(query).toHaveBeenCalledTimes(1);
      const before = freshnessBytes();
      reply?.({
        branches: [],
        defaultBranch: 'release',
        defaultBranchSource: 'remote',
      });
      await Promise.resolve();
      expect(freshnessBytes()).toBe(before);
      expect(neverDirect).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it('keeps production, Windows, remote bridges, non-window and app-managed requests direct without lazy dependencies', async () => {
    const direct = jest.fn(() =>
      Promise.resolve({
        branches: [],
        defaultBranch: null,
        defaultBranchSource: null,
      }),
    );
    const cases: Array<{
      options?: Partial<DaemonGitRouteOptions>;
      params?: WorkerGitBranchListParams;
      caller?: CanopyCallerDescriptor;
    }> = [
      { options: { selectable: undefined } },
      { options: { platform: 'win32' } },
      { caller: { ...desktopCaller, clientInstanceId: 'remote-bridge:1' } },
      { caller: { ...desktopCaller, interfaceKind: 'portal' } },
      {
        caller: {
          ...desktopCaller,
          clientInstanceId: 'electron-web-contents:2',
        },
      },
      ...[
        APP_ADVISOR_PROJECT_ID,
        CODE_REVIEW_CHAT_PROJECT_ID,
        PLAN_EXPLORE_CHAT_PROJECT_ID,
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
      ].map((workspaceId) => ({
        params: { ...checkout, scope: { ...checkout.scope, workspaceId } },
      })),
      {
        params: {
          ...checkout,
          scope: { ...checkout.scope, authorityId: 'other-authority' },
        },
      },
      {
        params: {
          ...checkout,
          scope: { ...checkout.scope, targetId: 'other-target' },
        },
      },
    ];
    for (const entry of cases)
      await routeFor(entry.options).branchList(
        entry.params ?? checkout,
        { caller: entry.caller ?? desktopCaller },
        { sender: routeSender },
        direct,
      );
    expect(direct).toHaveBeenCalledTimes(cases.length);
    expect(hostContext).not.toHaveBeenCalled();
    expect(connections).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
    // Linux is eligible; a selected query must reach the client.
    await list(routeFor({ platform: 'linux' }));
    expect(query).toHaveBeenCalledTimes(1);
    for (const operation of [
      'git.remote.get',
      'git.worktree.health.get',
      'git.executable.get',
      'git.status.get',
      'git.diff.get',
    ] as const)
      for (const disposition of Object.values(READ_ROUTE_TABLE[operation]))
        expect(disposition.kind).toBe('blocked');
  });

  it('reports connection loss typed, without a direct retry', async () => {
    query.mockImplementationOnce(() => {
      connection.abort();
      return Promise.reject(new Error('closed'));
    });
    await expect(list(routeFor())).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    await expect(list(routeFor())).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(neverDirect).not.toHaveBeenCalled();
  });
});

// CAN-1782: the catalogue is also the Create-new-branch dialog's write input.
// Drive the existing IPC -> desktop dispatcher -> worker.git.branch.create
// route so canonical names cannot silently change the selected history.
describe('exact Git identity through branch entry points', () => {
  it.each([
    { scenario: 'local origin/name collision', name: 'exact-table-collision' },
    { scenario: 'whitespace variant', name: 'exact-table-whitespace ' },
  ])('preserves the selected commit with a $scenario', async ({ name }) => {
    await runtime?.shutdown();
    registerHandlers();
    const repo = repos[FRESH_WS];
    const checkout = worktreeDir(FRESH_WS, WORKTREE);
    const before = git(checkout, ['rev-parse', 'HEAD']);
    const selected = git(checkout, [
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      before,
      '-m',
      'Selected exact ref',
    ]);
    const remote = `refs/remotes/origin/${name}`;
    const local = `origin/${name}`;
    const originalDefault = originHead(repo);
    git(repo, ['update-ref', remote, selected]);
    git(repo, ['update-ref', `refs/heads/${local}`, before]);
    if (name.endsWith(' ')) {
      const plain = name.slice(0, -1);
      git(repo, ['update-ref', `refs/heads/${plain}`, before]);
      git(repo, ['update-ref', `refs/remotes/origin/${plain}`, before]);
    }
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', remote]);
    await seedFreshness(repo, name, Date.now());
    const scope = { projectId: FRESH_WS, worktreeId: WORKTREE };
    const createWorktree = (base: {
      baseBranch?: string;
      existingBranch?: string;
    }): ReturnType<typeof createSingleRepoWorktree> =>
      createSingleRepoWorktree({
        workspaceId: FRESH_WS,
        allowBaseBranchNetwork: false,
        ...base,
      });
    const createBranch = (
      baseBranch: string,
      isRemote: boolean,
    ): Promise<unknown> =>
      branchPeerIpc(IPC_CHANNELS.worktreeCreateBranch, {
        ...scope,
        newBranchName: `selected-${name}-${isRemote ? 'remote' : 'local'}`,
        baseBranch,
        baseBranchIsRemote: isRemote,
        baseBranchSource: 'catalog',
      });
    // The IPC projection runs the worker.git.checkout operation.
    const switchBranch = (
      branchName: string,
      isRemote: boolean,
    ): Promise<unknown> =>
      branchPeerIpc(IPC_CHANNELS.worktreeSwitchBranch, {
        ...scope,
        branchName,
        isRemote,
      });

    try {
      // Home takes the actual Git default and captures its namespace.
      const home = await branchPeerIpc(IPC_CHANNELS.homeListBranchTargets, {
        workspaceId: FRESH_WS,
      });
      expect(home).toMatchObject({ supported: true, defaultBranch: name });
      const homeTarget = defaultNewWorktreeBaseTarget({
        supported: true,
        defaultBranch: name,
        branches: WorkerGitBranchSchema.array().parse(
          Reflect.get(Object(home), 'branches'),
        ),
        headUnborn: false,
      });
      expect(homeTarget).toMatchObject({ branchName: name, ref: remote });
      const homeOptions = createOptionsForNewWorktreeBaseTarget(homeTarget);
      expect(homeOptions?.baseBranch).toBe(`remote:${name}`);

      const portalBase = baseBranchRef({
        kind: 'branch',
        branchName: name,
        isRemote: true,
      });
      expect(decodeWorktreeBaseBranch(portalBase)).toEqual({
        branchName: name,
        isRemote: true,
      });
      const entries = [
        { entry: 'Home default', base: homeOptions, tip: selected },
        {
          entry: 'Portal and scheduled explicit base',
          base: { baseBranch: portalBase },
          tip: selected,
        },
        {
          entry: 'existing remote worktree checkout',
          base: { existingBranch: name },
          tip: selected,
        },
        {
          entry: 'explicit local base',
          base: { baseBranch: `local:${local}` },
          tip: before,
        },
        {
          entry: 'existing local worktree checkout',
          base: { existingBranch: local },
          tip: before,
        },
        {
          entry: 'legacy remote base',
          base: { baseBranch: `origin/${name}` },
          tip: selected,
        },
      ];
      for (const { entry, base, tip } of entries) {
        const worktree = await createWorktree(base ?? {});
        const path = worktreeDir(FRESH_WS, worktree.id);
        expect({ entry, tip: git(path, ['rev-parse', 'HEAD']) }).toEqual({
          entry,
          tip,
        });
        if (base && 'existingBranch' in base) {
          await gitHelpers.removeWorktree(repo, path);
          if (base.existingBranch === name)
            git(repo, ['update-ref', '-d', `refs/heads/${name}`]);
        }
      }

      await createBranch(name, true);
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(selected);
      expect(await gitHelpers.getMergeBaseForBranch(checkout, name)).toBe(
        selected,
      );
      expect(await gitHelpers.getMergeBaseForBranch(checkout, local)).toBe(
        before,
      );
      await createBranch(local, false);
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(before);
      await switchBranch(local, false);
      expect(await gitHelpers.getCurrentBranch(checkout)).toBe(local);
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(before);
      await switchBranch(name, true);
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(selected);
      expect(await gitHelpers.getCurrentBranch(checkout)).toBe(name);
    } finally {
      git(checkout, ['switch', '--no-guess', '--', WORKTREE]);
      await refreshWorktreeDiffStats(FRESH_WS, WORKTREE);
      if (originalDefault !== '(unset)')
        git(repo, [
          'symbolic-ref',
          'refs/remotes/origin/HEAD',
          originalDefault,
        ]);
      await seedFreshness(repo, 'develop', Date.now());
    }
  });
});

describe('CAN-1782 catalogue selections round-trip through branch creation', () => {
  it.each([
    ['switch', false],
    ['switch', true],
    ['create', false],
    ['create', true],
  ] as const)(
    'lets Git guard a %s with late edits=%s',
    async (action, lateEdits) => {
      const checkout = mkdtempSync(join(tmpdir(), 'canopy-native-switch-'));
      try {
        git(checkout, ['init', '-q', '-b', 'initial']);
        git(checkout, ['config', 'user.name', 'Fixture']);
        git(checkout, ['config', 'user.email', 'fixture@example.com']);
        const file = join(checkout, 'guard.txt');
        writeFileSync(file, 'before');
        git(checkout, ['add', '.']);
        git(checkout, ['commit', '-qm', 'initial']);
        git(checkout, ['switch', '-qc', 'source']);
        writeFileSync(file, 'source');
        git(checkout, ['commit', '-qam', 'source']);
        git(checkout, ['switch', '-q', 'initial']);
        const realPort = gitHelpers.gitBranchWritePort(checkout);
        const port = {
          ...realPort,
          // A stale UI observation must never be used as a switch guard.
          currentBranch: (): Promise<string> =>
            Promise.reject(new Error('Unexpected precondition read')),
          checkout: async (branch: string): Promise<void> => {
            if (lateEdits) writeFileSync(file, 'keep my concurrent edit');
            await realPort.checkout(branch);
          },
        };
        const result =
          action === 'create'
            ? createGitBranch(port, 'created', 'source', {
                expectedBranch: 'stale-ui-head',
                baseBranch: { branch: 'source', remote: false },
              })
            : checkoutGitBranch(port, 'source', {
                expectedBranch: 'stale-ui-head',
                remote: false,
              });
        if (lateEdits) {
          await expect(result).rejects.toThrow();
          expect(git(checkout, ['symbolic-ref', 'HEAD'])).toBe(
            'refs/heads/initial',
          );
          expect(readFileSync(file, 'utf8')).toBe('keep my concurrent edit');
          if (action === 'create')
            expect(
              git(checkout, ['show-ref', '--verify', 'refs/heads/created']),
            ).toContain('refs/heads/created');
        } else {
          await result;
          expect(git(checkout, ['symbolic-ref', 'HEAD'])).toBe(
            `refs/heads/${action === 'create' ? 'created' : 'source'}`,
          );
          expect(readFileSync(file, 'utf8')).toBe('source');
        }
      } finally {
        rmSync(checkout, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    'reports a %s-remote source move and preserves the original checkout',
    async (remote) => {
      await runtime?.shutdown();
      registerHandlers();
      const checkout = worktreeDir(FRESH_WS, WORKTREE);
      const source = remote ? 'catalog-moving-remote' : 'catalog-moving-local';
      const ref = remote
        ? `refs/remotes/origin/${source}`
        : `refs/heads/${source}`;
      const oldTip = git(checkout, ['rev-parse', 'HEAD']);
      git(checkout, ['commit', '-q', '--allow-empty', '-m', source]);
      const selectedTip = git(checkout, ['rev-parse', 'HEAD']);
      git(checkout, ['update-ref', ref, selectedTip]);
      const realPort = gitHelpers.gitBranchWritePort;
      const spy = jest
        .spyOn(gitHelpers, 'gitBranchWritePort')
        .mockImplementation((path) => {
          const port = realPort(path);
          return {
            ...port,
            createBranch: (name, startPoint): Promise<void> => {
              git(path, ['update-ref', ref, oldTip]);
              return port.createBranch(name, startPoint);
            },
          };
        });
      try {
        const createdName = `${source}-created`;
        expect(
          await ipc(IPC_CHANNELS.worktreeCreateBranch, {
            projectId: FRESH_WS,
            worktreeId: WORKTREE,
            newBranchName: createdName,
            baseBranch: source,
            baseBranchIsRemote: remote,
            baseBranchSource: 'catalog',
          }),
        ).toHaveProperty(
          'result.failureMessage',
          expect.stringContaining('Branch tip changed during setup.'),
        );
        expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(selectedTip);
        expect(git(checkout, ['rev-parse', `refs/heads/${createdName}`])).toBe(
          oldTip,
        );
        if (remote) {
          expect(
            git(checkout, ['config', `branch.${createdName}.remote`]),
          ).toBe('origin');
          expect(git(checkout, ['config', `branch.${createdName}.merge`])).toBe(
            `refs/heads/${source}`,
          );
        }
      } finally {
        spy.mockRestore();
        await refreshWorktreeDiffStats(FRESH_WS, WORKTREE);
        git(checkout, ['checkout', '-q', WORKTREE]);
      }
    },
  );

  it.each([false, true])(
    'creates from the exact selected %s-remote base with tag collisions',
    async (remote) => {
      await runtime?.shutdown();
      registerHandlers();
      const checkout = worktreeDir(FRESH_WS, WORKTREE);
      const name = remote ? 'catalog-create-remote' : 'catalog-create-local';
      const before = git(checkout, ['rev-parse', 'HEAD']);
      git(checkout, ['commit', '-q', '--allow-empty', '-m', name]);
      const selectedHead = git(checkout, ['rev-parse', 'HEAD']);
      const fullRef = remote
        ? `refs/remotes/origin/${name}`
        : `refs/heads/${name}`;
      git(checkout, ['update-ref', fullRef, selectedHead]);
      git(checkout, ['tag', remote ? `origin/${name}` : name, before]);
      git(checkout, ['tag', fullRef, before]);
      if (remote) git(checkout, ['branch', `origin/${name}`, before]);
      const request = { projectId: FRESH_WS, worktreeId: WORKTREE };
      const listed = await ipc(IPC_CHANNELS.worktreeListBranches, request);
      if (!('result' in listed)) throw new Error('Branch listing failed');
      const branches = WorkerGitBranchSchema.array().parse(
        Reflect.get(Object(listed.result), 'branches'),
      );
      const selected = branches.find((branch) => branch.name === name);
      if (!selected) throw new Error('Selected branch missing from catalogue');
      expect(selected.isRemote).toBe(remote);
      const createdName = `${name}-created`;
      expect(
        await ipc(IPC_CHANNELS.worktreeCreateBranch, {
          ...request,
          newBranchName: createdName,
          baseBranch: selected.name,
          baseBranchIsRemote: selected.isRemote,
          baseBranchSource: 'catalog',
        }),
      ).toEqual({ result: { success: true, branchName: createdName } });
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(selectedHead);
      if (remote) {
        expect(git(checkout, ['config', `branch.${createdName}.remote`])).toBe(
          'origin',
        );
        expect(git(checkout, ['config', `branch.${createdName}.merge`])).toBe(
          `refs/heads/${name}`,
        );
      }
      await refreshWorktreeDiffStats(FRESH_WS, WORKTREE);
      git(checkout, ['checkout', '-q', WORKTREE]);
    },
  );

  it('round-trips two distinct branch names that differ by trailing Unicode whitespace', async () => {
    await runtime?.shutdown();
    registerHandlers();
    const checkout = worktreeDir(FRESH_WS, WORKTREE);
    const name = 'catalog-whitespace';
    const exactName = `${name}\u00a0`;
    const original = git(checkout, ['rev-parse', 'HEAD']);
    git(checkout, ['branch', name, original]);
    git(checkout, ['commit', '-q', '--allow-empty', '-m', 'Exact ref']);
    const exactTip = git(checkout, ['rev-parse', 'HEAD']);
    git(checkout, ['branch', exactName, exactTip]);
    const request = { projectId: FRESH_WS, worktreeId: WORKTREE };
    try {
      const listed = await ipc(IPC_CHANNELS.worktreeListBranches, request);
      if (!('result' in listed)) throw new Error('Branch listing failed');
      const branches = WorkerGitBranchSchema.array().parse(
        Reflect.get(Object(listed.result), 'branches'),
      );
      expect(branches.map((branch) => branch.name)).toEqual(
        expect.arrayContaining([name, exactName]),
      );
      const create = {
        ...request,
        baseBranch: exactName,
        baseBranchIsRemote: false,
        baseBranchSource: 'catalog',
      };
      expect(
        await ipc(IPC_CHANNELS.worktreeCreateBranch, {
          ...create,
          newBranchName: 'invalid-name ',
        }),
      ).toHaveProperty(
        'error.message',
        expect.stringContaining('Invalid branch name'),
      );
      expect(
        await ipc(IPC_CHANNELS.worktreeCreateBranch, {
          ...create,
          newBranchName: 'catalog-whitespace-created',
        }),
      ).toEqual({
        result: { success: true, branchName: 'catalog-whitespace-created' },
      });
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(exactTip);
    } finally {
      git(checkout, ['checkout', '-q', WORKTREE]);
      await refreshWorktreeDiffStats(FRESH_WS, WORKTREE);
    }
  });

  it('pins the selected commit when a branch has the same name as its object ID', async () => {
    await runtime?.shutdown();
    registerHandlers();
    const checkout = worktreeDir(FRESH_WS, WORKTREE);
    const before = git(checkout, ['rev-parse', 'HEAD']);
    git(checkout, ['commit', '-q', '--allow-empty', '-m', 'Selected tip']);
    const tip = git(checkout, ['rev-parse', 'HEAD']);
    git(checkout, ['update-ref', 'refs/heads/catalog-oid-source', tip]);
    git(checkout, ['update-ref', `refs/heads/${tip}`, before]);

    expect(
      await ipc(IPC_CHANNELS.worktreeCreateBranch, {
        projectId: FRESH_WS,
        worktreeId: WORKTREE,
        newBranchName: 'catalog-oid-created',
        baseBranch: 'catalog-oid-source',
        baseBranchIsRemote: false,
        baseBranchSource: 'catalog',
      }),
    ).toEqual({ result: { success: true, branchName: 'catalog-oid-created' } });
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(tip);
    await refreshWorktreeDiffStats(FRESH_WS, WORKTREE);
    git(checkout, ['checkout', '-q', WORKTREE]);
  });

  it.each([true, false])(
    'reports the completed checkout after a hook fails with tracking %s',
    async (track) => {
      await runtime?.shutdown();
      registerHandlers();
      const checkout = worktreeDir(FRESH_WS, WORKTREE);
      const source = 'catalog-hook-source';
      const target = `catalog-hook-created-${track}`;
      const hooks = mkdtempSync(join(tmpdir(), 'canopy-checkout-hooks-'));
      const hook = join(hooks, 'post-checkout');
      const config = ['config', '--local', 'core.hooksPath'];
      git(checkout, ['update-ref', `refs/remotes/origin/${source}`, 'HEAD']);
      writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      try {
        git(checkout, [...config, hooks]);
        git(checkout, [
          'config',
          '--local',
          'branch.autoSetupMerge',
          String(track),
        ]);
        // A same-named tag makes short HEAD spellings ambiguous.
        git(checkout, ['tag', target, 'HEAD']);
        const result = await ipc(IPC_CHANNELS.worktreeCreateBranch, {
          projectId: FRESH_WS,
          worktreeId: WORKTREE,
          newBranchName: target,
          baseBranch: source,
          baseBranchIsRemote: true,
          baseBranchSource: 'catalog',
        });
        expect(git(checkout, ['symbolic-ref', 'HEAD'])).toBe(
          `refs/heads/${target}`,
        );
        const tracking = git(checkout, ['config', '--list']);
        if (track) {
          expect(tracking).toContain(`branch.${target}.remote=origin`);
          expect(tracking).toContain(
            `branch.${target}.merge=refs/heads/${source}`,
          );
        } else {
          expect(tracking).not.toContain(`branch.${target}.remote=`);
          expect(tracking).not.toContain(`branch.${target}.merge=`);
        }
        expect(result).toEqual({
          result: {
            success: true,
            branchName: target,
            warning: {
              code: 'checkout-command-failed',
              upstream: track ? 'configured' : 'unset',
            },
          },
        });
      } finally {
        git(checkout, [...config.slice(0, 2), '--unset', 'core.hooksPath']);
        git(checkout, [
          'config',
          '--local',
          '--unset',
          'branch.autoSetupMerge',
        ]);
        await refreshWorktreeDiffStats(FRESH_WS, WORKTREE);
        git(checkout, ['checkout', '-q', WORKTREE]);
        git(checkout, ['tag', '-d', target]);
        rmSync(hooks, { recursive: true, force: true });
      }
    },
  );

  it('lets Git refuse inherited multiple upstreams with rebase enabled', async () => {
    await runtime?.shutdown();
    registerHandlers();
    const checkout = worktreeDir(FRESH_WS, WORKTREE);
    const head = git(checkout, ['symbolic-ref', 'HEAD']);
    const source = 'catalog-inherited-multiple';
    const target = 'catalog-inherited-created';
    git(checkout, ['branch', source, 'HEAD']);
    git(checkout, ['config', 'branch.autoSetupMerge', 'inherit']);
    git(checkout, ['config', 'branch.autoSetupRebase', 'always']);
    git(checkout, ['config', `branch.${source}.remote`, 'origin']);
    for (const merge of ['refs/heads/main', 'refs/heads/other']) {
      git(checkout, ['config', '--add', `branch.${source}.merge`, merge]);
    }
    try {
      const result = await ipc(IPC_CHANNELS.worktreeCreateBranch, {
        projectId: FRESH_WS,
        worktreeId: WORKTREE,
        newBranchName: target,
        baseBranch: source,
        baseBranchIsRemote: false,
        baseBranchSource: 'catalog',
      });
      expect(result).toHaveProperty('result.success', false);
      expect(result).toHaveProperty(
        'result.failureMessage',
        expect.stringContaining('Upstream is unset.'),
      );
      expect(git(checkout, ['symbolic-ref', 'HEAD'])).toBe(head);
      expect(git(checkout, ['config', '--list'])).not.toContain(
        `branch.${target}.rebase=`,
      );
    } finally {
      git(checkout, ['config', '--unset', 'branch.autoSetupMerge']);
      git(checkout, ['config', '--unset', 'branch.autoSetupRebase']);
      git(checkout, ['config', '--remove-section', `branch.${source}`]);
    }
  });

  it('reports the prepared branch when tracking could not be written', async () => {
    await runtime?.shutdown();
    registerHandlers();
    const checkout = worktreeDir(FRESH_WS, WORKTREE);
    const before = git(checkout, ['symbolic-ref', 'HEAD']);
    git(checkout, [
      'update-ref',
      'refs/remotes/origin/catalog-locked-source',
      'HEAD',
    ]);
    const gitDir = git(checkout, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const lock = join(gitDir, 'config.lock');
    const request = {
      projectId: FRESH_WS,
      worktreeId: WORKTREE,
      newBranchName: 'catalog-locked-created',
      baseBranch: 'catalog-locked-source',
      baseBranchIsRemote: true,
      baseBranchSource: 'catalog',
    };

    writeFileSync(lock, '');
    try {
      const result = await ipc(IPC_CHANNELS.worktreeCreateBranch, request);
      expect(result).toHaveProperty('result.success', false);
      expect(result).toHaveProperty('result.branchName', request.newBranchName);
      expect(result).toHaveProperty('result.branchExists', true);
      expect(result).toHaveProperty(
        'result.failureMessage',
        expect.stringContaining('Branch exists.'),
      );
      expect(result).toHaveProperty(
        'result.failureMessage',
        expect.stringContaining('Upstream is unset.'),
      );
      expect(git(checkout, ['symbolic-ref', 'HEAD'])).toBe(before);
      expect(
        git(checkout, [
          'for-each-ref',
          '--format=%(refname)',
          'refs/heads/catalog-locked-created',
        ]),
      ).toBe('refs/heads/catalog-locked-created');
    } finally {
      rmSync(lock);
    }
    git(checkout, ['branch', '-d', request.newBranchName]);
    expect(await ipc(IPC_CHANNELS.worktreeCreateBranch, request)).toEqual({
      result: { success: true, branchName: 'catalog-locked-created' },
    });
    await refreshWorktreeDiffStats(FRESH_WS, WORKTREE);
    git(checkout, ['checkout', '-q', WORKTREE]);
  });

  it.each(['tag', 'commit', 'origin'])(
    'creates from a non-catalogue %s start point through the same worker',
    async (kind) => {
      await runtime?.shutdown();
      registerHandlers();
      const checkout = worktreeDir(FRESH_WS, WORKTREE);
      const head = git(checkout, ['rev-parse', 'HEAD']);
      const name = `revision-create-${kind}`;
      git(checkout, ['tag', name, head]);
      git(checkout, ['update-ref', `refs/remotes/origin/${name}`, head]);
      commit(checkout, `${name}.txt`);
      const base =
        kind === 'tag' ? name : kind === 'commit' ? head : `origin/${name}`;
      expect(
        await ipc(IPC_CHANNELS.worktreeCreateBranch, {
          projectId: FRESH_WS,
          worktreeId: WORKTREE,
          newBranchName: `${name}-created`,
          baseBranch: base,
          baseBranchIsRemote: false,
        }),
      ).toEqual({ result: { success: true, branchName: `${name}-created` } });
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
      await refreshWorktreeDiffStats(FRESH_WS, WORKTREE);
      git(checkout, ['checkout', '-q', WORKTREE]);
    },
  );
});

const PEER_VERSION = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '2.0.0',
};
const OLD_PEER_VERSION = { ...PEER_VERSION, appVersion: '1.0.0' };
const PEER_HELLO = { name: 'Host', platform: 'darwin' as const };
const noop = (): void => undefined;

async function withBranchPeers(
  controllerCurrent: boolean,
  hostCurrent: boolean,
  invokeOnHost: (channel: string, request: unknown) => Promise<unknown>,
  run: (invoke: typeof invokeOnHost, negotiated: boolean) => Promise<void>,
): Promise<void> {
  const hub = new InMemoryRelayHub();
  const controllerDevice = createTestDevice(hub, 'Controller');
  const hostDevice = createTestDevice(hub, 'Host');
  const { initiator, responder } = await openControlSession(
    controllerDevice,
    hostDevice,
  );
  // Only the Electron bridge is replaced. The session passes its negotiated
  // catalogue mode to that bridge, which supplies it at the real IPC handler.
  const catalogue = jest.spyOn(hostBridge, 'usesExactWorktreeBaseCatalogue');
  catalogue.mockReturnValue(false);
  const host = hostCurrent
    ? new RemoteHostSession({
        session: responder,
        kind: 'desktop',
        attributedDeviceId: 'branch-list-golden-device',
        createBridge: (_surface, exact): Promise<hostBridge.HostBridge> => {
          catalogue.mockReturnValue(exact);
          return Promise.resolve({
            window: null,
            getChatInterest: (): undefined => undefined,
            invoke: (channel, [request]) => invokeOnHost(channel, request),
            post: noop,
            onPush: () => noop,
            onClosed: () => noop,
            destroy: noop,
          });
        },
        mainWindowPushes: { subscribe: (): (() => void) => noop },
        uploads: new RemoteUploadStore(join(dir, 'peer-uploads')),
        readFile: (): Promise<never> =>
          Promise.reject(new Error('Unexpected file read')),
        disposition: (): 'tunnel' => 'tunnel',
        isAuthorized: (): boolean => true,
        version: PEER_VERSION,
        hello: (): typeof PEER_HELLO => PEER_HELLO,
        onClose: noop,
      }).rpc
    : new RpcPeer(responder, {
        onRequest: async (method, params): Promise<unknown> => {
          if (method === REMOTE_METHODS.hello)
            return {
              ...PEER_HELLO,
              version: OLD_PEER_VERSION,
              appVersion: OLD_PEER_VERSION.appVersion,
            };
          if (method !== REMOTE_METHODS.invoke)
            throw new Error('Unexpected request');
          const {
            channel,
            args: [request],
          } = InvokeParamsSchema.parse(params);
          return invokeOnHost(channel, request);
        },
        onEvent: noop,
      });
  const unexpected = (): Promise<never> =>
    Promise.reject(new Error('Unexpected host request'));
  const modern = controllerCurrent
    ? new RemoteHostConnection({
        version: PEER_VERSION,
        connect: (): Promise<SecureSession> => Promise.resolve(initiator),
        onPush: noop,
        onDialogOpen: unexpected,
        onAppAdvisorWindow: unexpected,
        onStatusChange: noop,
        onReconnected: noop,
      })
    : null;
  const legacy = controllerCurrent
    ? null
    : new RpcPeer(initiator, {
        onRequest: unexpected,
        onEvent: noop,
      });
  try {
    if (modern) {
      await modern.ensure();
      await run(
        (channel, request) => modern.invoke(channel, [request]),
        modern.hostInfo?.features?.exactWorktreeBaseBranch === true,
      );
    } else if (legacy) {
      const hello = HelloResultSchema.parse(
        await legacy.request(REMOTE_METHODS.hello, {
          version: OLD_PEER_VERSION,
        }),
      );
      await run(
        (channel, request) =>
          legacy.request(REMOTE_METHODS.invoke, { channel, args: [request] }),
        hello.features?.exactWorktreeBaseBranch === true,
      );
    }
  } finally {
    modern?.release();
    legacy?.close('closed');
    host.close('closed');
    catalogue.mockRestore();
    for (const device of [controllerDevice, hostDevice]) {
      device.manager.dispose();
      device.endpoint.stop();
    }
  }
}

async function branchPeerIpc(
  channel: string,
  request: unknown,
): Promise<unknown> {
  const outcome = await ipc(channel, request);
  if ('error' in outcome) throw new Error(String(outcome.error.message));
  return outcome.result;
}

describe('exact worktree bases negotiated by desktop peers', () => {
  it.each([
    { controller: 'new', host: 'new' },
    { controller: 'new', host: 'old' },
    { controller: 'old', host: 'new' },
  ])(
    'serves the correct catalogue and create contract to a $controller controller and $host host',
    async ({ controller, host }) => {
      await runtime?.shutdown();
      registerHandlers();
      const exact = controller === 'new' && host === 'new';
      const checkout = worktreeDir(FRESH_WS, WORKTREE);
      const repo = repos[FRESH_WS];
      const main = git(repo, ['rev-parse', 'refs/heads/main']);
      const local = git(repo, [
        'commit-tree',
        'main^{tree}',
        '-m',
        'Local collision',
      ]);
      git(repo, ['update-ref', 'refs/heads/origin/release', local]);
      git(repo, ['tag', 'release', local]);
      const scope = { projectId: FRESH_WS, worktreeId: WORKTREE };
      const home = { workspaceId: FRESH_WS };
      const received: [string, unknown][] = [];
      try {
        const legacyCatalogue = jest
          .spyOn(hostBridge, 'usesExactWorktreeBaseCatalogue')
          .mockReturnValue(false);
        const baselineHome = await branchPeerIpc(
          IPC_CHANNELS.homeListBranchTargets,
          home,
        );
        const baselineInfo = await branchPeerIpc(
          IPC_CHANNELS.worktreeListBranches,
          scope,
        );
        legacyCatalogue.mockRestore();
        await withBranchPeers(
          controller === 'new',
          host === 'new',
          async (channel, request) => {
            received.push([channel, request]);
            if (channel === IPC_CHANNELS.automationsUpdate) return { ok: true };
            return branchPeerIpc(channel, request);
          },
          async (invoke, negotiated) => {
            expect(negotiated).toBe(exact);
            const homeList = await invoke(
              IPC_CHANNELS.homeListBranchTargets,
              home,
            );
            const infoList = await invoke(
              IPC_CHANNELS.worktreeListBranches,
              scope,
            );
            if (exact) {
              for (const result of [homeList, infoList]) {
                if (
                  !result ||
                  typeof result !== 'object' ||
                  !('branches' in result)
                )
                  throw new Error('Missing branch catalogue');
                expect(result).toHaveProperty('exactWorktreeBaseBranch', true);
                const branches = WorkerGitBranchSchema.array().parse(
                  result.branches,
                );
                expect(
                  branches.find((branch) => branch.name === 'origin/release')
                    ?.hasLocalRef,
                ).toBe(true);
                expect(
                  branches.find((branch) => branch.name === 'release')
                    ?.hasRemoteRef,
                ).toBe(true);
              }
              const created = 'negotiated-remote-base';
              await expect(
                invoke(IPC_CHANNELS.worktreeCreateBranch, {
                  ...scope,
                  newBranchName: created,
                  baseBranch: 'release',
                  baseBranchIsRemote: true,
                  baseBranchSource: 'catalog',
                }),
              ).resolves.toMatchObject({ success: true, branchName: created });
              expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(main);
            } else {
              expect(homeList).toEqual(baselineHome);
              expect(infoList).toEqual(baselineInfo);
              const edit = {
                id: 'legacy-schedule',
                action: {
                  type: 'worktree_prompt',
                  workspaceId: FRESH_WS,
                  prompt: 'Later',
                  baseBranch: 'origin/release',
                },
              };
              await expect(
                invoke(IPC_CHANNELS.automationsUpdate, edit),
              ).resolves.toEqual({ ok: true });
              expect(received.at(-1)).toEqual([
                IPC_CHANNELS.automationsUpdate,
                edit,
              ]);
              await expect(
                invoke(IPC_CHANNELS.automationsUpdate, {
                  ...edit,
                  action: { ...edit.action, baseBranch: 'remote:release' },
                }),
              ).rejects.toThrow('Update both desktops');
              expect(received.at(-1)).toEqual([
                IPC_CHANNELS.automationsUpdate,
                edit,
              ]);
            }
          },
        );
      } finally {
        await refreshWorktreeDiffStats(FRESH_WS, WORKTREE);
        git(checkout, ['checkout', '-q', WORKTREE]);
        git(repo, ['tag', '-d', 'release']);
        git(repo, ['update-ref', '-d', 'refs/heads/origin/release']);
      }
    },
  );

  it('executes the remote base saved by a current controller after reloading the schedule', async () => {
    const service = new AutomationsService();
    const repo = repos[FRESH_WS];
    const local = git(repo, [
      'commit-tree',
      'main^{tree}',
      '-m',
      'Different local release',
    ]);
    const remote = git(repo, ['rev-parse', 'refs/remotes/origin/release']);
    expect(local).not.toBe(remote);
    git(repo, ['update-ref', 'refs/heads/release', local]);
    const send = jest
      .spyOn(chatService, 'sendWorktreeChatMessage')
      .mockResolvedValue({
        ok: true,
        chatId: 'scheduled-chat',
      });
    const request: AutomationCreateRequest = {
      name: 'Remote base scheduled task',
      enabled: false,
      schedule: {
        kind: 'one_time',
        runAt: '2090-01-01T10:00:00.000Z',
        timezone: 'local',
      },
      action: {
        type: 'worktree_prompt',
        purpose: 'scheduled_task',
        workspaceId: FRESH_WS,
        prompt: 'Run on release',
        model: 'gpt-5.4',
        baseBranch: 'remote:release',
      },
    };
    try {
      await withBranchPeers(
        true,
        true,
        async (channel, payload) => {
          expect(channel).toBe(IPC_CHANNELS.automationsCreate);
          expect(payload).toEqual(request);
          return service.create(request);
        },
        async (invoke, negotiated) => {
          expect(negotiated).toBe(true);
          await expect(
            invoke(IPC_CHANNELS.automationsCreate, request),
          ).resolves.toMatchObject({ ok: true });
        },
      );
      expect(readFileSync(getAutomationsFilePath(), 'utf8')).toContain(
        '"baseBranch": "remote:release"',
      );
      writeJson(join(workspaceDir(FRESH_WS), 'approvals.json'), {
        version: 1,
        rules: [],
      });
      const runner = new AutomationsService();
      runner.configure({
        getMainWindow: () => null,
        ensureAppAdvisorWindow: () =>
          Promise.reject(new Error('Unexpected window')),
        sendAppAdvisorWindowCommand: noop,
      });
      const { activities } = await runner.list();
      const activity = activities.find((item) => item.name === request.name);
      if (!activity) throw new Error('Saved activity missing');
      const result = await runner.runNow({ id: activity.id });
      if (!result.ok || result.run?.status !== 'success')
        throw new Error(JSON.stringify(result));
      expect(result.run.status).toBe('success');
      expect(send).toHaveBeenCalledTimes(1);
      const worktreeId = send.mock.calls[0]?.[0].worktreeId;
      if (!worktreeId) throw new Error('Scheduled worktree missing');
      expect(
        git(worktreeDir(FRESH_WS, worktreeId), ['rev-parse', 'HEAD']),
      ).toBe(remote);
    } finally {
      send.mockRestore();
      stopPolling();
      await settleDetachedWork();
      git(repo, ['update-ref', '-d', 'refs/heads/release']);
    }
  });
});
