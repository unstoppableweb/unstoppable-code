// Must load first: it installs this file's data root before any owner loads.
import { dataRoot, previousDataDir } from './fixtures/work-entry-registry-root';
/**
 * CAN-4476 equivalence golden: the Work Entry registry's bytes, order,
 * signals and refusals, captured on develop through the real owner under all
 * three roots (`workspaces/<cowork>`, `app-workspaces/app-advisor` and
 * `app-workspaces/bot--*`). Later CAN-4476 PRs add cases; they never edit
 * these assertions.
 */
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type ChatTabsFile,
} from '@canopy/desktop-shared/types';
import type * as LegacyStorage from './fixtures/w5-legacy-storage';
import * as AtomicFile from '../atomic-file';
import * as SidebarItemGroups from '../sidebar-item-groups';
import { registerWorkspaceTypes } from '../workspace-registry';
import {
  activateWorkEntryWorkspace,
  appendWorkEntryRows,
  clearWorkEntrySummariesForWorkspace,
  createWorkEntry,
  listWorkEntries,
  listWorkEntryChatSummaries,
  listWorkEntryIds,
  onWorkEntryListChanged,
  readWorkEntriesFileStrict,
  readWorkEntryRegistryRowState,
  refreshWorkEntrySummaryStamp,
  removeUnstartedWorkEntry,
  removeWorkEntryRow,
  reorderWorkEntries,
  setWorkEntryRegistryReconciler,
  syncWorkEntrySummaryFromWrite,
  touchAllWorkEntries,
  touchWorkEntry,
  updateWorkEntry,
  updateWorkEntryRegistry,
  workEntryRegistryExists,
} from '../cowork-work-entries';
import { migrateAppManagedChatWorkspaces } from '../app-managed-workspaces';
import { getWorktreePanelLayoutFilePath } from '../paths';
import { registerIpcHandler } from '../../ipc/register';
import { registerStandaloneChatHandlers } from '../../ipc/standalone-chat';

// Workspace creation for import only: W5 rows on the historical Electron writer.
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<typeof LegacyStorage>('./fixtures/w5-legacy-storage')
    .createLegacyW5StorageMock(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: (): object => ({
    recordAppDiagnostic: (): void => undefined,
    recordUsageMetricEvent: (): void => undefined,
  }),
}));
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): never[] => [] },
  dialog: { showOpenDialog: jest.fn() },
}));
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../../services/desktop-structure-signal', () => ({
  scheduleDesktopStructureChanged: (): void => undefined,
}));

const T0 = '2026-11-20T10:00:00.000Z';
const T1 = '2026-11-20T11:00:00.000Z';
const T2 = '2026-11-20T12:00:00.000Z';
const MISSING_SUMMARY = {
  version: 1,
  title: 'New Chat',
  chatCount: 0,
  chats: [],
  sourceMtimeNs: 'missing',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Kind = 'cowork' | 'app-advisor' | 'bot';
interface Workspace {
  id: string;
  root: string;
}
let serial = 0;
function workspace(kind: Kind): Workspace {
  serial += 1;
  if (kind === 'cowork') {
    const id = `cowork-${String(serial)}`;
    registerWorkspaceTypes(new Map([[id, 'cowork']]));
    return { id, root: join(dataRoot, 'workspaces', id) };
  }
  registerWorkspaceTypes(new Map());
  const id =
    kind === 'app-advisor'
      ? 'app-advisor'
      : `bot--01jqrstvwxyz${String(serial).padStart(14, '0')}`;
  return { id, root: join(dataRoot, 'app-workspaces', id) };
}

const registryPath = (ws: Workspace): string =>
  join(ws.root, 'work-entries.json');
const bytes = (entries: object[]): string =>
  JSON.stringify({ version: 1, entries }, null, 2);
const raw = (ws: Workspace): Promise<string> =>
  readFile(registryPath(ws), 'utf8');
async function seed(ws: Workspace, text: string): Promise<void> {
  await mkdir(ws.root, { recursive: true });
  await writeFile(registryPath(ws), text, 'utf8');
}
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected a rejection');
}
/** Temp files the owner left beside the registry. */
async function strays(ws: Workspace): Promise<string[]> {
  return (await readdir(ws.root)).filter((name) => name.endsWith('.tmp'));
}

