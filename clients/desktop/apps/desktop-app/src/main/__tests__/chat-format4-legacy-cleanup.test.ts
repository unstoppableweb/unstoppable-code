/**
 * Legacy chat files after format 4 (CAN-7178 follow-up 2). The sweep offers a
 * legacy scope that has no tabs file left, and no legacy file or backup is
 * deleted until the scope's format 4 copy has been published and read back:
 * a fault anywhere before that leaves every one byte-identical, through an
 * ordinary open as well as the sweep. Cleanup then removes only the scope's
 * own enumerated files, never through a symlink and never outside the scope.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type * as FsModule from 'node:fs';
import type * as FsPromisesModule from 'node:fs/promises';
import type * as FsyncDirectoryModule from '../lib/fsync-directory';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PLAN_EXPLORE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { readErrorClassification } from '@canopy/protocol/app-errors/classification';
import {
  ChatStorageV2,
  type ChatMigrationCheckpoint,
} from '../lib/chat-storage-v2';
import {
  promoteToFormat4Journal,
  type DeltaJournalBoundary,
} from '../lib/chat-delta-journal/writer';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type { ChatScopeKey } from '../services/chat-state-contracts';
import {
  ChatFormat4Sweep,
  chatFormat4SweepComplete,
  repositoryChatFormat4SweepTarget,
} from '../services/chat-format4-sweep';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import {
  drainAfterTest,
  drainOpenRepositories,
} from './helpers/chat-delta-journal-scope';

/** One armed fault in the delete order; the faulting call throws. */
const mockDeleteFault: {
  step?: { kind: 'unlink' | 'manifest' | 'directory'; count: number };
  unlinks: number;
  manifestPath?: string;
  directory?: string;
} = { unlinks: 0 };

/** When set, copying a file with this suffix into recovery evidence fails. */
const mockCopyFault: { suffix?: string } = {};

/** Folder syncs and manifest removals, in order, for the retry golden. */
const mockSyncLog: string[] = [];

jest.mock('../lib/fsync-directory', () => {
  const actual = jest.requireActual<typeof FsyncDirectoryModule>(
    '../lib/fsync-directory',
  );
  return {
    ...actual,
    fsyncDirectory: async (path: string): Promise<void> => {
      mockSyncLog.push(`sync:${path}`);
      await actual.fsyncDirectory(path);
    },
  };
});

/** Every file opened for hashing, so a test can see what cleanup read. */
const mockReadLog: string[] = [];

jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof FsModule>('node:fs');
  return {
    ...actual,
    createReadStream: (
      ...args: Parameters<typeof actual.createReadStream>
    ): ReturnType<typeof actual.createReadStream> => {
      if (typeof args[0] === 'string') mockReadLog.push(args[0]);
      return actual.createReadStream(...args);
    },
  };
});

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  return {
    ...actual,
    copyFile: async (
      source: Parameters<typeof actual.copyFile>[0],
      target: Parameters<typeof actual.copyFile>[1],
      mode?: Parameters<typeof actual.copyFile>[2],
    ): Promise<void> => {
      if (
        mockCopyFault.suffix !== undefined &&
        typeof source === 'string' &&
        source.endsWith(mockCopyFault.suffix)
      )
        throw Object.assign(new Error('no space left on device'), {
          code: 'ENOSPC',
        });
      await actual.copyFile(source, target, mode);
    },
    unlink: async (
      path: Parameters<typeof actual.unlink>[0],
    ): Promise<void> => {
      const step = mockDeleteFault.step;
      if (step?.kind === 'unlink' && mockDeleteFault.unlinks >= step.count)
        throw new Error('fault in the delete');
      await actual.unlink(path);
      if (step?.kind === 'unlink') mockDeleteFault.unlinks += 1;
    },
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ): Promise<void> => {
      if (typeof path === 'string') mockSyncLog.push(`rm:${path}`);
      const step = mockDeleteFault.step;
      if (
        (step?.kind === 'manifest' && path === mockDeleteFault.manifestPath) ||
        (step?.kind === 'directory' && path === mockDeleteFault.directory)
      )
        throw new Error('fault in the delete');
      return actual.rm(path, options);
    },
  };
});

jest.setTimeout(120_000);

const SCOPE: ChatScopeKey = { projectId: 'project', worktreeId: 'scope' };
const PLAN: ChatScopeKey = {
  projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
  worktreeId: 'plan',
};

let dataDir: string;
let outside: string;
let promotion = true;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'format4-legacy-cleanup-'));
  outside = await mkdtemp(join(tmpdir(), 'format4-legacy-outside-'));
  process.env.CANOPY_DATA_DIR = dataDir;
  resetResolvedCanopyDataDirForTests();
  promotion = true;
});

