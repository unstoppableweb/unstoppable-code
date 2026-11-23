/**
 * Crash images through the format 4 sweep (CAN-7178).
 *
 * The sweep promotes a scope nobody has open, so a crash in it must lose
 * nothing either. Every `DeltaJournalBoundary` is classified here, read from
 * the writer's source, so a new boundary fails this suite until it is: either
 * a sweep admission crosses it (and it gets a crash image), or it belongs to
 * a format 4 write or checkpoint the sweep never runs (and no sweep fixture
 * may reach it). Each image reopens twice with the rows a crash-free sweep
 * keeps, at format 3 before publication and format 4 after, and the next
 * sweep pass finishes it.
 */
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  DELTA_JOURNAL_FILE_NAME,
  encodeDeltaJournalFrame,
  type DeltaJournalTranscriptEffect,
} from '../lib/chat-delta-journal/format';
import * as journalReader from '../lib/chat-delta-journal/replay';
import { readDeltaJournal } from '../lib/chat-delta-journal/replay';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  type DeltaJournalBoundary,
} from '../lib/chat-delta-journal/writer';
import * as writerModule from '../lib/chat-delta-journal/writer';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type { ChatScopeKey } from '../services/chat-state-contracts';
import {
  ChatFormat4Sweep,
  repositoryChatFormat4SweepTarget,
  type ChatFormat4SweepPassResult,
  type ChatFormat4SweepTarget,
} from '../services/chat-format4-sweep';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import {
  drainOpenRepositories,
  streaming,
} from './helpers/chat-delta-journal-scope';

// Real syncs dominate, as in the promotion qualification (CAN-6971).
jest.setTimeout(120_000);

const SCOPE: ChatScopeKey = { projectId: 'project', worktreeId: 'scope' };

/** Boundaries a sweep admission of a format 3 scope crosses, by fixture. */
const SWEEP_BOUNDARIES = {
  'checkpoint-transcripts-applied': 'pending',
  'checkpoint-metadata-staged': 'pending',
  'checkpoint-publishing-marked': 'pending',
  'checkpoint-indexes-published': 'pending',
  'checkpoint-journal-rotated': 'pending',
  'marker-removed': 'pending',
  'catalog-temp-written': 'pending',
  'catalog-temp-synced': 'pending',
  'segment-temp-written': 'pending',
  'segment-temp-synced': 'pending',
  'segment-renamed': 'pending',
  'segment-directory-synced': 'pending',
  'manifest-temp-written': 'pending',
  'manifest-temp-synced': 'pending',
  'manifest-published': 'pending',
  'manifest-directory-synced': 'pending',
  'writer-reopened': 'pending',
  'tail-truncated': 'torn',
  'tail-quarantined': 'checksum',
  'echo-quarantined': 'echo',
} as const;

/**
 * Boundaries of format 4 writes and checkpoints. A format 3 scope has no
 * child streams, delegation registries, finalized rows or receipts, and the
 * sweep writes no record, so no sweep admission reaches these.
 */
const NOT_ON_SWEEP_PATH = {
  'record-written': 'a turn appending a journal record',
  'record-synced': 'a turn appending a journal record',
  'checkpoint-child-append-prepared':
    'a format 4 checkpoint with child streams',
  'checkpoint-descriptors-published':
    'a format 4 checkpoint with child streams',
  'checkpoint-registries-published':
    'a format 4 checkpoint with delegation registries',
  'checkpoint-catalog-published': 'a format 4 checkpoint with child streams',
  'checkpoint-removed-parents': 'a format 4 checkpoint removing parent streams',
  'registry-answer-published': 'a delegation result settlement',
  'registry-settle-admitted': 'a delegation result settlement',
  'finalize-artifact': 'a format 4 row finalization',
  'finalize-journal': 'a format 4 row finalization',
  'finalize-checkpoint': 'a format 4 row finalization',
  'receipt-effect': 'a command receipt admission',
} as const;

