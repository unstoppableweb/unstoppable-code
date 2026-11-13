/**
 * CAN-6031: `core.initiatedWork.watcher.create` carries ids, never a path, and
 * the host resolves a command or GitHub watcher's directory from them. Each
 * case pins that the host's directory is the calling session's own cwd, as
 * the session computes it today (`ipc/chat.ts` resolves a chat's cwd with
 * `resolveWorktreeCwd(projectId, worktreeId, selectedRepoId)`; a delegate's
 * tools get its live run's directory).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { DelegationWorkingDirectories } from '../../agents/delegation/working-directories';
import { registerCodeReviewTarget } from '../../lib/code-review-registry';
import { resolveWorktreeCwd } from '../../lib/resolve-worktree';
import {
  registerWorkspaceExternalPaths,
  registerWorkspaceTypes,
} from '../../lib/workspace-registry';
import {
  resolveWatcherDirectory,
  type CoreWatcherDirectories,
} from '../core-watcher-adapter';
import { WatcherCreateRequestSchema } from '@canopy/protocol/canopy-core';

let dataDir: string;
let previousDataDir: string | undefined;

beforeAll(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'watcher-directory-')));
  previousDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  registerWorkspaceTypes(
    new Map([
      ['single', 'single-repo'],
      ['multi', 'multi-repo'],
      ['cowork-attached', 'cowork'],
      ['cowork-home', 'cowork'],
    ]),
  );
  registerWorkspaceExternalPaths(
    new Map([['cowork-attached', join(dataDir, 'attached-folder')]]),
  );
});

afterAll(() => {
  registerWorkspaceTypes(new Map());
  registerWorkspaceExternalPaths(new Map());
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const chat = (
  projectId: string,
  worktreeId: string,
): { projectId: string; worktreeId: string; chatId: string } => ({
  projectId,
  worktreeId,
  chatId: 'chat',
});

/** The directory today's chat session runs in. */
const sessionCwd = (
  projectId: string,
  worktreeId: string,
  selectedRepoId?: string,
): string => resolveWorktreeCwd(projectId, worktreeId, selectedRepoId);