afterEach(async () => {
  jest.restoreAllMocks();
  mockCopyFault.suffix = undefined;
  await drainOpenRepositories();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(dataDir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** The file families the canonical resolver gives each scope kind. */
function pathsFor(scope: ChatScopeKey): {
  tabs: string;
  archives: string;
  journal: string;
} {
  if (scope.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID)
    return {
      tabs: join(dataDir, 'plan-explore-chats', `${scope.worktreeId}.json`),
      archives: join(
        dataDir,
        'workspaces',
        PLAN_EXPLORE_CHAT_PROJECT_ID,
        'chat-archives',
        `${scope.worktreeId}.json`,
      ),
      journal: join(dataDir, 'chat-journals', `${scope.worktreeId}.jsonl`),
    };
  const root = join(dataDir, 'workspaces', scope.projectId);
  return {
    tabs: join(root, 'chats', `${scope.worktreeId}.json`),
    archives: join(root, 'chat-archives', `${scope.worktreeId}.json`),
    journal: join(root, 'chat-journals', `${scope.worktreeId}.jsonl`),
  };
}

const storeFor = (scope: ChatScopeKey = SCOPE): ChatStorageV2 =>
  ChatStorageV2.fromLegacyPaths(pathsFor(scope));

/** The scope's six legacy files: each family and its backup. */
function legacyFamily(scope: ChatScopeKey = SCOPE): string[] {
  const { tabs, archives, journal } = pathsFor(scope);
  return [tabs, archives, journal].flatMap((path) => [path, `${path}.bak`]);
}

function tab(id: string, text: string): PersistedChatTab {
  return {
    id,
    title: id,
    createdAt: '2026-11-12T00:00:00Z',
    messages: [
      {
        id: `${id}-m1`,
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text }],
      },
    ],
  };
}

function tabsFile(tabs: PersistedChatTab[]): string {
  return JSON.stringify({ version: 1, activeTabId: tabs[0]?.id, tabs }) + '\n';
}

function archivesFile(tabs: PersistedChatTab[]): string {
  return (
    JSON.stringify({
      version: 1,
      archived: tabs.map((entry) => ({
        tab: entry,
        archivedAt: entry.createdAt,
        turnCount: 1,
      })),
    }) + '\n'
  );
}

function journalFile(tabs: PersistedChatTab[]): string {
  return tabs
    .map(
      (entry, index) =>
        JSON.stringify({
          v: 1,
          revision: index + 1,
          mutationId: `create-${entry.id}`,
          occurredAt: entry.createdAt,
          source: 'migration',
          mutations: [{ type: 'tab.created', tab: entry }],
        }) + '\n',
    )
    .join('');
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** A legacy scope with every family and every backup present. */
async function seedFullLegacy(scope: ChatScopeKey = SCOPE): Promise<void> {
  const { tabs, archives, journal } = pathsFor(scope);
  await put(tabs, tabsFile([tab('live', 'Live chat')]));
  await put(`${tabs}.bak`, tabsFile([tab('live', 'Live chat')]));
  await put(archives, archivesFile([tab('old', 'Archived chat')]));
  await put(`${archives}.bak`, archivesFile([tab('old', 'Archived chat')]));
  await put(journal, '');
  await put(`${journal}.bak`, '');
}

/** Each legacy file that exists, by path, with its bytes. */
async function legacyBytes(
  paths: readonly string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const path of paths)
    out[path] = await readFile(path, 'utf8').catch(() => null);
  return out;
}

async function absent(path: string): Promise<boolean> {
  return lstat(path).then(
    () => false,
    () => true,
  );
}

function repository(
  options: {
    onBoundary?: (point: DeltaJournalBoundary) => Promise<void>;
  } = {},
): ChatStateV2Repository {
  return drainAfterTest(
    new ChatStateV2Repository({
      resolvePaths: pathsFor,
      enableFormat4: true,
      format4Promotion: () => promotion,
      deltaJournalIncrementalStreamMetadata: true,
      deltaJournalIdleCheckpointMs: 60_000,
      idleScopeUnloadMs: 0,
      ...(options.onBoundary
        ? { deltaJournalOnBoundary: options.onBoundary }
        : {}),
    }),
  );
}

/** Every chat the scope reads back, live and archived, with its message text. */
async function chatsOf(
  scope: ChatScopeKey = SCOPE,
): Promise<Record<string, string[]>> {
  const target = repository();
  try {
    const listed = await target.getState(scope);
    const state = await target.getState(scope, {
      chatIds: [
        ...listed.tabsFile.tabs.map((entry) => entry.id),
        ...listed.archivesFile.archived.map((archived) => archived.tab.id),
      ],
      fullTranscript: true,
    });
    const out: Record<string, string[]> = {};
    for (const entry of [
      ...state.tabsFile.tabs,
      ...state.archivesFile.archived.map((archived) => archived.tab),
    ])
      out[entry.id] = entry.messages.flatMap((row) =>
        row.blocks.flatMap((block) =>
          block.type === 'text' ? [block.text] : [],
        ),
      );
    return out;
  } finally {
    await target.drainAll();
  }
}

async function sweepPass(target: ChatStateV2Repository): Promise<string> {
  const result = await new ChatFormat4Sweep({
    dataDir,
    target: {
      ...repositoryChatFormat4SweepTarget(target, () => promotion),
      sweepAllowed: (): boolean => true,
    },
    resolveStore: storeFor,
    conditions: {
      turnInFlight: (): boolean => false,
      idleMs: (): number => Number.MAX_SAFE_INTEGER,
      onBattery: (): boolean => false,
      freeBytes: (): Promise<number | undefined> => Promise.resolve(1024 ** 4),
    },
    clock: {
      now: (): number => 0,
      sleep: (): Promise<void> => Promise.resolve(),
    },
  }).runPass();
  return result.status;
}

type Route = 'open' | 'sweep';

/** One ordinary open, or one sweep pass, over the scope. Faults are allowed. */
async function visit(
  route: Route,
  target: ChatStateV2Repository,
  scope: ChatScopeKey = SCOPE,
): Promise<void> {
  if (route === 'open') await target.getState(scope).catch(() => undefined);
  else await sweepPass(target).catch(() => undefined);
  await target.drainAll().catch(() => undefined);
}

describe('legacy scopes with no tabs file reach format 4 (part A)', () => {
  const kinds: Array<
    [string, ChatScopeKey, (scope: ChatScopeKey) => Promise<void>, string[]]
  > = [
    [
      'archives only',
      SCOPE,
      (scope) =>
        put(pathsFor(scope).archives, archivesFile([tab('old', 'Archived')])),
      ['old'],
    ],
    [
      'journal only',
      SCOPE,
      (scope) =>
        put(pathsFor(scope).journal, journalFile([tab('journaled', 'Hi')])),
      ['journaled'],
    ],
    [
      'tabs backup only',
      SCOPE,
      (scope) =>
        put(`${pathsFor(scope).tabs}.bak`, tabsFile([tab('backed', 'Kept')])),
      ['backed'],
    ],
    [
      'a plan with its tabs backup only',
      PLAN,
      (scope) =>
        put(`${pathsFor(scope).tabs}.bak`, tabsFile([tab('plan-tab', 'Plan')])),
      ['plan-tab'],
    ],
    [
      'a plan with its journal only',
      PLAN,
      (scope) =>
        put(pathsFor(scope).journal, journalFile([tab('plan-j', 'Plan')])),
      ['plan-j'],
    ],
  ];

  it.each(kinds)(
    '%s: the sweep offers it, it reaches format 4 with every chat, and the sweep completes',
    async (_name, scope, seed, ids) => {
      await seed(scope);
      const target = repository();
      expect(await sweepPass(target)).toBe('complete');
      await target.drainAll();
      expect(await storeFor(scope).format()).toBe('v4');
      expect(Object.keys(await chatsOf(scope)).sort()).toEqual(ids);
      expect(await chatFormat4SweepComplete(dataDir)).toBe(true);
    },
  );
});

const CHECKPOINTS: ChatMigrationCheckpoint[] = [
  'staged',
  'validated',
  'promoted',
  'manifest',
  'cleaned',
];

/** The delta-journal boundaries a clean open from legacy to format 4 crosses. */
async function boundariesOnTheWay(): Promise<DeltaJournalBoundary[]> {
  const root = await mkdtemp(join(tmpdir(), 'format4-legacy-boundaries-'));
  const saved = dataDir;
  dataDir = root;
  const reached = new Set<DeltaJournalBoundary>();
  try {
    await seedFullLegacy();
    const target = repository({
      onBoundary: (point) => {
        reached.add(point);
        return Promise.resolve();
      },
    });
    await target.getState(SCOPE);
    await target.drainAll();
    expect(await storeFor().format()).toBe('v4');
  } finally {
    dataDir = saved;
    await rm(root, { recursive: true, force: true });
  }
  return Array.from(reached).sort();
}

type Fault =
  | { kind: 'checkpoint'; point: ChatMigrationCheckpoint }
  | { kind: 'boundary'; point: DeltaJournalBoundary }
  | { kind: 'readback' };

const label = (fault: Fault): string =>
  fault.kind === 'readback' ? 'readback' : `${fault.kind}:${fault.point}`;

/** Arm a single fault, and return the repository the faulting visit uses. */
function armed(fault: Fault): ChatStateV2Repository {
  if (fault.kind === 'checkpoint') {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with call(this) below.
    const migrate = ChatStorageV2.prototype.migrate;
    jest.spyOn(ChatStorageV2.prototype, 'migrate').mockImplementation(function (
      this: ChatStorageV2,
      factory,
      _checkpoint,
      options,
    ) {
      return migrate.call(
        this,
        factory,
        (point) =>
          point === fault.point
            ? Promise.reject(new Error(`fault at ${point}`))
            : Promise.resolve(),
        options,
      );
    });
    return repository();
  }
  if (fault.kind === 'readback') {
    const proto = ChatStateV2Backend.prototype as unknown as {
      loadIndexes: (this: ChatStateV2Backend) => Promise<unknown>;
    };
    const original = proto.loadIndexes;
    let fired = false;
    jest.spyOn(proto, 'loadIndexes').mockImplementation(async function (
      this: ChatStateV2Backend,
    ) {
      const store = (this as unknown as { store: ChatStorageV2 }).store;
      if (!fired && (await store.format()) === 'v4') {
        fired = true;
        throw new Error('fault at the format 4 readback');
      }
      return original.call(this);
    });
    return repository();
  }
  let fired = false;
  return repository({
    onBoundary: (point) => {
      if (fired || point !== fault.point) return Promise.resolve();
      fired = true;
      return Promise.reject(new Error(`fault at ${point}`));
    },
  });
}

describe('no legacy file is deleted before format 4 reads back (part B, G6 and G8)', () => {
  let faults: Fault[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'format4-legacy-cleanup-'));
    faults = [
      ...CHECKPOINTS.map((point): Fault => ({ kind: 'checkpoint', point })),
      ...(await boundariesOnTheWay()).map(
        (point): Fault => ({ kind: 'boundary', point }),
      ),
      { kind: 'readback' },
    ];
    await rm(dataDir, { recursive: true, force: true });
  });

  it('the matrix covers the migration, at least one format 4 boundary, and the readback', () => {
    expect(faults.filter((fault) => fault.kind === 'boundary').length).toBe(
      faults.length - CHECKPOINTS.length - 1,
    );
    expect(faults.some((fault) => fault.kind === 'boundary')).toBe(true);
  });

  for (const route of ['open', 'sweep'] as const)
    it(`a fault at each point, through ${route === 'open' ? 'an ordinary open' : 'the sweep'}, leaves every legacy file byte-identical; the next visit recovers every chat and only then removes them`, async () => {
      const failures: string[] = [];
      for (const fault of faults) {
        await rm(dataDir, { recursive: true, force: true });
        await mkdir(dataDir, { recursive: true });
        await seedFullLegacy();
        const before = await legacyBytes(legacyFamily());
        await visit(route, armed(fault));
        jest.restoreAllMocks();
        const afterFault = await legacyBytes(legacyFamily());
        const format = await storeFor()
          .format()
          .catch(() => 'unreadable');
        // Only a format 4 copy the faulting visit itself read back may have
        // let cleanup run: a boundary fault the backend recovered from.
        const mayHaveCleaned = format === 'v4' && fault.kind === 'boundary';
        if (
          !mayHaveCleaned &&
          JSON.stringify(afterFault) !== JSON.stringify(before)
        )
          failures.push(`${label(fault)}: legacy changed while ${format}`);
        await visit(route, repository());
        if ((await storeFor().format()) !== 'v4')
          failures.push(`${label(fault)}: did not reach format 4 afterwards`);
        const chats = await chatsOf();
        if (
          JSON.stringify(chats) !==
          JSON.stringify({ live: ['Live chat'], old: ['Archived chat'] })
        )
          failures.push(`${label(fault)}: chats ${JSON.stringify(chats)}`);
        for (const path of legacyFamily())
          if (!(await absent(path)))
            failures.push(`${label(fault)}: ${path} left after format 4`);
      }
      expect(failures).toEqual([]);
    });
});

