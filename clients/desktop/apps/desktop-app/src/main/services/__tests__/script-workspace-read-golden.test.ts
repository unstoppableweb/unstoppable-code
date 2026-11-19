import { installRoutedW5GoldenStore } from '../../lib/__tests__/fixtures/w5-routed-golden-store';
// CAN-6944: script listing reads only the target project's own index entry,
// config and worktree list instead of projecting every indexed workspace.
// Real W5 authority and framed record port. The target project it finds is
// the one the full sidebar projection found, and the one inline repair that
// moves is another workspace's: it waits for that workspace's own next read.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { getWorkspaceConfigPath } from '../../lib/paths';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  writeAllSidebarItems,
} from '../../lib/sidebar-items';
import { desktopW5FileStore } from '../../lib/w5-commit-log-file-store';
import {
  markWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceWorktreesDetailed,
  updateWorkspaceConfig,
} from '../../lib/workspace-persistence';
import {
  listWorktreeScriptEntries,
  readScriptWorkspaceItem,
} from '../scripts-service';

jest.setTimeout(60_000);

const CREATED_AT = '2026-11-17T00:00:00.000Z';

let root: string;
let originalDataDir: string | undefined;
let closeW5Store: (() => Promise<void>) | undefined;

beforeEach(async () => {
  __resetSidebarItemsStateForTests();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'script-workspace-read-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(root, 'data');
  closeW5Store = await installRoutedW5GoldenStore();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await closeW5Store?.();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(root, { recursive: true, force: true });
});

function repo(name: string): string {
  const path = join(root, 'repos', name);
  mkdirSync(path, { recursive: true });
  return path;
}

function worktree(id: string): {
  id: string;
  branchName: string;
  createdAt: string;
} {
  return { id, branchName: id, createdAt: CREATED_AT };
}

function singleRepo(id: string, order: number): SidebarItem {
  return {
    id,
    name: id,
    type: 'single-repo',
    color: '#0EA5E9',
    collapsed: false,
    order,
    repoPath: repo(id),
    scripts: { dev: 'echo dev', test: 'echo test' },
    worktrees: [worktree(`${id}-wt`), worktree(`${id}-gone`)],
  };
}

/** Every case's projects, one of each kind the projection can drop. */
async function seed(): Promise<void> {
  await writeAllSidebarItems(projects());
  // Sidebar writes refuse a relative repoPath; an older or hand-edited
  // config can still hold one.
  await updateWorkspaceConfig('relative', (config): void => {
    config.repoPath = 'relative/path';
  });
}

function projects(): SidebarItem[] {
  return [
    singleRepo('single', 0),
    {
      id: 'multi',
      name: 'multi',
      type: 'multi-repo',
      color: '#0EA5E9',
      collapsed: false,
      order: 1,
      sourceRepoPath: repo('multi-source'),
      repos: [],
      scripts: { build: 'echo build' },
      worktrees: [worktree('multi-wt')],
    },
    {
      id: 'cowork',
      name: 'cowork',
      type: 'cowork',
      color: '#0EA5E9',
      collapsed: false,
      order: 2,
    },
    singleRepo('relative', 3),
    singleRepo('unreadable', 4),
    singleRepo('other', 5),
  ];
}

/** The derivation script listing used before CAN-6944. */
async function fromFullProjection(id: string): Promise<unknown> {
  const { items } = await readAllSidebarItems();
  const item = items.find((candidate) => candidate.id === id);
  if (!item || item.type === 'cowork') return null;
  return withoutOrder(item);
}

/** The full projection renumbers `order` by position; listing never reads it. */
function withoutOrder(item: object | null): unknown {
  return item && { ...item, order: undefined };
}

async function storedWorktreeIds(workspaceId: string): Promise<string[]> {
  const { worktrees } = await readWorkspaceWorktreesDetailed(workspaceId, {
    includeRecentlyRemoved: true,
  });
  return worktrees.map(({ id }) => id);
}

describe('script listing reads only the target project (CAN-6944)', () => {
  it.each([
    ['a valid single-repo project', 'single'],
    ['a valid multi-repo project', 'multi'],
    ['a cowork project', 'cowork'],
    ['a project whose repoPath is not absolute', 'relative'],
    ['a project whose config is unreadable', 'unreadable'],
    ['a project the index does not list', 'missing'],
  ])('finds the same item as the full projection for %s', async (_, id) => {
    await seed();
    const configPath = getWorkspaceConfigPath('unreadable');
    const read = desktopW5FileStore.read.bind(desktopW5FileStore);
    jest
      .spyOn(desktopW5FileStore, 'read')
      .mockImplementation((path) =>
        path === configPath
          ? Promise.resolve({ state: 'unreadable' })
          : read(path),
      );
    const expected = await fromFullProjection(id);
    expect(withoutOrder(await readScriptWorkspaceItem(id))).toEqual(expected);
    if (['single', 'multi'].includes(id)) expect(expected).not.toBeNull();
    else expect(expected).toBeNull();
  });

  it("leaves another workspace's repair to that workspace's own next read", async () => {
    await seed();
    markWorkspaceWorktreeRecentlyRemoved('other', 'other-gone', CREATED_AT);

    await readScriptWorkspaceItem('single');
    expect(await storedWorktreeIds('other')).toEqual([
      'other-wt',
      'other-gone',
    ]);

    await readWorkspaceWorktreesDetailed('other');
    expect(await storedWorktreeIds('other')).toEqual(['other-wt']);
  });

  it("still repairs the target project's own worktree list inline", async () => {
    await seed();
    markWorkspaceWorktreeRecentlyRemoved('single', 'single-gone', CREATED_AT);

    const item = await readScriptWorkspaceItem('single');
    expect(item?.worktrees.map(({ id }) => id)).toEqual(['single-wt']);
    expect(await storedWorktreeIds('single')).toEqual(['single-wt']);
  });

  it("lists the target project's scripts for script-actions:list", async () => {
    await seed();
    const names = async (projectId: string): Promise<string[]> =>
      (
        await listWorktreeScriptEntries({
          projectId,
          worktreeId: `${projectId}-wt`,
        })
      )
        .map(({ descriptor }) => descriptor.scriptName)
        .sort();
    expect(await names('single')).toEqual(['dev', 'test']);
    expect(await names('multi')).toEqual(['build']);
    expect(await names('cowork')).toEqual([]);
    expect(await names('missing')).toEqual([]);
  });
});