interface ReconcilerPlan {
  rollback?: () => Promise<void>;
  afterWrite?: () => Promise<void>;
}
const reconciler: {
  calls: Array<{ workspaceId: string; ids: string[]; options: unknown }>;
  plan?: ReconcilerPlan;
} = { calls: [] };
const listChanged: string[] = [];
// Every installed registry write publishes once, so this also counts writes,
// including rewrites of unchanged bytes.
let groupPublishes: string[] = [];

function setClock(iso: string): void {
  jest.setSystemTime(new Date(iso));
}

beforeAll(() => {
  onWorkEntryListChanged((workspaceId) => listChanged.push(workspaceId));
});
beforeEach(async () => {
  jest.useFakeTimers({
    now: new Date(T0),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  listChanged.length = 0;
  reconciler.calls = [];
  reconciler.plan = undefined;
  groupPublishes = [];
  jest
    .spyOn(SidebarItemGroups, 'publishSidebarItemGroupsChanged')
    .mockImplementation((workspaceId) => {
      groupPublishes.push(workspaceId);
    });
  await rm(join(dataRoot, 'app-workspaces', 'app-advisor'), {
    recursive: true,
    force: true,
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});
afterAll(async () => {
  registerWorkspaceTypes(new Map());
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  await rm(join(dataRoot, '..'), { recursive: true, force: true });
});

describe('before a group reconciler is installed', () => {
  test('a grouped create refuses before any write', async () => {
    const ws = workspace('cowork');
    expect(
      await rejection(
        createWorkEntry(ws.id, { id: 'grouped', sidebarItemGroupId: 'g1' }),
      ),
    ).toBe('Sidebar item group service is not initialized');
    await expect(stat(registryPath(ws))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(listChanged).toEqual([]);
  });
});

describe.each<Kind>(['cowork', 'app-advisor', 'bot'])('%s registry', (kind) => {
  let ws: Workspace;
  beforeAll(() => {
    setWorkEntryRegistryReconciler((workspaceId, entries, options) => {
      reconciler.calls.push({
        workspaceId,
        ids: entries.map((entry) => entry.id),
        options,
      });
      return Promise.resolve({ rows: entries, ...reconciler.plan });
    });
  });
  beforeEach(() => {
    ws = workspace(kind);
  });

  test('creates explicit and default entries, then reuses an empty one', async () => {
    const created = await createWorkEntry(ws.id, {
      id: 'alpha',
      title: '  Alpha  ',
    });
    expect(created).toEqual({
      entry: {
        id: 'alpha',
        hasUserChanges: true,
        title: 'Alpha',
        createdAt: T0,
        lastTouchedAt: T0,
        chatCount: 0,
      },
      reusedExistingEmpty: false,
    });
    const alpha = {
      id: 'alpha',
      title: 'Alpha',
      createdAt: T0,
      lastTouchedAt: T0,
    };
    expect(await raw(ws)).toBe(bytes([alpha]));
    expect(reconciler.calls).toEqual([
      {
        workspaceId: ws.id,
        ids: ['alpha'],
        options: {
          sidebarItemGroupId: undefined,
          newItemId: 'alpha',
          assertCanCommit: undefined,
        },
      },
    ]);
    expect(groupPublishes).toEqual([ws.id]);
    expect(listChanged).toEqual([ws.id]);

    // An existing id answers the row without writing or signalling.
    const again = await createWorkEntry(ws.id, { id: 'alpha' });
    expect(again.reusedExistingEmpty).toBe(true);
    expect(again.entry.id).toBe('alpha');
    expect(await raw(ws)).toBe(bytes([alpha]));
    expect(listChanged).toEqual([ws.id]);
    expect(await rejection(createWorkEntry(ws.id, { id: 'bad/id' }))).toMatch(
      /work entry id/,
    );

    setClock(T1);
    const fresh = await createWorkEntry(ws.id);
    expect(fresh.reusedExistingEmpty).toBe(false);
    expect(fresh.entry.id).toMatch(UUID);
    const freshRow = { id: fresh.entry.id, createdAt: T1, lastTouchedAt: T1 };
    // A default create persists the summaries its reuse scan hydrated.
    const alphaSummarized = { ...alpha, summary: MISSING_SUMMARY };
    expect(await raw(ws)).toBe(bytes([freshRow, alphaSummarized]));

    setClock(T2);
    const reused = await createWorkEntry(ws.id);
    expect(reused).toMatchObject({
      reusedExistingEmpty: true,
      entry: { id: fresh.entry.id, lastTouchedAt: T2 },
    });
    expect(await raw(ws)).toBe(
      bytes([
        { ...freshRow, lastTouchedAt: T2, summary: MISSING_SUMMARY },
        alphaSummarized,
      ]),
    );
    expect(listChanged).toEqual([ws.id, ws.id, ws.id]);
    expect(groupPublishes).toHaveLength(3);
    expect(await strays(ws)).toEqual([]);
  });

  test('reuse skips a candidate with a saved layout and persists its marker', async () => {
    const older = { id: 'older', createdAt: T0 };
    const newer = { id: 'newer', createdAt: T1 };
    await seed(ws, bytes([older, newer]));
    const layouts: Array<[string, object]> = [
      ['newer', {}],
      ['older', { hasUserChanges: false }],
    ];
    for (const [id, layout] of layouts) {
      const path = getWorktreePanelLayoutFilePath(ws.id, id);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(layout), 'utf8');
    }
    setClock(T2);
    const reused = await createWorkEntry(ws.id);
    expect(reused).toMatchObject({
      reusedExistingEmpty: true,
      entry: { id: 'older' },
    });
    // The skipped candidate's in-place marker rides along in the reuse write.
    expect(await raw(ws)).toBe(
      bytes([
        { ...older, summary: MISSING_SUMMARY, lastTouchedAt: T2 },
        { ...newer, summary: MISSING_SUMMARY, hasUserChanges: true },
      ]),
    );
    expect(groupPublishes).toHaveLength(1);
  });

  test('serializes concurrent mutations in call order, past a failure', async () => {
    await seed(ws, bytes([{ id: 'a', createdAt: T0 }]));
    const settled = await Promise.all([
      appendWorkEntryRows(ws.id, [{ id: 'b', createdAt: T1 }]),
      rejection(reorderWorkEntries(ws.id, ['a'])),
      appendWorkEntryRows(ws.id, [{ id: 'c', createdAt: T2 }]),
      updateWorkEntry(ws.id, 'a', { pinned: true }),
      reorderWorkEntries(ws.id, ['c', 'b', 'a']),
      removeWorkEntryRow(ws.id, 'b'),
    ]);
    expect(settled[1]).toBe('Work entry reorder does not match entries');
    expect(await raw(ws)).toBe(
      bytes([
        { id: 'c', createdAt: T2 },
        { id: 'a', createdAt: T0, hasUserChanges: true, pinned: true },
      ]),
    );
    expect(groupPublishes).toHaveLength(5);
    expect(listChanged).toEqual([ws.id, ws.id, ws.id, ws.id]);
  });

  test('updates fields, user changes and activity watermarks', async () => {
    const row = { id: 'one', createdAt: T0, lastTouchedAt: T0 };
    const two = { id: 'two', createdAt: T0 };
    await seed(ws, bytes([row, two]));
    setClock(T1);
    await expect(
      updateWorkEntry(ws.id, 'one', {
        title: ' Renamed ',
        status: 'done',
        pinned: true,
      }),
    ).resolves.toBe(true);
    // New keys follow the row's existing keys.
    const updated = {
      id: 'one',
      createdAt: T0,
      lastTouchedAt: T1,
      hasUserChanges: true,
      title: 'Renamed',
      status: 'done',
      pinned: true,
    };
    expect(await raw(ws)).toBe(bytes([updated, two]));
    await expect(
      updateWorkEntry(ws.id, 'one', {
        title: null,
        status: 'active',
        pinned: false,
      }),
    ).resolves.toBe(true);
    const cleared = {
      id: 'one',
      createdAt: T0,
      lastTouchedAt: T1,
      hasUserChanges: true,
    };
    expect(await raw(ws)).toBe(bytes([cleared, two]));
    // An already customized row is not rewritten for the marker alone.
    await expect(
      updateWorkEntry(ws.id, 'one', { hasUserChanges: true }),
    ).resolves.toBe(false);
    await expect(
      updateWorkEntry(ws.id, 'two', { hasUserChanges: true }),
    ).resolves.toBe(true);
    await expect(
      updateWorkEntry(ws.id, 'missing', { pinned: true }),
    ).resolves.toBe(false);
    await expect(updateWorkEntry(ws.id, 'one', {})).resolves.toBe(false);
    const twoChanged = { ...two, hasUserChanges: true };
    expect(await raw(ws)).toBe(bytes([cleared, twoChanged]));

    // Touch keeps the later watermark; touch-all overwrites every row.
    await touchWorkEntry(ws.id, 'one', T0);
    expect(await raw(ws)).toBe(bytes([cleared, twoChanged]));
    await touchWorkEntry(ws.id, 'two', T2);
    expect(await raw(ws)).toBe(
      bytes([cleared, { ...twoChanged, lastTouchedAt: T2 }]),
    );
    expect(await rejection(touchWorkEntry(ws.id, 'one', 'not-a-date'))).toBe(
      'Invalid work entry lastTouchedAt',
    );
    expect(await rejection(touchAllWorkEntries(ws.id, 'not-a-date'))).toBe(
      'Invalid work entry lastTouchedAt',
    );
    await touchAllWorkEntries(ws.id, '2026-11-21T00:00:00Z');
    expect(await raw(ws)).toBe(
      bytes([
        { ...cleared, lastTouchedAt: '2026-11-21T00:00:00.000Z' },
        { ...twoChanged, lastTouchedAt: '2026-11-21T00:00:00.000Z' },
      ]),
    );
    // The earlier-watermark touch still rewrites the unchanged row.
    expect(groupPublishes).toHaveLength(6);
    expect(listChanged).toEqual([]);
  });

  test('reorders only a complete, unique permutation', async () => {
    const rows = ['a', 'b', 'c'].map((id) => ({ id, createdAt: T0 }));
    await seed(ws, `${bytes(rows)}\n`);
    for (const ids of [
      ['a', 'b'],
      ['a', 'b', 'b'],
      ['a', 'b', 'x'],
      ['a', 'b', 'c', 'd'],
    ])
      expect(await rejection(reorderWorkEntries(ws.id, ids))).toBe(
        'Work entry reorder does not match entries',
      );
    expect(await raw(ws)).toBe(`${bytes(rows)}\n`);
    expect(listChanged).toEqual([]);
    await reorderWorkEntries(ws.id, ['c', 'a', 'b']);
    expect(await raw(ws)).toBe(bytes([rows[2], rows[0], rows[1]]));
    expect(groupPublishes).toHaveLength(1);
    expect(listChanged).toEqual([ws.id]);
  });

  test('group updates share the queue, writer and invalidation', async () => {
    const rows = [{ id: 'a', createdAt: T0 }];
    await seed(ws, bytes(rows));
    await updateWorkEntryRegistry(ws.id, (entries) => Promise.resolve(entries));
    expect(reconciler.calls).toEqual([]);
    expect(groupPublishes).toEqual([ws.id]);
    expect(listChanged).toEqual([]);

    const added = { id: 'b', createdAt: T1 };
    await updateWorkEntryRegistry(
      ws.id,
      (entries) => Promise.resolve([...entries, added]),
      { newItemId: 'b', sidebarItemGroupId: 'g1' },
    );
    expect(await raw(ws)).toBe(bytes([...rows, added]));
    expect(reconciler.calls).toEqual([
      {
        workspaceId: ws.id,
        ids: ['a', 'b'],
        options: { newItemId: 'b', sidebarItemGroupId: 'g1' },
      },
    ]);
    expect(groupPublishes).toEqual([ws.id, ws.id, ws.id]);
    expect(listChanged).toEqual([ws.id]);

    // A failed caller afterWrite still invalidates the committed change.
    expect(
      await rejection(
        updateWorkEntryRegistry(
          ws.id,
          (entries) => Promise.resolve(entries.slice(1)),
          {
            afterWrite: () => Promise.reject(new Error('caller afterWrite')),
          },
        ),
      ),
    ).toBe('caller afterWrite');
    expect(await raw(ws)).toBe(bytes([added]));
    expect(listChanged).toEqual([ws.id, ws.id]);

    // So does a failed reconciler afterWrite.
    reconciler.plan = {
      afterWrite: (): Promise<void> =>
        Promise.reject(new Error('group afterWrite')),
    };
    expect(
      await rejection(
        updateWorkEntryRegistry(ws.id, (entries) =>
          Promise.resolve([...entries, ...rows]),
        ),
      ),
    ).toBe('group afterWrite');
    expect(await raw(ws)).toBe(bytes([added, ...rows]));
    expect(listChanged).toEqual([ws.id, ws.id, ws.id]);
    // Only the caller afterWrite case reached the writer's publish.
    expect(groupPublishes).toEqual([ws.id, ws.id, ws.id, ws.id]);
  });

  test('removes rows, and unstarted rows only for their incarnation', async () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id, createdAt: T0 }));
    await seed(ws, bytes(rows));
    await removeWorkEntryRow(ws.id, 'a');
    await removeWorkEntryRow(ws.id, 'missing');
    expect(await raw(ws)).toBe(bytes(rows.slice(1)));
    expect(listChanged).toEqual([ws.id, ws.id]);

    await removeUnstartedWorkEntry(ws.id, 'b', T1);
    await removeUnstartedWorkEntry(ws.id, 'missing', T0);
    expect(await raw(ws)).toBe(bytes(rows.slice(1)));
    expect(listChanged).toEqual([ws.id, ws.id]);
    await mkdir(join(ws.root, 'chats'), { recursive: true });
    const tabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'chat-c',
      tabs: [{ id: 'chat-c', title: 'Started', createdAt: T0, messages: [] }],
    };
    await writeFile(
      join(ws.root, 'chats', 'c.json'),
      JSON.stringify(tabs),
      'utf8',
    );
    await removeUnstartedWorkEntry(ws.id, 'c', T0);
    expect(await raw(ws)).toBe(bytes(rows.slice(1)));
    await removeUnstartedWorkEntry(ws.id, 'b', T0);
    expect(await raw(ws)).toBe(bytes(rows.slice(2)));
    expect(listChanged).toEqual([ws.id, ws.id, ws.id]);
    // Removing an unknown row still rewrites; unstarted refusals do not.
    expect(groupPublishes).toHaveLength(3);
  });

  test('appends only unknown, first-seen rows', async () => {
    const a = { id: 'a', createdAt: T0 };
    await seed(ws, bytes([a]));
    const b = { id: 'b', createdAt: T1 };
    await appendWorkEntryRows(ws.id, [
      { ...a, title: 'dup' },
      b,
      { ...b, title: 'dup' },
    ]);
    expect(await raw(ws)).toBe(bytes([a, b]));
    expect(listChanged).toEqual([ws.id]);
    await appendWorkEntryRows(ws.id, [a, b]);
    expect(listChanged).toEqual([ws.id]);
    expect(groupPublishes).toHaveLength(1);
    expect(await listWorkEntryIds(ws.id)).toEqual(['a', 'b']);
  });

  test('an unreadable registry refuses mutations and reads as empty', async () => {
    await expect(readWorkEntryRegistryRowState(ws.id, 'a')).resolves.toBe(
      'missing-registry',
    );
    await expect(workEntryRegistryExists(ws.id)).resolves.toBe(false);
    await expect(readWorkEntriesFileStrict(ws.id)).resolves.toEqual({
      version: 1,
      entries: [],
    });
    for (const corrupt of ['{"version":1,"entries":[{"id":7}]}', '{not json']) {
      await seed(ws, corrupt);
      const refusals = await Promise.all([
        rejection(createWorkEntry(ws.id, { id: 'a' })),
        rejection(updateWorkEntry(ws.id, 'a', { pinned: true })),
        rejection(reorderWorkEntries(ws.id, [])),
        rejection(removeWorkEntryRow(ws.id, 'a')),
        rejection(appendWorkEntryRows(ws.id, [{ id: 'a', createdAt: T0 }])),
        rejection(touchAllWorkEntries(ws.id)),
        rejection(updateWorkEntryRegistry(ws.id, () => Promise.resolve([]))),
        rejection(readWorkEntryRegistryRowState(ws.id, 'a')),
        rejection(listWorkEntries(ws.id, { strictRead: true })),
        rejection(listWorkEntryChatSummaries(ws.id, { strictRead: true })),
      ]);
      expect(new Set(refusals)).toEqual(
        new Set([
          corrupt.startsWith('{not')
            ? expect.stringContaining('JSON')
            : 'Invalid work-entry registry',
        ]),
      );
      expect(await raw(ws)).toBe(corrupt);
      await expect(listWorkEntries(ws.id)).resolves.toEqual([]);
      await expect(listWorkEntryChatSummaries(ws.id)).resolves.toEqual([]);
      await expect(listWorkEntryIds(ws.id)).resolves.toEqual([]);
      await expect(workEntryRegistryExists(ws.id)).resolves.toBe(true);
    }
    expect(listChanged).toEqual([]);
    expect(groupPublishes).toEqual([]);
    expect(await strays(ws)).toEqual([]);
  });

  test('a tombstone fences every write until reactivation', async () => {
    const a = { id: 'a', createdAt: T0 };
    await seed(ws, bytes([a]));
    await clearWorkEntrySummariesForWorkspace(ws.id);
    const deleted = `Work Entry project has been deleted: ${ws.id}`;
    expect(await rejection(createWorkEntry(ws.id, { id: 'b' }))).toBe(deleted);
    expect(await rejection(updateWorkEntry(ws.id, 'a', { pinned: true }))).toBe(
      deleted,
    );
    expect(await rejection(removeWorkEntryRow(ws.id, 'a'))).toBe(deleted);
    expect(
      await rejection(
        updateWorkEntryRegistry(ws.id, (rows) => Promise.resolve(rows)),
      ),
    ).toBe(deleted);
    await syncWorkEntrySummaryFromWrite(ws.id, 'a', {
      version: 1,
      activeTabId: '',
      tabs: [],
    });
    await expect(listWorkEntries(ws.id)).resolves.toEqual([]);
    expect(await raw(ws)).toBe(bytes([a]));
    expect(listChanged).toEqual([]);

    activateWorkEntryWorkspace(ws.id);
    await createWorkEntry(ws.id, { id: 'b' });
    expect(await raw(ws)).toBe(
      bytes([{ id: 'b', createdAt: T0, lastTouchedAt: T0 }, a]),
    );
    expect(listChanged).toEqual([ws.id]);
    expect(groupPublishes).toHaveLength(1);
  });

  test('a tombstone during an install keeps the bytes and refuses the queue', async () => {
    const a = { id: 'a', createdAt: T0 };
    await seed(ws, bytes([a]));
    const rename = AtomicFile.renameWithRetry;
    let cleared: Promise<void> | undefined;
    jest
      .spyOn(AtomicFile, 'renameWithRetry')
      .mockImplementation(async (...args) => {
        await rename(...args);
        cleared ??= clearWorkEntrySummariesForWorkspace(ws.id);
      });
    const rollbacks: string[] = [];
    reconciler.plan = {
      rollback: (): Promise<void> => {
        rollbacks.push('rollback');
        return Promise.resolve();
      },
    };
    const deleted = `Work Entry project has been deleted: ${ws.id}`;
    const settled = Promise.all([
      rejection(updateWorkEntry(ws.id, 'a', { pinned: true })),
      rejection(removeWorkEntryRow(ws.id, 'a')),
    ]);
    expect(await settled).toEqual([deleted, deleted]);
    await cleared;
    // The installed write stays and its group is still rolled back.
    expect(await raw(ws)).toBe(
      bytes([{ ...a, hasUserChanges: true, pinned: true }]),
    );
    expect(rollbacks).toEqual(['rollback']);
    expect(reconciler.calls).toHaveLength(1);
    expect(groupPublishes).toEqual([]);
    expect(listChanged).toEqual([]);
    activateWorkEntryWorkspace(ws.id);
  });

  test('summary sync and stamp refresh persist under the registry lock', async () => {
    const a = { id: 'a', createdAt: T0 };
    await seed(ws, bytes([a]));
    const tabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Hello',
          createdAt: T0,
          providerType: 'claude',
          messages: [],
        },
      ],
    };
    await syncWorkEntrySummaryFromWrite(ws.id, 'missing', tabs);
    await syncWorkEntrySummaryFromWrite(ws.id, 'a', tabs, () => false);
    // Superseded at the install check: swallowed, nothing installed.
    let checks = 0;
    await syncWorkEntrySummaryFromWrite(ws.id, 'a', tabs, () => ++checks < 4);
    expect(checks).toBe(4);
    expect(await raw(ws)).toBe(bytes([a]));
    expect(await strays(ws)).toEqual([]);
    await syncWorkEntrySummaryFromWrite(ws.id, 'a', tabs);
    const before = await raw(ws);
    expect(before).toBe(
      bytes([
        {
          ...a,
          summary: {
            version: 1,
            title: 'Hello',
            providerType: 'claude',
            chatCount: 1,
            chats: [
              {
                id: 'chat-1',
                title: 'Hello',
                createdAt: T0,
                lastMessageAt: T0,
                providerType: 'claude',
                pluginSelections: {
                  collectionIds: [],
                  skillRefs: [],
                  pluginRefs: [],
                },
              },
            ],
            sourceMtimeNs: 'missing',
          },
        },
      ]),
    );
    await syncWorkEntrySummaryFromWrite(ws.id, 'a', tabs);
    expect(await raw(ws)).toBe(before);

    await refreshWorkEntrySummaryStamp(ws.id, 'a', {
      previousMtimeNs: '1',
      mtimeNs: '2',
    });
    expect(await raw(ws)).toBe(before);
    await refreshWorkEntrySummaryStamp(ws.id, 'a', {
      previousMtimeNs: 'missing',
      mtimeNs: '42',
    });
    expect(await raw(ws)).toBe(
      before.replace('"sourceMtimeNs": "missing"', '"sourceMtimeNs": "42"'),
    );
    await seed(ws, '{not json');
    await refreshWorkEntrySummaryStamp(ws.id, 'a', {
      previousMtimeNs: '42',
      mtimeNs: '43',
    });
    expect(await raw(ws)).toBe('{not json');
    expect(listChanged).toEqual([]);
    expect(groupPublishes).toHaveLength(2);
  });

  test('a create compensates a post-install refusal with its parsed read', async () => {
    // Normalizing parse: `pinned: false` and the trailing newline are dropped.
    const a = { id: 'a', createdAt: T0, pinned: false };
    await seed(ws, `${bytes([a])}\n`);
    let calls = 0;
    expect(
      await rejection(
        createWorkEntry(ws.id, {
          id: 'b',
          assertCanCommit: () => {
            calls += 1;
            if (calls === 3) throw new Error('retired after install');
          },
        }),
      ),
    ).toBe('retired after install');
    expect(await raw(ws)).toBe(bytes([{ id: 'a', createdAt: T0 }]));
    expect(reconciler.calls.map((call) => call.ids)).toEqual([
      ['b', 'a'],
      ['a'],
    ]);
    expect(groupPublishes).toHaveLength(2);
    expect(listChanged).toEqual([]);
    expect(await strays(ws)).toEqual([]);
  });

  test('a refused install rolls the group back, or reports both failures', async () => {
    const a = { id: 'a', createdAt: T0 };
    await seed(ws, bytes([a]));
    const rename = AtomicFile.renameWithRetry;
    const sources: string[] = [];
    jest
      .spyOn(AtomicFile, 'renameWithRetry')
      .mockImplementation(async (...args) => {
        if (!args[1].endsWith('/work-entries.json')) return rename(...args);
        sources.push(args[0]);
        throw Object.assign(new Error('registry EACCES'), { code: 'EACCES' });
      });
    const rollbacks: string[] = [];
    reconciler.plan = {
      rollback: (): Promise<void> => {
        rollbacks.push('rollback');
        return Promise.resolve();
      },
    };
    expect(await rejection(createWorkEntry(ws.id, { id: 'b' }))).toBe(
      'registry EACCES',
    );
    expect(rollbacks).toEqual(['rollback']);

    reconciler.plan = {
      rollback: (): Promise<void> =>
        Promise.reject(new Error('group rollback')),
    };
    let composite: unknown;
    try {
      await updateWorkEntry(ws.id, 'a', { pinned: true });
    } catch (error) {
      composite = error;
    }
    expect(composite).toBeInstanceOf(Error);
    expect(composite).toMatchObject({
      message: 'Registry write and group rollback failed',
      errors: [
        expect.objectContaining({ message: 'registry EACCES' }),
        expect.objectContaining({ message: 'group rollback' }),
      ],
    });
    expect(sources).toHaveLength(2);
    for (const source of sources)
      expect(source).toMatch(/[/\\]\.work-entries-[0-9a-f-]{36}\.tmp$/);
    expect(await raw(ws)).toBe(bytes([a]));
    expect(await strays(ws)).toEqual([]);
    expect(listChanged).toEqual([]);
  });

  test('lists backfill missing summaries into the registry', async () => {
    const a = { id: 'a', title: 'Kept', createdAt: T0 };
    await seed(ws, bytes([a]));
    await expect(listWorkEntries(ws.id)).resolves.toEqual([
      {
        id: 'a',
        hasUserChanges: true,
        title: 'Kept',
        createdAt: T0,
        chatCount: 0,
      },
    ]);
    expect(await raw(ws)).toBe(bytes([{ ...a, summary: MISSING_SUMMARY }]));
    expect(groupPublishes).toHaveLength(1);
    await expect(
      listWorkEntryChatSummaries(ws.id, { strict: true }),
    ).resolves.toEqual([
      { entryId: 'a', title: 'Kept', order: 0, createdAt: T0, chats: [] },
    ]);
  });
});