describe('cleanup after format 4 verifies (G7)', () => {
  it('a format 4 scope that still has its legacy files loses those migration read on its next open, keeps a journal backup no migration preserved, and touches nothing else', async () => {
    const store = storeFor();
    await store.migrate(
      scopeSource([{ id: 'chat', messages: [message('m1', 'Hello', 'user')] }]),
    );
    const backend = new ChatStateV2Backend(store, {
      enableFormat4: true,
      deltaJournal: {},
    });
    await backend.promoteToDeltaJournal();
    backend.releaseJournal();
    await promoteToFormat4Journal(store);
    expect(await store.format()).toBe('v4');
    await seedFullLegacy();
    const { tabs } = pathsFor(SCOPE);
    const sibling = `${tabs}.keep`;
    const otherScope = join(dirname(tabs), 'other.json');
    await put(sibling, 'not ours');
    await put(otherScope, tabsFile([tab('other', 'Other scope')]));

    const target = repository();
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs.map((entry) => entry.id),
    ).toEqual(['chat']);
    await target.drainAll();
    // This store was built from a synthetic source, so its evidence holds no
    // copy of the journal backup: cleanup must refuse it (SWAN 03:08).
    const { journal } = pathsFor(SCOPE);
    for (const path of legacyFamily())
      expect([path, await absent(path)]).toEqual([
        path,
        path !== `${journal}.bak`,
      ]);
    expect(await readFile(sibling, 'utf8')).toBe('not ours');
    expect(await readFile(otherScope, 'utf8')).toBe(
      tabsFile([tab('other', 'Other scope')]),
    );
  });
});