/** Compile-time: every boundary is classified exactly once. */
const CLASSIFIED: Record<DeltaJournalBoundary, string> = {
  ...SWEEP_BOUNDARIES,
  ...NOT_ON_SWEEP_PATH,
};

/** Faults inside promotion that are not boundaries: verify, cleanup, reopen. */
const HELPER_FAULTS = ['verify', 'v1-cleanup', 'reopen'] as const;
type Fault = keyof typeof SWEEP_BOUNDARIES | (typeof HELPER_FAULTS)[number];
type Fixture = (typeof SWEEP_BOUNDARIES)[keyof typeof SWEEP_BOUNDARIES];

const PUBLISHED: ReadonlySet<Fault> = new Set<Fault>([
  'manifest-published',
  'manifest-directory-synced',
  'writer-reopened',
  'v1-cleanup',
  'reopen',
]);

let dataDir: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'format4-sweep-crash-'));
  process.env.CANOPY_DATA_DIR = dataDir;
  resetResolvedCanopyDataDirForTests();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await drainOpenRepositories();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(dataDir, { recursive: true, force: true });
});

function pathsAt(root: string): {
  tabs: string;
  archives: string;
  journal: string;
} {
  const workspace = join(root, 'workspaces', SCOPE.projectId);
  return {
    tabs: join(workspace, 'chats', `${SCOPE.worktreeId}.json`),
    archives: join(workspace, 'chat-archives', `${SCOPE.worktreeId}.json`),
    journal: join(workspace, 'chat-journals', `${SCOPE.worktreeId}.jsonl`),
  };
}

const storeAt = (root: string): ChatStorageV2 =>
  ChatStorageV2.fromLegacyPaths(pathsAt(root));

/** A format 3 scope whose journal holds one acknowledged record. */
async function pendingScope(root: string): Promise<ChatStorageV2> {
  const store = storeAt(root);
  await store.migrate(
    scopeSource([
      { id: 'chat', messages: [message('initial', 'Initial', 'user')] },
    ]),
  );
  const backend = new ChatStateV2Backend(store, {
    enableFormat4: true,
    deltaJournal: {},
  });
  await backend.promoteToDeltaJournal();
  await backend.transact(
    () => [
      streaming('chat', 'initial'),
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: message('pending', 'Pending'),
      },
    ],
    { source: 'provider', mutationId: 'pending' },
  );
  backend.releaseJournal();
  return store;
}

/** The CAN-6902 journal: an active record whose rows conflict with history. */
async function echoScope(root: string): Promise<ChatStorageV2> {
  const store = storeAt(root);
  await store.migrate(
    scopeSource([
      {
        id: 'c0',
        messages: [message('u1', 'hi', 'user'), message('m2', 'original')],
      },
    ]),
  );
  await promoteToDeltaJournal(store);
  const path = join(store.directory, DELTA_JOURNAL_FILE_NAME);
  const before = await readDeltaJournal(store.directory, SCOPE.worktreeId);
  const writer = await ChatDeltaJournalWriter.open(store);
  const next = structuredClone(writer.indexes());
  next.live.revision += 1;
  next.archive.revision += 1;
  next.recovery.mutationIds = [...next.recovery.mutationIds, 'echo'];
  await writer.commit({
    expectedRevision: writer.indexes().live.revision,
    next,
    writes: [
      {
        chatId: 'c0',
        kind: 'active-upsert',
        messages: [message('m3', 'streaming')],
      },
    ],
    mutationIds: ['echo'],
  });
  const record = (
    await readDeltaJournal(store.directory, SCOPE.worktreeId)
  ).records.at(-1);
  if (record?.v !== 1) throw new Error('Expected one version 1 record');
  const conflicting: PersistedChatMessage[] = [
    message('u1', 'hi', 'user'),
    message('m2', 'edited'),
  ];
  const effect: DeltaJournalTranscriptEffect = {
    kind: 'active-upsert',
    chatId: 'c0',
    create: false,
    messages: conflicting,
  };
  const { frame } = encodeDeltaJournalFrame({
    ...record,
    transcripts: [effect],
  });
  await truncate(path, before.validEnd);
  await appendFile(path, frame);
  return store;
}

