// CAN-7357: the projects:save compatibility projection must not refuse every
// save because the read path delivered a legacy-id or duplicate-id row. Real
// sidebar storage in a temporary data root, with the W5 commit-log worker.
import type * as LegacyStorage from '../../lib/__tests__/fixtures/w5-legacy-storage';
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<
      typeof LegacyStorage
    >('../../lib/__tests__/fixtures/w5-legacy-storage')
    .createLegacyW5StorageMock(),
);
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../services/desktop-structure-signal', () => ({
  scheduleDesktopStructureChanged: jest.fn(),
}));
jest.mock('../../agents/session-manager', () => ({}));
jest.mock('../../pipelines/execution-runtime', () => ({}));
jest.mock('../../ledger/lifecycle', () => ({
  registerLedgerLifecycleCaches: jest.fn(),
}));
const mockHandlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => Promise<unknown>
>();
jest.mock('../register', () => ({
  registerIpcHandler: (
    name: string,
    handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
  ): typeof mockHandlers => mockHandlers.set(name, handler),
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: (): number => 0,
}));
// The handlers' pollers, watchers and code-graph manager would outlive the
// temporary data root; the save under test needs none of them.
jest.mock('../../lib/github-poller', () => ({
  ...jest.requireActual<object>('../../lib/github-poller'),
  syncTrackedWorktrees: jest.fn(),
}));
jest.mock('../../lib/workspace-reference-repo-poller', () => ({
  ...jest.requireActual<object>('../../lib/workspace-reference-repo-poller'),
  startPolling: jest.fn(),
  syncTrackedWorkspaces: jest.fn(),
}));
jest.mock('../../lib/code-graph-base-manager', () => ({
  ...jest.requireActual<object>('../../lib/code-graph-base-manager'),
  startCodeGraphBaseManager: jest.fn(),
  syncCodeGraphBaseRepositories: jest.fn(),
}));
jest.mock('../../lib/worktrees-file-watcher', () => ({
  ...jest.requireActual<object>('../../lib/worktrees-file-watcher'),
  syncWorktreesFileWatchers: jest.fn(),
}));

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  IPC_CHANNELS,
  type CoworkSidebarItem,
  type SidebarItem,
  type SidebarItemsFile,
} from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { registerProjectHandlers } from '../projects';
import { getWorkspaceDir, getWorkspaceIndexFilePath } from '../../lib/paths';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  writeAllSidebarItems,
} from '../../lib/sidebar-items';
import { saveSidebarItems } from '../../lib/sidebar-save-adapter';
import { SidebarItemsInvalidError } from '../../lib/sidebar-save-errors';

jest.setTimeout(30_000);

const LEGACY_ID = 'Legacy_Id';
const DUPLICATE_ID = 'duplicate';

function coworkItem(id: string, order: number): CoworkSidebarItem {
  return {
    id,
    name: `Project ${id}`,
    type: 'cowork',
    color: '#7C3AED',
    collapsed: false,
    order,
    cowork: { createdAt: '2026-09-01T00:00:00.000Z' },
  };
}

type IndexEntry = Record<string, unknown> & { id: string };

async function readIndexEntries(): Promise<IndexEntry[]> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceIndexFilePath(), 'utf8'),
  );
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('workspaces' in parsed) ||
    !Array.isArray(parsed.workspaces)
  )
    throw new Error('Expected a workspace index');
  return parsed.workspaces.filter(
    (entry: unknown): entry is IndexEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      typeof entry.id === 'string',
  );
}

const rowsOf = (entries: IndexEntry[], id: string): IndexEntry[] =>
  entries.filter((entry) => entry.id === id);