describe('watcher directories from ids (CAN-6031)', () => {
  it.each([
    ['a single-repo worktree chat', 'single', 'task', undefined],
    ['a multi-repo chat with a selected repository', 'multi', 'task', 'repo-a'],
    ['a multi-repo chat with none selected', 'multi', 'task', undefined],
    [
      'a Cowork chat with an attached folder',
      'cowork-attached',
      'home',
      undefined,
    ],
    ['a Cowork chat in its managed home', 'cowork-home', 'home', undefined],
  ])(
    'resolves %s to the session cwd',
    async (_case, projectId, worktreeId, repoId) => {
      await expect(
        resolveWatcherDirectory(chat(projectId, worktreeId), repoId),
      ).resolves.toBe(sessionCwd(projectId, worktreeId, repoId));
    },
  );

  it('resolves concrete directories, not one shared fallback', async () => {
    const directories = await Promise.all([
      resolveWatcherDirectory(chat('single', 'task'), undefined),
      resolveWatcherDirectory(chat('multi', 'task'), 'repo-a'),
      resolveWatcherDirectory(chat('multi', 'task'), undefined),
      resolveWatcherDirectory(chat('cowork-attached', 'home'), undefined),
    ]);
    expect(new Set(directories).size).toBe(4);
    expect(directories[1]).toContain('repo-a');
    expect(directories[3]).toBe(join(dataDir, 'attached-folder'));
  });

  it('resolves a registered chat worktree to the worktree it borrows', async () => {
    await registerCodeReviewTarget('single--task', {
      projectId: 'single',
      worktreeId: 'task',
    });
    await expect(
      resolveWatcherDirectory(
        chat(CODE_REVIEW_CHAT_PROJECT_ID, 'single--task'),
        undefined,
      ),
    ).resolves.toBe(sessionCwd(CODE_REVIEW_CHAT_PROJECT_ID, 'single--task'));
    expect(sessionCwd(CODE_REVIEW_CHAT_PROJECT_ID, 'single--task')).toBe(
      sessionCwd('single', 'task'),
    );
  });

  it("matches App Advisor's directory for its selected target", async () => {
    // app-advisor/runtime.ts runs WatchCommand in the selected target's
    // `resolveWorktreeCwd(target.projectId, target.worktreeId)`.
    await expect(
      resolveWatcherDirectory(chat('multi', 'task'), undefined),
    ).resolves.toBe(resolveWorktreeCwd('multi', 'task'));
    await expect(
      resolveWatcherDirectory(chat(APP_ADVISOR_PROJECT_ID, 'home'), undefined),
    ).resolves.toBe(resolveWorktreeCwd(APP_ADVISOR_PROJECT_ID, 'home'));
  });

  it("keeps a router session's selected repository when the route has no cwd", async () => {
    // The router's action runtime falls back to the worktree root; the
    // session's own cwd, which the host resolves, includes the repository.
    const routerFallback = resolveWorktreeCwd('multi', 'task');
    const resolved = await resolveWatcherDirectory(
      chat('multi', 'task'),
      'repo-a',
    );
    expect(resolved).toBe(sessionCwd('multi', 'task', 'repo-a'));
    expect(resolved).not.toBe(routerFallback);
  });

  it("resolves a managed delegate to its live run's directory, and refuses without one", async () => {
    const runs = new DelegationWorkingDirectories();
    const directories: CoreWatcherDirectories = {
      chat: () =>
        Promise.reject(new Error('A delegate never resolves a chat.')),
      delegate: (scope, delegationId) =>
        Promise.resolve(runs.get(delegationId, scope.chatId)),
    };
    const delegate = (
      delegationId: string,
      chatId = 'chat',
    ): {
      projectId: string;
      worktreeId: string;
      chatId: string;
      delegationId: string;
    } => ({
      ...chat('single', 'task'),
      chatId,
      delegationId,
    });
    // Shared at depth 0, shared nested and isolated runs register the
    // directory their tools use; the host reads that same value.
    const releases = [
      runs.register('shared', 'chat', '/worktrees/single/task'),
      runs.register('nested', 'chat', '/worktrees/isolated-parent'),
      runs.register('isolated', 'chat', '/worktrees/isolated-child'),
    ];
    await expect(
      resolveWatcherDirectory(delegate('shared'), 'repo-a', directories),
    ).resolves.toBe('/worktrees/single/task');
    await expect(
      resolveWatcherDirectory(delegate('nested'), undefined, directories),
    ).resolves.toBe('/worktrees/isolated-parent');
    await expect(
      resolveWatcherDirectory(delegate('isolated'), undefined, directories),
    ).resolves.toBe('/worktrees/isolated-child');
    // Another chat's delegation, and a run that ended, have no directory.
    await expect(
      resolveWatcherDirectory(
        delegate('shared', 'other'),
        undefined,
        directories,
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.initiatedWork.watcher.unavailable' },
    });
    releases[0]?.();
    await expect(
      resolveWatcherDirectory(delegate('shared'), undefined, directories),
    ).rejects.toMatchObject({
      payload: { code: 'core.initiatedWork.watcher.unavailable' },
    });
    // A later run's entry survives an earlier run's cleanup.
    const earlier = runs.register('isolated', 'chat', '/first');
    runs.register('isolated', 'chat', '/second');
    earlier();
    expect(runs.get('isolated', 'chat')).toBe('/second');
  });

  it('refuses a host path in a command or GitHub request', () => {
    const base = { command: 'true', intervalSeconds: 5, maxAttempts: 1 };
    expect(
      WatcherCreateRequestSchema.safeParse({
        kind: 'command',
        ...base,
        cwd: '/tmp',
      }).success,
    ).toBe(false);
    expect(
      WatcherCreateRequestSchema.safeParse({
        kind: 'github',
        input: {},
        repositoryCwd: '/tmp',
      }).success,
    ).toBe(false);
    expect(
      WatcherCreateRequestSchema.safeParse({
        kind: 'command',
        ...base,
        repoId: 'repo-a',
      }).success,
    ).toBe(true);
  });
});