describe('the format 4 switch decides when legacy files go (SWAN 12:48, option C)', () => {
  it('switch off: an ordinary open validates version 2 and removes all six legacy files, with every chat kept', async () => {
    promotion = false;
    await seedFullLegacy();
    expect(await chatsOf()).toEqual({
      live: ['Live chat'],
      old: ['Archived chat'],
    });
    expect(await storeFor().format()).toBe('v3');
    for (const path of legacyFamily())
      expect([path, await absent(path)]).toEqual([path, true]);
  });

  it('every caller other than the repository load removes them at version 2 validation, as before', async () => {
    await seedFullLegacy();
    await migrateOnly();
    expect(await storeFor().format()).toBe('v2');
    for (const path of legacyFamily())
      expect([path, await absent(path)]).toEqual([path, true]);
  });

  it('switch off: a crash after the version 2 manifest but before deletion finishes the deletion on the next open', async () => {
    promotion = false;
    await seedFullLegacy();
    await visit('open', armed({ kind: 'checkpoint', point: 'manifest' }));
    jest.restoreAllMocks();
    for (const path of legacyFamily()) expect(await absent(path)).toBe(false);
    expect(Object.keys(await chatsOf()).sort()).toEqual(['live', 'old']);
    for (const path of legacyFamily())
      expect([path, await absent(path)]).toEqual([path, true]);
  });

  it('switch on: the legacy files stay through every open until format 4 reads back', async () => {
    await seedFullLegacy();
    const before = await legacyBytes(legacyFamily());
    const stay = jest
      .spyOn(ChatStateV2Backend.prototype, 'promoteToFormat4')
      .mockResolvedValue(false);
    await visit('open', repository());
    await visit('open', repository());
    expect(await storeFor().format()).toBe('v3');
    expect(await legacyBytes(legacyFamily())).toEqual(before);
    stay.mockRestore();
    await visit('open', repository());
    expect(await storeFor().format()).toBe('v4');
    for (const path of legacyFamily()) expect(await absent(path)).toBe(true);
  });

  it('a version 2 scope that keeps its legacy files never validates its copy a second time (G9)', async () => {
    await seedFullLegacy();
    const before = await legacyBytes(legacyFamily());
    await migrateOnly({ retainLegacy: true });
    expect(await storeFor().format()).toBe('v2');
    expect(await legacyBytes(legacyFamily())).toEqual(before);
    const validate = jest.spyOn(
      ChatStorageV2.prototype as unknown as { validate: () => Promise<void> },
      'validate',
    );
    await migrateOnly({ retainLegacy: true });
    await migrateOnly();
    expect(validate).not.toHaveBeenCalled();
    expect(await legacyBytes(legacyFamily())).toEqual(before);
  });
});

/** Version 2 migration alone, as a caller other than the repository load runs it. */
async function migrateOnly(
  options: { retainLegacy?: boolean } = {},
): Promise<void> {
  const { migrateLegacyChatScope } =
    await import('../lib/legacy-chat-migration');
  await migrateLegacyChatScope(storeFor(), pathsFor(SCOPE), options);
}