describe('projects:save with delivered legacy and duplicate rows (CAN-7357)', () => {
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'projects-save-legacy-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems(
      ['alpha', 'legacy-source', DUPLICATE_ID].map(coworkItem),
    );
    // An index an older build wrote: an `_`/uppercase id and a repeated row.
    const raw: unknown = JSON.parse(
      await readFile(getWorkspaceIndexFilePath(), 'utf8'),
    );
    const entries = await readIndexEntries();
    await cp(getWorkspaceDir('legacy-source'), getWorkspaceDir(LEGACY_ID), {
      recursive: true,
    });
    await writeFile(
      getWorkspaceIndexFilePath(),
      JSON.stringify({
        ...(typeof raw === 'object' && raw !== null ? raw : {}),
        workspaces: entries.flatMap((entry) =>
          entry.id === 'legacy-source'
            ? [{ ...entry, id: LEGACY_ID }]
            : entry.id === DUPLICATE_ID
              ? [entry, { ...entry }]
              : [entry],
        ),
      }),
    );
    __resetSidebarItemsStateForTests();
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('saves the other projects and preserves the delivered rows unchanged', async () => {
    const delivered: SidebarItem[] = (await readAllSidebarItems()).items;
    expect(delivered.map((item) => item.id)).toEqual([
      'alpha',
      LEGACY_ID,
      DUPLICATE_ID,
      DUPLICATE_ID,
    ]);
    const before = await readIndexEntries();

    const result = await saveSidebarItems({
      source: 'projects_save',
      items: delivered.map((item) => ({ ...item, name: `${item.name} (2)` })),
      previousItems: delivered,
    });

    expect(result.preservedWorkspaceIds).toEqual(
      expect.arrayContaining([LEGACY_ID, DUPLICATE_ID]),
    );
    const saved = (await readAllSidebarItems()).items;
    expect(saved.find((item) => item.id === 'alpha')?.name).toBe(
      'Project alpha (2)',
    );
    const after = await readIndexEntries();
    expect(rowsOf(after, LEGACY_ID)).toEqual(rowsOf(before, LEGACY_ID));
    expect(rowsOf(after, DUPLICATE_ID)).toEqual(rowsOf(before, DUPLICATE_ID));

    // A row the window was not delivered is still refused.
    const alpha = delivered[0];
    if (!alpha) throw new Error('alpha was not delivered');
    await expect(
      saveSidebarItems({
        source: 'projects_save',
        items: [...delivered, alpha],
        previousItems: delivered,
      }),
    ).rejects.toBeInstanceOf(SidebarItemsInvalidError);
  });

  it('lets a window save twice through the projects:save handler', async () => {
    const caller: CanopyCallerDescriptor = {
      principalId: 'local',
      clientInstanceId: 'projects-save-legacy-rows-golden',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop',
      grants: [
        'core.workspace.read',
        'core.workspace.write',
        'core.worktree.read',
        'core.worktree.write',
      ],
    };
    const runtime = createDesktopRuntime();
    registerProjectHandlers(
      () => new BrowserWindow(),
      runtime,
      () => caller,
    );
    const sender = { id: 1 };
    const ipc = async (
      channel: string,
      ...args: unknown[]
    ): Promise<unknown> => {
      const handler = mockHandlers.get(channel);
      if (!handler) throw new Error(`missing handler ${channel}`);
      return handler({ sender }, ...args);
    };
    const load = async (): Promise<SidebarItem[]> =>
      ((await ipc(IPC_CHANNELS.projectsLoad)) as SidebarItemsFile).items;
    try {
      const delivered = await load();
      const first = delivered.map((item) => ({ ...item, name: 'First' }));
      await ipc(IPC_CHANNELS.projectsSave, first);
      // The next save from the same window, without a reload, still admits
      // every delivered row, duplicates included (the CAN-7357 failure).
      const second = first.map((item) => ({ ...item, name: 'Second' }));
      await ipc(IPC_CHANNELS.projectsSave, second);
      const saved = await load();
      expect(saved.find((item) => item.id === 'alpha')?.name).toBe('Second');
      expect(saved.filter((item) => item.id === DUPLICATE_ID)).toHaveLength(2);
      expect(saved.some((item) => item.id === LEGACY_ID)).toBe(true);
      // A duplicate beyond what the window was delivered is still refused.
      await expect(
        ipc(IPC_CHANNELS.projectsSave, [...second, ...second.slice(0, 1)]),
      ).rejects.toBeInstanceOf(SidebarItemsInvalidError);
    } finally {
      await settleDetachedWork();
      await runtime.shutdown();
    }
  });
});
