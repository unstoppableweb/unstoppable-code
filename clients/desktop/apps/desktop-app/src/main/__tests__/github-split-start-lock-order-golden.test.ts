/** CAN-4730 E2-G: Split PR start takes its lock only once the key resolves, synchronously with the Git action check, and refuses before any side effect. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS, type WorkspaceType } from '@canopy/desktop-shared/types';
import {
  isSplitLocked,
  onSplitLockChange,
  releaseSplitLock,
  setSplitLockKeyResolver,
  SplitLockError,
  SplitStartBlockedError,
} from '../services/split-lock-service';
import { beginExclusiveGitAction } from '../services/git-action-exclusion';
import { finishGitActionCancellationScope } from '../ipc/git-action-cancellation';

/** Every side effect the start makes, in order. */
const mockEvents: string[] = [];
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
jest.mock('../services/split-pr-runtime-projection', () => ({
  ...jest.requireActual<object>('../services/split-pr-runtime-projection'),
  setSplitPrRuntimeProjection: jest.fn(() => {
    mockEvents.push('projection');
  }),
  clearSplitPrRuntimeProjection: jest.fn(() => {
    mockEvents.push('clear-projection');
  }),
}));
jest.mock('../terminal/worker-terminal', () => ({
  workerTerminal: {
    killWorktree: jest.fn(() => {
      mockEvents.push('kill-terminals');
    }),
  },
}));
jest.mock('../lib/hook-runner', () => ({
  ...jest.requireActual<object>('../lib/hook-runner'),
  stopHooksForWorktree: jest.fn(() => {
    mockEvents.push('stop-hooks');
    return Promise.resolve();
  }),
}));
jest.mock('../services/scripts-service', () => ({
  ...jest.requireActual<object>('../services/scripts-service'),
  stopWorktreeScripts: jest.fn(() => {
    mockEvents.push('stop-scripts');
    return Promise.resolve();
  }),
}));

import { registerGitHubHandlers } from '../ipc/github';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

const PROJECT = 'split-order-ws';
const WORKTREE = 'wt-1';
const TARGET = { projectId: PROJECT, worktreeId: WORKTREE };
const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

let dir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;
let restoreResolver: () => void = () => undefined;
let pendingKeys: Array<() => void> = [];
let stopListening: () => void = () => undefined;

/** Keys resolve only when the test releases them. */
function installDeferredKeys(): void {
  const key = (workspaceId: string, worktreeId: string): string =>
    `split-order:${workspaceId}\0${worktreeId}`;
  restoreResolver = setSplitLockKeyResolver({
    key: (workspaceId, worktreeId) =>
      new Promise((resolve, reject) => {
        pendingKeys.push(() => {
          if (worktreeId === 'unknown') reject(new Error('no such worktree'));
          else resolve(key(workspaceId, worktreeId));
        });
      }),
    keySync: key,
  });
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function resolveKeys(): void {
  const resolvers = pendingKeys;
  pendingKeys = [];
  for (const resolve of resolvers) resolve();
}

function start(worktreeId = WORKTREE): Promise<unknown> {
  const handler = mockHandlers.get(IPC_CHANNELS.githubSplitWorkflowStart);
  if (!handler) throw new Error('split start handler missing');
  return handler({}, { projectId: PROJECT, worktreeId, mode: 'review' });
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'split-order-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  registerWorkspaceTypes(
    new Map<string, WorkspaceType>([[PROJECT, 'single-repo']]),
  );
  runtime = createDesktopRuntime();
  registerGitHubHandlers(
    () =>
      ({
        isDestroyed: () => false,
        webContents: {
          send: (): void => undefined,
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
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  mockEvents.length = 0;
  pendingKeys = [];
  installDeferredKeys();
  stopListening = onSplitLockChange((event) =>
    mockEvents.push(event.locked ? 'locked' : 'unlocked'),
  );
});
afterEach(() => {
  stopListening();
  releaseSplitLock(PROJECT, WORKTREE);
  restoreResolver();
});

it('starts nothing under the lock until its key resolves, then locks before any teardown', async () => {
  const started = start();
  await settleMicrotasks();
  expect(isSplitLocked(PROJECT, WORKTREE)).toBe(false);
  expect(mockEvents).toEqual([]);
  resolveKeys();
  await expect(started).resolves.toEqual({
    mode: 'review',
    result: { status: 'locked' },
  });
  expect(mockEvents).toEqual([
    'locked',
    'projection',
    'kill-terminals',
    'stop-hooks',
    'stop-scripts',
  ]);
});

it('refuses a Git action that began while the key resolved, with no lock and no side effect', async () => {
  const started = start();
  await settleMicrotasks();
  const gitAction = beginExclusiveGitAction(TARGET);
  try {
    resolveKeys();
    await expect(started).rejects.toBeInstanceOf(SplitStartBlockedError);
    await expect(started).rejects.toMatchObject({
      blocker: 'active-git-action',
    });
  } finally {
    finishGitActionCancellationScope(TARGET, gitAction);
  }
  expect(isSplitLocked(PROJECT, WORKTREE)).toBe(false);
  expect(mockEvents).toEqual([]);
});

it('refuses a second start and an unresolvable worktree before any side effect', async () => {
  const first = start();
  await settleMicrotasks();
  resolveKeys();
  await first;
  mockEvents.length = 0;
  const second = start();
  await settleMicrotasks();
  resolveKeys();
  await expect(second).rejects.toThrow(
    'A Split PR workflow is already in progress for this worktree.',
  );
  const unknown = start('unknown');
  await settleMicrotasks();
  resolveKeys();
  await expect(unknown).rejects.toBeInstanceOf(SplitLockError);
  expect(mockEvents).toEqual([]);
});