describe('an unopened legacy scope the sweep promotes (CAN-7178 PR 1b, security ruling S1)', () => {
  it('keeps a backup that is a symlink to a file outside the data folder: the link stays, its target is untouched, and the scope still reaches format 4', async () => {
    promotion = true;
    await seedFullLegacy();
    const { tabs } = pathsFor(SCOPE);
    const target = join(outside, 'target.json');
    await writeFile(target, tabsFile([tab('live', 'Live chat')]));
    await rm(`${tabs}.bak`);
    await symlink(target, `${tabs}.bak`);

    await visit('sweep', repository());
    expect(await storeFor().format()).toBe('v4');
    expect((await lstat(`${tabs}.bak`)).isSymbolicLink()).toBe(true);
    expect(await readlink(`${tabs}.bak`)).toBe(target);
    expect(await readFile(target, 'utf8')).toBe(
      tabsFile([tab('live', 'Live chat')]),
    );
    expect(await absent(tabs)).toBe(true);
    expect(Object.keys(await chatsOf())).toEqual(
      expect.arrayContaining(['live', 'old']),
    );
  });
});

describe.each([
  ['switch on, after format 4 reads back', true, 'v4'],
  ['switch off, at version 2 validation', false, 'v3'],
] as const)(
  'cleanup never follows a link or leaves the scope (SWAN condition 3, CAN-7265): %s',
  (_name, switchOn, reached) => {
    beforeEach(() => {
      promotion = switchOn;
    });

    it('a legacy backup that is a symlink to a file outside the data folder is refused: the link stays and its target is untouched', async () => {
      await seedFullLegacy();
      const { tabs } = pathsFor(SCOPE);
      const target = join(outside, 'target.json');
      await writeFile(target, tabsFile([tab('live', 'Live chat')]));
      await rm(`${tabs}.bak`);
      await symlink(target, `${tabs}.bak`);

      await visit('open', repository());
      expect(await storeFor().format()).toBe(reached);
      expect((await lstat(`${tabs}.bak`)).isSymbolicLink()).toBe(true);
      expect(await readlink(`${tabs}.bak`)).toBe(target);
      expect(await readFile(target, 'utf8')).toBe(
        tabsFile([tab('live', 'Live chat')]),
      );
      expect(await absent(tabs)).toBe(true);
    });

    it('a legacy folder that is a symlink to a folder outside the data folder is refused: nothing in it is deleted', async () => {
      await seedFullLegacy();
      const { journal } = pathsFor(SCOPE);
      const folder = dirname(journal);
      const elsewhere = join(outside, 'chat-journals');
      await mkdir(elsewhere, { recursive: true });
      await writeFile(join(elsewhere, 'scope.jsonl'), '');
      await writeFile(join(elsewhere, 'scope.jsonl.bak'), '');
      await rm(folder, { recursive: true });
      await symlink(elsewhere, folder);

      await visit('open', repository());
      expect(await storeFor().format()).toBe(reached);
      expect(await readFile(join(elsewhere, 'scope.jsonl'), 'utf8')).toBe('');
      expect(await readFile(join(elsewhere, 'scope.jsonl.bak'), 'utf8')).toBe(
        '',
      );
      expect(await absent(pathsFor(SCOPE).tabs)).toBe(true);
    });

    it('a sibling outside the six family files stays where it is, and migration already copied its bytes into the version 2 recovery evidence', async () => {
      await seedFullLegacy();
      const { tabs, journal } = pathsFor(SCOPE);
      const siblings = {
        [`${tabs}.0f3c.tmp`]: 'half-written tabs',
        [`${journal}.corrupt`]: 'unreadable journal copy',
      };
      for (const [path, text] of Object.entries(siblings))
        await put(path, text);

      await visit('open', repository());
      expect(await storeFor().format()).toBe(reached);
      for (const path of legacyFamily()) expect(await absent(path)).toBe(true);
      for (const [path, text] of Object.entries(siblings))
        expect([path, await readFile(path, 'utf8')]).toEqual([path, text]);

      const recovery = JSON.parse(
        await readFile(
          join(storeFor().directory, 'recovery-index.json'),
          'utf8',
        ),
      ) as {
        legacyEvidence?: Array<{ relativePath: string; sha256: string }>;
      };
      const copied = await Promise.all(
        (recovery.legacyEvidence ?? []).map((entry) =>
          readFile(join(storeFor().directory, entry.relativePath), 'utf8'),
        ),
      );
      for (const text of Object.values(siblings))
        expect(copied).toContain(text);
    });
  },
);

describe('an older release on a validated manifest with legacy files left (SWAN condition 2)', () => {
  it('a version 2 manifest marked validated never calls the source again and deletes nothing', async () => {
    await seedFullLegacy();
    await migrateOnly({ retainLegacy: true });
    const before = await legacyBytes(legacyFamily());
    const manifest = JSON.parse(
      await readFile(storeFor().manifestPath, 'utf8'),
    ) as { cleanupComplete: boolean };
    expect(manifest.cleanupComplete).toBe(true);
    const factory = jest.fn(() => Promise.reject(new Error('read the source')));
    await storeFor().migrate(factory);
    expect(factory).not.toHaveBeenCalled();
    expect(await legacyBytes(legacyFamily())).toEqual(before);
  });

  it('a format 4 manifest with legacy files left is never migrated or cleaned by the migration path', async () => {
    const store = storeFor();
    await store.migrate(
      scopeSource([{ id: 'chat', messages: [message('m1', 'Hello', 'user')] }]),
    );
    const backend = new ChatStateV2Backend(store, {
      enableFormat4: true,
      deltaJournal: {},
    });
    await backend.promoteToDeltaJournal();
    backend.releaseJournal();
    await promoteToFormat4Journal(store);
    await seedFullLegacy();
    const before = await legacyBytes(legacyFamily());
    const factory = jest.fn(() => Promise.reject(new Error('read the source')));
    await store.migrate(factory).catch(() => undefined);
    expect(factory).not.toHaveBeenCalled();
    expect(await legacyBytes(legacyFamily())).toEqual(before);
    expect(await store.format()).toBe('v4');
  });
});

