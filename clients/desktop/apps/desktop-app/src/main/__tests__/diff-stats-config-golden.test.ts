// CAN-4070 rule: captured on the unchanged `worktree:diff-stats` and
// `worktree:diff-stats-batch` IPC handlers before CAN-4103 moved diff-stats
// computation behind `worker.git.diff.get`. The legacy totals follow the
// repository's own Git configuration: `--shortstat` honors `diff.renames`,
// and the untracked listing honors `core.quotePath`. Real data root,
// workspace records and Git checkouts; only IPC registration is mocked.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS, type WorkspaceType } from '@canopy/desktop-shared/types';
import { describeError } from './helpers/diff-golden-fixtures';

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

import { getWorktreeDiffStatsOnly } from '../lib/worktree-service';
import { mainAdvisorWorktreeActionHost } from '../app-advisor/advisor-worktree-action-host';
import { markWorkspaceTargetRemovalPending } from '../lib/workspace-target-exclusion';
import {
  getCachedWorktreeDiffStats,
  refreshWorktreeDiffStats,
  removeCachedWorktreeDiffStats,
} from '../services/worktree-diff-stats-cache';
import { registerWorktreeHandlers } from '../ipc/worktrees';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';

jest.setTimeout(120_000);

const POSIX = process.platform !== 'win32';
const posixIt = POSIX ? it : it.skip;
const WORKTREE = 'feature-01';

/** Workspace id -> repository-local configuration. */
const WORKSPACES = {
  // Non-ASCII untracked names, quoted (Git's default) and raw.
  'quote-on-ws': [['core.quotePath', 'true']],
  'quote-off-ws': [['core.quotePath', 'false']],
  // A committed rename and a copy whose source changed.
  'renames-off-ws': [['diff.renames', 'false']],
  'renames-on-ws': [['diff.renames', 'true']],
  'copies-ws': [['diff.renames', 'copies']],
  // Git refuses an invalid boolean for every command.
  'bad-bool-ws': [['core.quotePath', 'maybe']],
} as const;
type ConfigWorkspace = keyof typeof WORKSPACES;
const IDS = Object.keys(WORKSPACES).filter(
  (id): id is ConfigWorkspace => id in WORKSPACES,
);

let dir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher | undefined;

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

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function lines(prefix: string, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `${prefix} ${index + 1}\n`,
  ).join('');
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

/** A clone with an origin, a worktree on `feature-01`, and its changes. */
function createWorkspace(
  dataDir: string,
  id: ConfigWorkspace,
  config: ReadonlyArray<readonly [string, string]>,
): void {
  const seed = join(dir, 'seeds', id);
  mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.email', 'golden@example.com']);
  git(seed, ['config', 'user.name', 'Golden']);
  git(seed, ['config', 'commit.gpgsign', 'false']);
  write(join(seed, 'rename-src.txt'), lines('rename', 20));
  write(join(seed, 'copy-src.txt'), lines('copy', 20));
  write(join(seed, 'keep.txt'), 'keep\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'base']);
  const origin = join(dir, 'origins', `${id}.git`);
  mkdirSync(dirname(origin), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
    stdio: 'pipe',
  });
  const clone = join(dir, 'clones', id);
  mkdirSync(dirname(clone), { recursive: true });
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'pipe' });
  const tree = join(dataDir, 'workspaces', id, 'worktrees', WORKTREE);
  git(clone, ['worktree', 'add', '-q', '-b', WORKTREE, tree]);
  git(tree, ['config', 'user.email', 'golden@example.com']);
  git(tree, ['config', 'user.name', 'Golden']);
  git(tree, ['config', 'commit.gpgsign', 'false']);
  git(tree, ['mv', 'rename-src.txt', 'renamed.txt']);
  write(join(tree, 'renamed.txt'), lines('rename', 19) + 'rename edited\n');
  write(join(tree, 'copied.txt'), lines('copy', 20) + 'copy extra\n');
  write(join(tree, 'copy-src.txt'), lines('copy', 20) + 'copy tail\n');
  git(tree, ['add', '-A']);
  git(tree, ['commit', '-q', '-m', 'feature']);
  write(join(tree, 'keep.txt'), 'keep\nkept\n');
  write(join(tree, 'plain-untracked.txt'), lines('plain', 2));
  if (POSIX) {
    write(join(tree, 'naïve-untracked.txt'), lines('naive', 3));
    write(join(tree, 'dir', '日本.txt'), lines('nihon', 4));
  }
  // Configured last: an invalid value would stop the setup commands.
  for (const [key, value] of config) git(clone, ['config', key, value]);
  writeJson(join(dataDir, 'workspaces', id, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: clone,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', id, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: WORKTREE,
        branchName: WORKTREE,
        createdAt: '2026-10-31T00:00:00.000Z',
      },
    ],
  });
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'diff-stats-config-')));
  const dataDir = join(dir, 'data');
  for (const id of IDS) createWorkspace(dataDir, id, WORKSPACES[id]);
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: IDS.map((id, order) => ({
      id,
      name: id,
      type: 'single-repo',
      color: '#38BDF8',
      collapsed: false,
      order,
    })),
  });
  registerWorkspaceTypes(
    new Map(IDS.map((id): [string, WorkspaceType] => [id, 'single-repo'])),
  );
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  runtime = createDesktopRuntime();
  registerWorktreeHandlers(() => null, {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
  });
});