test('the home migration moves the advisor registry byte for byte', async () => {
  const legacy = join(dataRoot, 'workspaces', 'app-advisor');
  const registry = `${bytes([{ id: 'moved', createdAt: T0 }])}\n`;
  const stray = '.work-entries-00000000-0000-4000-8000-000000000000.tmp';
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'work-entries.json'), registry, 'utf8');
  await writeFile(join(legacy, stray), 'partial', 'utf8');
  await writeFile(join(legacy, 'notes.md'), 'user file', 'utf8');
  // A destination conflict keeps both registries where they are.
  const conflictLegacy = join(
    dataRoot,
    'workspaces',
    PLAN_EXPLORE_CHAT_PROJECT_ID,
  );
  const conflictRoot = join(
    dataRoot,
    'app-workspaces',
    PLAN_EXPLORE_CHAT_PROJECT_ID,
  );
  for (const [directory, id] of [
    [conflictLegacy, 'legacy'],
    [conflictRoot, 'current'],
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'work-entries.json'),
      bytes([{ id, createdAt: T0 }]),
      'utf8',
    );
  }
  registerWorkspaceTypes(new Map());
  await migrateAppManagedChatWorkspaces();
  for (const [directory, id] of [
    [conflictLegacy, 'legacy'],
    [conflictRoot, 'current'],
  ])
    expect(await readFile(join(directory, 'work-entries.json'), 'utf8')).toBe(
      bytes([{ id, createdAt: T0 }]),
    );
  const root = join(dataRoot, 'app-workspaces', 'app-advisor');
  expect(await readFile(join(root, 'work-entries.json'), 'utf8')).toBe(
    registry,
  );
  expect((await readdir(root)).sort()).toEqual(
    [stray, 'home', 'work-entries.json'].sort(),
  );
  expect(await readdir(join(root, 'home'))).toEqual(['notes.md']);
  await expect(stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(listWorkEntryIds('app-advisor')).resolves.toEqual(['moved']);
});