/** Remove every chat, then delete the scope, as ChatStateService.deleteScope does. */
async function deleteScope(target: ChatStateV2Repository): Promise<void> {
  const current = await target.getState(SCOPE);
  if (current.tabsFile.tabs.length + current.archivesFile.archived.length > 0)
    await target.transactWith(
      SCOPE,
      (current) => [
        ...current.tabsFile.tabs.map((entry) => ({
          type: 'tab.removed' as const,
          tabId: entry.id,
        })),
        ...current.archivesFile.archived.map((entry) => ({
          type: 'archive.removed' as const,
          archiveEntryId: entry.tab.id,
          chatId: entry.tab.id,
        })),
      ],
      {
        source: 'migration',
        mutationId: `scope-delete:${Date.now()}`,
        checkpoint: true,
        allowDuringScopeDeletion: true,
      },
    );
  await target.deleteEmptyScope(SCOPE);
}

type Stage = 'v2' | 'v3';

/**
 * A scope at `stage` whose legacy files are still there, as the switch-on
 * window between version 2 validation and format 4 leaves it.
 */
async function midWindow(stage: Stage): Promise<void> {
  await seedFullLegacy();
  const holds = [
    jest
      .spyOn(ChatStateV2Backend.prototype, 'promoteToFormat4')
      .mockResolvedValue(false),
    ...(stage === 'v2'
      ? [
          jest
            .spyOn(ChatStateV2Backend.prototype, 'promoteToDeltaJournal')
            .mockResolvedValue(false),
        ]
      : []),
  ];
  await visit('open', repository());
  for (const hold of holds) hold.mockRestore();
  expect(await storeFor().format()).toBe(stage);
  for (const path of legacyFamily()) expect(await absent(path)).toBe(false);
}

/** Delete with `stage` held, so the deleting repository loads it there. */
async function deleteAt(stage: Stage): Promise<void> {
  const holds = [
    jest
      .spyOn(ChatStateV2Backend.prototype, 'promoteToFormat4')
      .mockResolvedValue(false),
    ...(stage === 'v2'
      ? [
          jest
            .spyOn(ChatStateV2Backend.prototype, 'promoteToDeltaJournal')
            .mockResolvedValue(false),
        ]
      : []),
  ];
  const target = repository();
  try {
    await deleteScope(target);
  } finally {
    // An armed fault stands for a crash: the process would be gone, so its
    // drain is not part of what the test checks.
    await target.drainAll().catch((error: unknown) => {
      if (!mockDeleteFault.step) throw error;
    });
    for (const hold of holds) hold.mockRestore();
  }
}

async function nothingComesBack(): Promise<void> {
  expect(await stat(storeFor().manifestPath).catch(() => null)).toBeNull();
  for (const path of legacyFamily())
    expect([path, await absent(path)]).toEqual([path, true]);
  expect(await chatsOf()).toEqual({});
}

describe('a deleted scope stays deleted (SWAN 12:48, option A)', () => {
  it.each(['v2', 'v3'] as const)(
    'switch off, %s: delete, then reopen, and nothing comes back',
    async (stage) => {
      promotion = false;
      await seedFullLegacy();
      const holds =
        stage === 'v2'
          ? [
              jest
                .spyOn(ChatStateV2Backend.prototype, 'promoteToDeltaJournal')
                .mockResolvedValue(false),
            ]
          : [];
      await visit('open', repository());
      for (const hold of holds) hold.mockRestore();
      expect(await storeFor().format()).toBe(stage);
      await deleteAt(stage);
      await nothingComesBack();
    },
  );

  it.each(['v2', 'v3'] as const)(
    'switch on, deleted at %s between version 2 validation and format 4: nothing comes back',
    async (stage) => {
      await midWindow(stage);
      await deleteAt(stage);
      await nothingComesBack();
    },
  );

  it('switched on, then rolled back off, then deleted: nothing comes back', async () => {
    await midWindow('v3');
    promotion = false;
    await deleteAt('v3');
    await nothingComesBack();
  });

  it('a format 4 scope: delete, then reopen, and nothing comes back', async () => {
    await seedFullLegacy();
    await visit('open', repository());
    expect(await storeFor().format()).toBe('v4');
    await deleteAt('v3');
    await nothingComesBack();
  });

  it('a legacy file that is a symlink refuses the delete: the manifest stays, nothing outside is touched, and the emptied scope still reopens empty', async () => {
    await midWindow('v3');
    const { tabs } = pathsFor(SCOPE);
    const target = join(outside, 'target.json');
    await writeFile(target, tabsFile([tab('live', 'Live chat')]));
    await rm(`${tabs}.bak`);
    await symlink(target, `${tabs}.bak`);
    const others = legacyFamily().filter((path) => path !== `${tabs}.bak`);
    const before = await legacyBytes(others);

    const error: unknown = await deleteAt('v3').then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(readErrorClassification(error)?.code).toBe(
      'external.chat_history_link_outside',
    );
    expect(
      await stat(storeFor().manifestPath).catch(() => null),
    ).not.toBeNull();
    expect(await readFile(target, 'utf8')).toBe(
      tabsFile([tab('live', 'Live chat')]),
    );
    expect((await lstat(`${tabs}.bak`)).isSymbolicLink()).toBe(true);
    expect(await legacyBytes(others)).toEqual(before);
    expect(await chatsOf()).toEqual({});
  });
});