afterAll(async () => {
  await runtime?.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const scrub = (value: string): string =>
  value.split(dir).join('<root>').replace(ISO, '<time>');

async function ipc(channel: string, request: unknown): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  try {
    const event: Partial<IpcMainInvokeEvent> = {};
    const result: unknown = await handler(event, request);
    const parsed: unknown = JSON.parse(scrub(JSON.stringify(result) ?? 'null'));
    return { result: parsed };
  } catch (error) {
    return { error: describeError(error, scrub) };
  }
}

describe('worktree:diff-stats under repository configuration', () => {
  posixIt('counts with each configuration', async () => {
    for (const projectId of IDS)
      expect(
        await ipc(IPC_CHANNELS.worktreeDiffStats, {
          projectId,
          worktreeId: WORKTREE,
        }),
      ).toMatchSnapshot(projectId);
  });

  posixIt('answers diff-only and full batch rows alike', async () => {
    expect(
      await ipc(IPC_CHANNELS.worktreeDiffStatsBatch, {
        worktrees: IDS.flatMap((projectId) =>
          (['diff_only', 'full'] as const).map((mode) => ({
            projectId,
            worktreeId: WORKTREE,
            mode,
          })),
        ),
        skipFetch: true,
        source: 'user-explicit',
      }),
    ).toMatchSnapshot();
  });
});

describe('worktree stats availability and health', () => {
  const projectId = 'quote-on-ws';
  posixIt.each(['missing', 'retiring'] as const)(
    'does not verify or cache stats for a %s source',
    async (state) => {
      const id = state === 'missing' ? projectId : 'quote-off-ws';
      if (state === 'missing') {
        const dataDir = process.env.CANOPY_DATA_DIR;
        if (!dataDir) throw new Error('Missing test data root');
        rmSync(join(dataDir, 'workspaces', id, 'worktrees', WORKTREE), {
          recursive: true,
          force: true,
        });
      }
      const release =
        state === 'retiring'
          ? markWorkspaceTargetRemovalPending(id, WORKTREE)
          : (): void => {};
      const read = jest.fn(() =>
        Promise.resolve({ insertions: 19, deletions: 3 }),
      );
      removeCachedWorktreeDiffStats(id, WORKTREE);
      try {
        await expect(
          getWorktreeDiffStatsOnly(id, WORKTREE, read),
        ).rejects.toThrow();
        const host = mainAdvisorWorktreeActionHost({
          getMainWindow: () => null,
          selectWorktree: async () => {},
          readSourceStatus: (project, worktree) =>
            getWorktreeDiffStatsOnly(project, worktree, read),
        });
        expect(await host.verifySourceStatus(id, WORKTREE)).toBe(false);
        await refreshWorktreeDiffStats(id, WORKTREE, read);
        expect(getCachedWorktreeDiffStats(id, WORKTREE)).toBeUndefined();
        expect(read).not.toHaveBeenCalled();
      } finally {
        release();
      }
    },
  );
});