describe('bundle export and import', () => {
  function handler(channel: string): (request: object) => Promise<unknown> {
    const call = jest
      .mocked(registerIpcHandler)
      .mock.calls.find(([registered]) => registered === channel);
    const registered = call?.[1];
    if (typeof registered !== 'function')
      throw new Error(`No handler for ${channel}`);
    return (request) =>
      Promise.resolve(
        Reflect.apply(registered, undefined, [undefined, request]),
      );
  }
  beforeAll(() => {
    registerStandaloneChatHandlers();
  });

  test('export copies the registry bytes; import preflight refuses bad registries', async () => {
    const ws = workspace('cowork');
    const registry = `${bytes([{ id: 'a', createdAt: T0, pinned: false }])}\n`;
    await seed(ws, registry);
    await writeFile(
      join(ws.root, 'workspace.json'),
      JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
      'utf8',
    );
    const destination = join(dataRoot, '..', 'exports');
    await mkdir(destination, { recursive: true });
    const exported = await handler(IPC_CHANNELS.standaloneChatExportProject)({
      projectId: ws.id,
      destinationPath: destination,
    });
    expect(exported).toEqual({
      exportedPath: join(destination, `${ws.id}-export`),
    });
    const bundle = join(destination, `${ws.id}-export`);
    expect(await readFile(join(bundle, 'work-entries.json'), 'utf8')).toBe(
      registry,
    );
    expect(await raw(ws)).toBe(registry);

    const importProject = handler(IPC_CHANNELS.standaloneChatImportProject);
    const { project } = z
      .object({ project: z.object({ id: z.string() }) })
      .parse(await importProject({ sourcePath: bundle }));
    expect(project.id).not.toBe(ws.id);
    const importedRoot = join(dataRoot, 'workspaces', project.id);
    expect(
      await readFile(join(importedRoot, 'work-entries.json'), 'utf8'),
    ).toBe(registry);
    await expect(listWorkEntryIds(project.id)).resolves.toEqual(['a']);
    const before = (await readdir(join(dataRoot, 'workspaces'))).sort();
    await writeFile(join(bundle, 'work-entries.json'), '{"version":2}', 'utf8');
    expect(await rejection(importProject({ sourcePath: bundle }))).toBe(
      'Invalid work-entry registry',
    );
    await rm(join(bundle, 'work-entries.json'));
    await symlink(registryPath(ws), join(bundle, 'work-entries.json'));
    expect(await rejection(importProject({ sourcePath: bundle }))).toBe(
      'Imported project bundles cannot contain symlinks',
    );
    expect((await readdir(join(dataRoot, 'workspaces'))).sort()).toEqual(
      before,
    );
  });
});