describe('a crash at each step of the delete order (SWAN 12:48)', () => {
  const steps = [
    ...[1, 2, 3, 4, 5].map((count) => ({ kind: 'unlink' as const, count })),
    { kind: 'manifest' as const, count: 0 },
    { kind: 'directory' as const, count: 0 },
  ];

  it.each(steps)(
    'crashed at $kind $count: the scope reopens with no chats, and deleting again finishes the job',
    async (step) => {
      await midWindow('v3');
      mockDeleteFault.step = step;
      mockDeleteFault.unlinks = 0;
      mockDeleteFault.manifestPath = storeFor().manifestPath;
      mockDeleteFault.directory = storeFor().directory;
      await expect(deleteAt('v3')).rejects.toThrow('fault in the delete');
      mockDeleteFault.step = undefined;
      const hold = jest
        .spyOn(ChatStateV2Backend.prototype, 'promoteToFormat4')
        .mockResolvedValue(false);
      expect(await chatsOf()).toEqual({});
      hold.mockRestore();
      const manifest = await stat(storeFor().manifestPath).catch(() => null);
      if (manifest) await deleteAt('v3');
      await nothingComesBack();
    },
  );
});

describe('a delete retried after a crash (review of #10097)', () => {
  it('syncs every legacy folder, including those the crashed attempt already deleted from, before it removes the manifest', async () => {
    await midWindow('v3');
    mockDeleteFault.step = { kind: 'unlink', count: 2 };
    mockDeleteFault.unlinks = 0;
    mockDeleteFault.manifestPath = storeFor().manifestPath;
    mockDeleteFault.directory = storeFor().directory;
    await expect(deleteAt('v3')).rejects.toThrow('fault in the delete');
    mockDeleteFault.step = undefined;
    const { tabs } = pathsFor(SCOPE);
    expect(await absent(tabs)).toBe(true);
    expect(await absent(`${tabs}.bak`)).toBe(true);

    mockSyncLog.length = 0;
    await deleteAt('v3');
    const manifestAt = mockSyncLog.indexOf(`rm:${storeFor().manifestPath}`);
    expect(manifestAt).toBeGreaterThan(-1);
    for (const folder of new Set(legacyFamily().map((path) => dirname(path)))) {
      const at = mockSyncLog.indexOf(`sync:${folder}`);
      expect([folder, at > -1 && at < manifestAt]).toEqual([folder, true]);
    }
    await nothingComesBack();
  });
});

/** The text of every file in the scope's version 2 recovery evidence. */
async function evidenceTexts(): Promise<string[]> {
  const directory = storeFor().directory;
  const recovery = JSON.parse(
    await readFile(join(directory, 'recovery-index.json'), 'utf8'),
  ) as { legacyEvidence?: Array<{ relativePath: string }> };
  return Promise.all(
    (recovery.legacyEvidence ?? []).map((entry) =>
      readFile(join(directory, entry.relativePath), 'utf8'),
    ),
  );
}

describe.each([
  ['switch on, the sweep', true, 'sweep'],
  ['switch on, an ordinary open', true, 'open'],
  ['switch off, an ordinary open', false, 'open'],
  ['switch off, the sweep', false, 'sweep'],
] as const)(
  'a scope whose only legacy file is its journal backup (%s, SWAN 03:08)',
  (_name, switchOn, route) => {
    it('keeps the backup: still on disk, or a verified copy in the recovery evidence', async () => {
      promotion = switchOn;
      const { journal } = pathsFor(SCOPE);
      const bytes = journalFile([tab('only', 'Only in the journal backup')]);
      await put(`${journal}.bak`, bytes);
      await visit(route, repository());
      const onDisk = await readFile(`${journal}.bak`, 'utf8').catch(() => null);
      if (onDisk === null) expect(await evidenceTexts()).toContain(bytes);
      else expect(onDisk).toBe(bytes);
    });
  },
);

describe('a journal backup whose copy into the evidence fails (SWAN 03:08)', () => {
  it('stays on disk and is refused by cleanup; deleting the scope, which deletes its chats, removes it too (SWAN 03:41)', async () => {
    const { journal } = pathsFor(SCOPE);
    const bytes = journalFile([tab('only', 'Only in the journal backup')]);
    await put(`${journal}.bak`, bytes);
    mockCopyFault.suffix = '.jsonl.bak';
    await visit('open', repository());
    mockCopyFault.suffix = undefined;
    expect(await storeFor().format()).toBe('v4');
    expect(await readFile(`${journal}.bak`, 'utf8')).toBe(bytes);
    expect(await evidenceTexts()).not.toContain(bytes);

    await deleteAt('v3');
    await nothingComesBack();
  });
});

describe('every file the legacy cleanup may remove is migrated or kept as evidence (SWAN 03:08)', () => {
  const kinds = [
    'tabs',
    'tabs backup',
    'archives',
    'archives backup',
    'journal',
    'journal backup',
  ] as const;

  it('the family is exactly the six paths below, as the store itself enumerates them', () => {
    const { tabs, archives, journal } = pathsFor(SCOPE);
    expect(legacyFamily()).toEqual([
      tabs,
      `${tabs}.bak`,
      archives,
      `${archives}.bak`,
      journal,
      `${journal}.bak`,
    ]);
    const { legacyPaths = [] } = storeFor().descriptor();
    expect(legacyPaths.flatMap((path) => [path, `${path}.bak`])).toEqual(
      legacyFamily(),
    );
  });

  it.each(kinds.map((kind, index) => [kind, index] as const))(
    'the %s alone: once cleanup removes it, its chat is in version 2 or its bytes are verified evidence',
    async (kind, index) => {
      promotion = false;
      const path = legacyFamily()[index] ?? '';
      const id = `chat-${index}`;
      const entry = tab(id, `Only in the ${kind}`);
      const text = kind.startsWith('tabs')
        ? tabsFile([entry])
        : kind.startsWith('archives')
          ? archivesFile([entry])
          : journalFile([entry]);
      await put(path, text);
      await visit('open', repository());
      expect(await storeFor().format()).not.toBe('v1');
      if (await absent(path)) {
        const migrated = Object.keys(await chatsOf()).includes(id);
        const kept = (await evidenceTexts()).includes(text);
        expect([kind, migrated || kept]).toEqual([kind, true]);
      }
    },
  );
});