async function seed(fixture: Fixture, root: string): Promise<ChatStorageV2> {
  if (fixture === 'echo') return echoScope(root);
  const store = await pendingScope(root);
  const path = join(store.directory, DELTA_JOURNAL_FILE_NAME);
  if (fixture === 'torn') await appendFile(path, '{"torn":');
  if (fixture === 'checksum') {
    const bytes = await readFile(path);
    const at = bytes.length - 8;
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    await writeFile(path, bytes);
  }
  return store;
}

function repositoryAt(
  root: string,
  onBoundary?: (point: DeltaJournalBoundary) => Promise<void>,
): ChatStateV2Repository {
  return new ChatStateV2Repository({
    resolvePaths: () => pathsAt(root),
    enableFormat4: true,
    deltaJournalIncrementalStreamMetadata: true,
    deltaJournalIdleCheckpointMs: 60_000,
    ...(onBoundary ? { deltaJournalOnBoundary: onBoundary } : {}),
  });
}

/**
 * One sweep pass over `root` through the repository's own admission
 * (`sweepFormat4`), as the app runs it; then the repository drains.
 */
async function runSweep(
  root: string,
  onBoundary?: (point: DeltaJournalBoundary) => Promise<void>,
): Promise<ChatFormat4SweepPassResult> {
  const repository = repositoryAt(root, onBoundary);
  try {
    return await sweepAt(root, {
      ...repositoryChatFormat4SweepTarget(repository, () => true),
      sweepAllowed: (): boolean => true,
    }).runPass();
  } finally {
    await repository.drainAll().catch(() => undefined);
  }
}

function sweepAt(
  root: string,
  target: ChatFormat4SweepTarget,
): ChatFormat4Sweep {
  return new ChatFormat4Sweep({
    dataDir: root,
    target,
    resolveStore: () => storeAt(root),
    conditions: {
      turnInFlight: () => false,
      idleMs: () => Number.MAX_SAFE_INTEGER,
      onBattery: () => false,
      freeBytes: () => Promise.resolve(1024 ** 4),
    },
    clock: { now: () => 0, sleep: () => Promise.resolve() },
  });
}

/** Every chat's row ids, as a fresh repository reads the scope. */
async function rowsAt(root: string): Promise<Record<string, string[]>> {
  const repository = repositoryAt(root);
  try {
    const listed = await repository.getState(SCOPE);
    const chatIds = listed.tabsFile.tabs.map((tab) => tab.id);
    const state = await repository.getState(SCOPE, {
      chatIds,
      fullTranscript: true,
    });
    return Object.fromEntries(
      state.tabsFile.tabs.map((tab) => [
        tab.id,
        tab.messages.map((row) => row.id),
      ]),
    );
  } finally {
    await repository.drainAll().catch(() => undefined);
  }
}

function boundaryNamesFromSource(source: string): string[] {
  const start = source.indexOf('export type DeltaJournalBoundary =');
  const end = source.indexOf(';', start);
  if (start < 0 || end < 0) throw new Error('DeltaJournalBoundary not found');
  return Array.from(
    source.slice(start, end).matchAll(/\|\s*'([a-z0-9-]+)'/g),
    (match) => match[1] ?? '',
  ).sort();
}

describe('the seam is covered', () => {
  it('classifies every DeltaJournalBoundary in the writer, once', async () => {
    const source = await readFile(
      join(__dirname, '..', 'lib', 'chat-delta-journal', 'writer.ts'),
      'utf8',
    );
    const declared = boundaryNamesFromSource(source);
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(CLASSIFIED).sort()).toEqual(declared);
    for (const name of Object.keys(SWEEP_BOUNDARIES))
      expect(Object.keys(NOT_ON_SWEEP_PATH)).not.toContain(name);
  });

  it('a sweep over every fixture crosses exactly the sweep boundaries, and none of the others', async () => {
    const reached = new Map<string, Set<Fixture>>();
    for (const fixture of ['pending', 'torn', 'checksum', 'echo'] as const) {
      const root = join(dataDir, fixture);
      await seed(fixture, root);
      const result = await runSweep(root, (point) => {
        const fixtures = reached.get(point) ?? new Set<Fixture>();
        fixtures.add(fixture);
        reached.set(point, fixtures);
        return Promise.resolve();
      });
      expect(result.status).toBe('complete');
      expect(await storeAt(root).format()).toBe('v4');
    }
    for (const [point, fixture] of Object.entries(SWEEP_BOUNDARIES))
      expect([point, reached.get(point)?.has(fixture) ?? false]).toEqual([
        point,
        true,
      ]);
    for (const point of Object.keys(NOT_ON_SWEEP_PATH))
      expect([point, reached.has(point)]).toEqual([point, false]);
  });
});

describe('a sweep crashed at each point', () => {
  const faults: Fault[] = [
    ...(Object.keys(SWEEP_BOUNDARIES) as Array<keyof typeof SWEEP_BOUNDARIES>),
    ...HELPER_FAULTS,
  ];

  it.each(faults)(
    'at %s reopens twice with every row a clean sweep keeps, then the next pass finishes it',
    async (fault) => {
      const fixture: Fixture =
        fault in SWEEP_BOUNDARIES
          ? SWEEP_BOUNDARIES[fault as keyof typeof SWEEP_BOUNDARIES]
          : 'pending';

      const control = join(dataDir, 'control');
      await seed(fixture, control);
      await runSweep(control);
      const expectedRows = await rowsAt(control);

      const live = join(dataDir, 'live');
      const crash = join(dataDir, 'crash');
      const store = await seed(fixture, live);
      let injected = false;
      let promoting = false;
      const stop = async (): Promise<void> => {
        injected = true;
        await cp(live, crash, { recursive: true });
        throw new Error(`fault:${fault}`);
      };
      const promote = writerModule.promoteToFormat4Journal;
      jest
        .spyOn(writerModule, 'promoteToFormat4Journal')
        .mockImplementation(async (selected, options) => {
          promoting = true;
          return promote(selected, options);
        });
      const read = journalReader.readDeltaJournal;
      jest
        .spyOn(journalReader, 'readDeltaJournal')
        .mockImplementation(async (...args) => {
          if (fault === 'verify' && promoting && !injected) await stop();
          return read(...args);
        });
      const remove = fs.rm;
      jest.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
        if (
          fault === 'v1-cleanup' &&
          promoting &&
          !injected &&
          path === join(store.directory, DELTA_JOURNAL_FILE_NAME)
        )
          await stop();
        return remove(path, options);
      });
      const open = ChatDeltaJournalWriter.open.bind(ChatDeltaJournalWriter);
      jest
        .spyOn(ChatDeltaJournalWriter, 'open')
        .mockImplementation(async (selected, options) => {
          if (
            fault === 'reopen' &&
            promoting &&
            !injected &&
            (await selected.format()) === 'v4'
          )
            await stop();
          return open(selected, options);
        });

      await runSweep(live, async (point) => {
        if (!injected && point === fault) await stop();
      });
      expect(injected).toBe(true);
      jest.restoreAllMocks();

      expect(await storeAt(crash).format()).toBe(
        PUBLISHED.has(fault) ? 'v4' : 'v3',
      );
      expect(await rowsAt(crash)).toEqual(expectedRows);
      expect(await rowsAt(crash)).toEqual(expectedRows);

      const finished = await runSweep(crash);
      expect(finished.status).toBe('complete');
      expect(await storeAt(crash).format()).toBe('v4');
      expect(await rowsAt(crash)).toEqual(expectedRows);
    },
  );
});