/** A tabs snapshot pair: the newer primary, and an older backup with a chat the primary lacks. */
async function seedSupersededBackup(): Promise<{
  backup: string;
  bytes: string;
}> {
  const { tabs } = pathsFor(SCOPE);
  await put(
    tabs,
    JSON.stringify({
      version: 1,
      revision: 2,
      activeTabId: 'newer',
      tabs: [tab('newer', 'Newer')],
    }) + '\n',
  );
  const bytes =
    JSON.stringify({
      version: 1,
      revision: 1,
      activeTabId: 'older-only',
      tabs: [tab('older-only', 'Only in the older backup')],
    }) + '\n';
  await put(`${tabs}.bak`, bytes);
  return { backup: `${tabs}.bak`, bytes };
}

describe.each([
  ['switch off, an ordinary open', false, 'open'],
  ['switch on, the sweep', true, 'sweep'],
] as const)(
  'a snapshot backup migration read but set aside for a newer copy (%s, SWAN 03:27)',
  (_name, switchOn, route) => {
    it('is kept as verified evidence before cleanup removes it, and the newer copy is what migrates', async () => {
      promotion = switchOn;
      const { backup, bytes } = await seedSupersededBackup();
      await visit(route, repository());
      expect(await absent(backup)).toBe(true);
      expect(await evidenceTexts()).toContain(bytes);
      expect(Object.keys(await chatsOf())).toEqual(['newer']);
    });

    it('stays on disk and is refused when its copy into the evidence fails', async () => {
      promotion = switchOn;
      const { backup, bytes } = await seedSupersededBackup();
      mockCopyFault.suffix = '.json.bak';
      await visit(route, repository());
      mockCopyFault.suffix = undefined;
      expect(await readFile(backup, 'utf8')).toBe(bytes);
      expect(await evidenceTexts()).not.toContain(bytes);
      expect(await absent(pathsFor(SCOPE).tabs)).toBe(true);
    });
  },
);

describe('a file version 2 cleanup refused, with cleanupComplete set (SWAN 06:10)', () => {
  it('is never loaded on later opens, through format 4 and a rollback to the switch off, and goes with the scope so nothing comes back', async () => {
    promotion = false;
    const { backup, bytes } = await seedSupersededBackup();
    mockCopyFault.suffix = '.json.bak';
    await visit('open', repository());
    mockCopyFault.suffix = undefined;
    expect(await readFile(backup, 'utf8')).toBe(bytes);
    const manifest = JSON.parse(
      await readFile(storeFor().manifestPath, 'utf8'),
    ) as { cleanupComplete?: boolean };
    expect(manifest.cleanupComplete).toBe(true);
    expect(Object.keys(await chatsOf())).toEqual(['newer']);

    promotion = true;
    await visit('open', repository());
    expect(await storeFor().format()).toBe('v4');
    expect(await readFile(backup, 'utf8')).toBe(bytes);
    expect(Object.keys(await chatsOf())).toEqual(['newer']);

    promotion = false;
    await visit('open', repository());
    expect(Object.keys(await chatsOf())).toEqual(['newer']);

    await deleteAt('v3');
    expect(await absent(backup)).toBe(true);
    await nothingComesBack();
  });
});

describe('cleanup knows only bytes migration built from or kept (SWAN 03:41)', () => {
  /** Migrate with the switch on but stop short of format 4, so the files stay. */
  async function migratedKeepingLegacy(): Promise<void> {
    await seedFullLegacy();
    const hold = jest
      .spyOn(ChatStateV2Backend.prototype, 'promoteToFormat4')
      .mockResolvedValue(false);
    await visit('open', repository());
    hold.mockRestore();
    expect(await storeFor().format()).toBe('v3');
  }

  it('a family file whose bytes changed after migration matches neither record nor evidence, so it is refused and kept', async () => {
    await migratedKeepingLegacy();
    const { tabs } = pathsFor(SCOPE);
    const changed = tabsFile([tab('later', 'Written after migration')]);
    await writeFile(tabs, changed);
    await visit('open', repository());
    expect(await storeFor().format()).toBe('v4');
    expect(await readFile(tabs, 'utf8')).toBe(changed);
    for (const path of legacyFamily().filter((path) => path !== tabs))
      expect([path, await absent(path)]).toEqual([path, true]);
  });

  it('a store with no consumed record, migrated before it existed, deletes the five members migration reads and keeps an unpreserved journal backup', async () => {
    await migratedKeepingLegacy();
    await rm(join(storeFor().directory, 'legacy-sources.json'));
    const { journal } = pathsFor(SCOPE);
    const unpreserved = journalFile([tab('late', 'Not in any evidence')]);
    await writeFile(`${journal}.bak`, unpreserved);
    await visit('open', repository());
    expect(await storeFor().format()).toBe('v4');
    expect(await readFile(`${journal}.bak`, 'utf8')).toBe(unpreserved);
    for (const path of legacyFamily().filter(
      (path) => path !== `${journal}.bak`,
    ))
      expect([path, await absent(path)]).toEqual([path, true]);
  });
});

describe('cleanup with no legacy files left (review of #10097, round 4)', () => {
  it('a format 4 load whose legacy files are all gone neither reads nor hashes the recovery evidence', async () => {
    await seedFullLegacy();
    await visit('open', repository());
    expect(await storeFor().format()).toBe('v4');
    for (const path of legacyFamily())
      expect([path, await absent(path)]).toEqual([path, true]);
    expect((await evidenceTexts()).length).toBeGreaterThan(0);

    mockReadLog.length = 0;
    await visit('open', repository());
    const evidence = join(storeFor().directory, 'recovery-evidence');
    expect(mockReadLog.filter((path) => path.startsWith(evidence))).toEqual([]);
  });
});
