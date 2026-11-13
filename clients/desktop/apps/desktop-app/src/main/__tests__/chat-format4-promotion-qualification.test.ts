/**
 * Format 4 promotion qualification (CAN-6191, for the CAN-6189 switch).
 *
 * Promotion is one way, so before any build promotes a scope this suite pins:
 * a load crashed at every promotion boundary reopens with every acknowledged
 * row; a build with promotion off (every stable release so far, and any build
 * after a stop) keeps a promoted or half-promoted scope as it is; the
 * rollback round trip, where a promoting build's scope is read, written and
 * checkpointed with promotion off and then reopened by the promoting build;
 * and an older reader refusing a promoted scope without changing a byte.
 * test:platform-services runs it on Linux, macOS and Windows.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStorageNewerFormatError } from '../lib/chat-delta-journal/format';
import {
  ChatDeltaJournalWriter,
  promoteToFormat4Journal,
} from '../lib/chat-delta-journal/writer';
import type { DeltaJournalBoundary } from '../lib/chat-delta-journal/writer';
import * as writerModule from '../lib/chat-delta-journal/writer';
import * as journalReader from '../lib/chat-delta-journal/replay';
import {
  parseStreamCatalog,
  streamCatalogPath,
  streamRegistryPaths,
} from '../lib/chat-delta-journal/stream-registry';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type { ChatStateV2RepositoryOptions } from '../services/chat-state-v2-repository';
import { snapshotFormat4Files } from './helpers/chat-format4-scope';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import {
  drainAfterTest,
  drainOpenRepositories,
  streaming,
} from './helpers/chat-delta-journal-scope';

const scope = { projectId: 'project', worktreeId: 'scope' };

const pathsAt = (
  root: string,
): { tabs: string; archives: string; journal: string } => ({
  tabs: join(root, 'chats', 'scope.json'),
  archives: join(root, 'chat-archives', 'scope.json'),
  journal: join(root, 'chat-journals', 'scope.jsonl'),
});

/** The options each kind of build passes, minus host probes. */
const PROMOTING: ChatStateV2RepositoryOptions = {
  enableFormat4: true,
  deltaJournalIncrementalStreamMetadata: true,
};
const PROMOTION_OFF: ChatStateV2RepositoryOptions = {};

let root: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'format4-qualification-'));
  process.env.CANOPY_DATA_DIR = root;
  resetResolvedCanopyDataDirForTests();
});

afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await drainOpenRepositories();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(root, { recursive: true, force: true });
});

function repository(
  options: ChatStateV2RepositoryOptions,
  at = root,
): ChatStateV2Repository {
  return drainAfterTest(
    new ChatStateV2Repository({
      resolvePaths: () => pathsAt(at),
      deltaJournalIdleCheckpointMs: 60_000,
      ...options,
    }),
  );
}

/** A format 3 (delta journal) scope with one chat, as stable builds leave it. */
async function seed(
  at = root,
): Promise<{ store: ChatStorageV2; backend: ChatStateV2Backend }> {
  const store = ChatStorageV2.fromLegacyPaths(pathsAt(at));
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
  return { store, backend };
}

function delegate(
  delegationId: string,
  runGeneration: number,
): {
  kind: 'delegation';
  chatId: string;
  delegationId: string;
  runGeneration: number;
} {
  return { kind: 'delegation', chatId: 'chat', delegationId, runGeneration };
}

function childRow(
  delegationId: string,
  sequence: number,
  text: string,
): DelegationChildRow {
  return {
    ...message(`${delegationId}-item-${sequence}`, text),
    parentBlockId: `agent-${delegationId}`,
    delegationSequence: sequence,
    itemRevision: 0,
    final: true,
  };
}

describe('promotion crash images', () => {
  const boundaries: DeltaJournalBoundary[] = [
    'checkpoint-transcripts-applied',
    'checkpoint-metadata-staged',
    'checkpoint-publishing-marked',
    'checkpoint-indexes-published',
    'checkpoint-journal-rotated',
    'marker-removed',
    'catalog-temp-written',
    'catalog-temp-synced',
    'segment-temp-written',
    'segment-temp-synced',
    'segment-renamed',
    'segment-directory-synced',
    'manifest-temp-written',
    'manifest-temp-synced',
    'manifest-published',
    'manifest-directory-synced',
    'writer-reopened',
  ];
  const faults = [...boundaries, 'verify', 'v1-cleanup', 'reopen'] as const;
  const publishedFaults: ReadonlySet<string> = new Set([
    'manifest-published',
    'manifest-directory-synced',
    'writer-reopened',
    'v1-cleanup',
    'reopen',
  ]);

  /** A child written after publication survives later loads unchanged. */
  async function retainPostPublicationChild(
    target: ChatStateV2Repository,
    at: string,
  ): Promise<void> {
    const child = delegate('child', 1);
    await target.openChildStream(scope, child);
    const row = childRow('child', 1, 'Child after publication');
    await target.commitChildStream(scope, child, 'child-row', [row]);
    await target.flushScope(scope);
    const descriptor = await target.openChildStream(scope, child);
    const catalog = streamCatalogPath(
      join(ChatStorageV2.fromLegacyPaths(pathsAt(at)).directory, 'transcripts'),
    );
    const before = await readFile(catalog);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const later = repository(PROMOTING, at);
      expect(await later.openChildStream(scope, child)).toEqual(descriptor);
      expect(
        await later.getChildStreamMessage(
          scope,
          child,
          row.id,
          descriptor.streamRevision,
        ),
      ).toEqual(row);
      expect(await readFile(catalog)).toEqual(before);
    }
  }

  it.each(faults)(
    'a load crashed at %s reopens with every acknowledged row, twice',
    async (fault) => {
      const live = join(root, 'live');
      const crash = join(root, 'crash');
      const { store, backend } = await seed(live);
      await backend.transact(
        () => [
          streaming('chat', 'initial'),
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: message('pending', 'Pending v3 row'),
          },
        ],
        { source: 'provider', mutationId: 'pending' },
      );
      expect(backend.pendingJournalRecords()).toBe(1);
      backend.releaseJournal();
      let injected = false;
      let promoting = false;
      let retired: ChatDeltaJournalWriter | undefined;
      const promote = writerModule.promoteToFormat4Journal;
      jest
        .spyOn(writerModule, 'promoteToFormat4Journal')
        .mockImplementation(async (selected, options) => {
          promoting = true;
          retired = options?.writer;
          return promote(selected, options);
        });
      // The image is taken at the fault, before recovery can repair it.
      const stop = async (): Promise<void> => {
        injected = true;
        await cp(live, crash, { recursive: true });
        throw new Error(`fault:${fault}`);
      };
      const read = journalReader.readDeltaJournal;
      jest
        .spyOn(journalReader, 'readDeltaJournal')
        .mockImplementation(async (...args) => {
          if (
            fault === 'verify' &&
            promoting &&
            !injected &&
            retired &&
            !retired.isOpen()
          )
            await stop();
          return read(...args);
        });
      const remove = fs.rm;
      jest.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
        if (
          fault === 'v1-cleanup' &&
          promoting &&
          !injected &&
          path === join(store.directory, 'delta-journal.log')
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

      const target = repository(
        {
          ...PROMOTING,
          deltaJournalOnBoundary: async (point) => {
            if (!injected && point === fault) await stop();
          },
        },
        live,
      );
      const state = await target.getState(scope, {
        chatIds: ['chat'],
        fullTranscript: true,
      });
      expect(injected).toBe(true);
      expect(target.getLifecycle(scope)).toBe('ready');
      const published = publishedFaults.has(fault);
      expect(await store.format()).toBe(published ? 'v4' : 'v3');
      expect(state.tabsFile.tabs[0]?.messages.map((row) => row.id)).toEqual([
        'initial',
        'pending',
      ]);
      expect(await target.getRevision(scope)).toBe(1);
      if (!retired) throw new Error('Promotion did not receive its old writer');
      expect(retired.isOpen()).toBe(false);
      await expect(
        retired.commit({
          expectedRevision: 1,
          next: await store.indexes(),
          writes: [],
          mutationIds: ['stale'],
        }),
      ).rejects.toThrow();
      await target.transact(
        scope,
        [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: message('continued', 'Continued', 'user'),
          },
        ],
        { source: 'provider', mutationId: 'continued' },
      );
      expect(await target.getRevision(scope)).toBe(2);

      // The crash image itself, opened with promotion off, has every
      // acknowledged row and keeps the format it reached.
      jest.restoreAllMocks();
      const imageStore = ChatStorageV2.fromLegacyPaths(pathsAt(crash));
      const image = repository(PROMOTION_OFF, crash);
      const imageState = await image.getState(scope, {
        chatIds: ['chat'],
        fullTranscript: true,
      });
      expect(await image.getRevision(scope)).toBe(1);
      expect(
        imageState.tabsFile.tabs[0]?.messages.map((row) => row.id),
      ).toEqual(['initial', 'pending']);
      expect(await imageStore.format()).toBe(published ? 'v4' : 'v3');
      if (published) {
        await retainPostPublicationChild(target, live);
        await retainPostPublicationChild(image, crash);
      }
      // Fresh promoting repositories resume the image, twice.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const resumed = repository(PROMOTING, crash);
        await resumed.getState(scope);
        expect(await imageStore.format()).toBe('v4');
        expect(await resumed.getRevision(scope)).toBe(published ? 3 : 1);
      }
    },
    // Real syncs on two scope copies; allow for a loaded host.
    60_000,
  );
});

describe('promotion off keeps a promoted or half-promoted scope as it is', () => {
  it('a format 3 scope stays format 3 when promotion is off', async () => {
    const { store } = await seed();
    await repository(PROMOTION_OFF).getState(scope);
    expect(await store.format()).toBe('v3');
  });

  it('removes an empty unpublished format 4 segment but keeps the catalog', async () => {
    const { store, backend } = await seed();
    backend.releaseJournal();
    await expect(
      promoteToFormat4Journal(store, {
        onBoundary: (point) =>
          point === 'manifest-temp-written'
            ? Promise.reject(new Error('before-publication'))
            : Promise.resolve(),
      }),
    ).rejects.toThrow('before-publication');
    const segment = join(store.directory, 'delta-journal-v2.log');
    const catalog = streamCatalogPath(join(store.directory, 'transcripts'));
    expect((await readFile(segment)).length).toBeGreaterThan(0);
    const catalogBefore = await readFile(catalog);
    await repository(PROMOTION_OFF).getState(scope);
    await expect(readFile(segment)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.format()).toBe('v3');
    expect(await readFile(catalog)).toEqual(catalogBefore);
  });

  it.each(['nonempty', 'torn', 'selected v4'] as const)(
    'keeps %s journal evidence and never deletes the catalog',
    async (kind) => {
      const { store, backend } = await seed();
      backend.releaseJournal();
      const selectedV1 = await readFile(
        join(store.directory, 'delta-journal.log'),
      );
      await expect(
        promoteToFormat4Journal(store, {
          onBoundary: (point) =>
            point === 'manifest-temp-written'
              ? Promise.reject(new Error('stop'))
              : Promise.resolve(),
        }),
      ).rejects.toThrow('stop');
      const v2 = join(store.directory, 'delta-journal-v2.log');
      if (kind === 'torn') {
        await writeFile(
          v2,
          Buffer.concat([await readFile(v2), Buffer.from('CDJ1')]),
        );
      } else if (kind === 'nonempty') {
        const other = await seed(join(root, 'other'));
        other.backend.releaseJournal();
        const writer = await promoteToFormat4Journal(other.store);
        const current = writer.indexes();
        await writer.commit({
          expectedRevision: 0,
          next: {
            live: { ...current.live, revision: 1 },
            archive: { ...current.archive, revision: 1 },
            recovery: { ...current.recovery, mutationIds: ['evidence'] },
          },
          writes: [],
          mutationIds: ['evidence'],
        });
        await writeFile(
          v2,
          await readFile(join(other.store.directory, 'delta-journal-v2.log')),
        );
      } else {
        await promoteToFormat4Journal(store);
        await writeFile(join(store.directory, 'delta-journal.log'), selectedV1);
      }
      const selected =
        kind === 'selected v4'
          ? v2
          : join(store.directory, 'delta-journal.log');
      const selectedBefore = await readFile(selected);
      const v2Before = await readFile(v2);
      const catalog = streamCatalogPath(join(store.directory, 'transcripts'));
      const catalogBefore = await readFile(catalog);
      await repository(PROMOTION_OFF).getState(scope);
      expect(await readFile(selected)).toEqual(selectedBefore);
      expect(await readFile(v2)).toEqual(v2Before);
      expect(await readFile(catalog)).toEqual(catalogBefore);
      if (kind === 'selected v4')
        await expect(
          readFile(join(store.directory, 'delta-journal.log')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

describe('rollback round trip', () => {
  const delegates = ['first', 'second', 'third'];

  async function rows(
    target: ChatStateV2Repository,
    child: ReturnType<typeof delegate>,
  ): Promise<readonly DelegationChildRow[]> {
    const descriptor = await target.getChildStreamState(scope, child);
    if (!descriptor) throw new Error(`No stream for ${child.delegationId}`);
    const page = await target.getChildStreamPage(
      scope,
      child,
      descriptor.streamRevision,
      undefined,
      100,
    );
    return page.rows;
  }

  it('a promoting build’s scope is read, written and checkpointed with promotion off, then reopened by the promoting build', async () => {
    const { store, backend } = await seed();
    backend.releaseJournal();
    const transcripts = join(store.directory, 'transcripts');
    const written = new Map<string, DelegationChildRow[]>();
    const commit = async (
      target: ChatStateV2Repository,
      child: ReturnType<typeof delegate>,
      sequence: number,
    ): Promise<void> => {
      const key = `${child.delegationId}/${child.runGeneration}`;
      const row = childRow(
        child.delegationId,
        sequence,
        `${key} item ${sequence} 🌲 漢字`,
      );
      await target.commitChildStream(scope, child, `${key}-${sequence}`, [row]);
      written.set(key, [...(written.get(key) ?? []), row]);
    };
    const expectEveryStream = async (
      target: ChatStateV2Repository,
    ): Promise<void> => {
      for (const [key, expected] of written) {
        const [delegationId = '', generation = '0'] = key.split('/');
        expect({
          key,
          rows: await rows(target, delegate(delegationId, Number(generation))),
        }).toEqual({ key, rows: expected });
      }
    };

    // The promoting build promotes on load, then writes three streams across
    // two checkpoints; only the first changes in the second, so the other
    // descriptors keep the earlier checkpoint's stamp (incremental metadata).
    const promoting = repository(PROMOTING);
    await promoting.getState(scope);
    expect(await store.format()).toBe('v4');
    for (const id of delegates) {
      await promoting.openChildStream(scope, delegate(id, 1));
      await commit(promoting, delegate(id, 1), 0);
    }
    await promoting.flushScope(scope);
    await commit(promoting, delegate('first', 1), 1);
    await promoting.flushScope(scope);
    await promoting.drainAll();
    const catalog = parseStreamCatalog(
      await readFile(streamCatalogPath(transcripts)),
    );
    const stamps = await Promise.all(
      delegates.map(async (id) => {
        const descriptor: unknown = JSON.parse(
          await readFile(
            streamRegistryPaths(
              transcripts,
              'chat',
              delegationStreamKey(delegate(id, 1)),
            ).descriptor,
            'utf8',
          ),
        );
        const stamp: unknown =
          typeof descriptor === 'object' && descriptor !== null
            ? Reflect.get(descriptor, 'checkpointRevision')
            : undefined;
        return stamp;
      }),
    );
    expect(stamps[0]).toBe(catalog.checkpointRevision);
    for (const stamp of stamps.slice(1))
      expect(stamp).toBeLessThan(catalog.checkpointRevision);

    // A build with promotion off (v1.18.0 and v1.19.0 ship that way) reads
    // everything, writes the parent and a follow-up generation's stream, and
    // checkpoints. The scope stays format 4.
    const rollback = repository(PROMOTION_OFF);
    await expectEveryStream(rollback);
    expect(await rollback.hasMessage(scope, 'chat', 'initial')).toBe(true);
    await rollback.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('during-rollback', 'Written with promotion off'),
        },
      ],
      { source: 'provider', mutationId: 'during-rollback' },
    );
    await rollback.openChildStream(scope, delegate('first', 2));
    await commit(rollback, delegate('first', 2), 0);
    await commit(rollback, delegate('second', 1), 1);
    await rollback.flushScope(scope);
    await expectEveryStream(rollback);
    await rollback.drainAll();
    expect(await store.format()).toBe('v4');

    // The promoting build reopens it, reads every stream and both parent
    // writes, and keeps writing.
    const again = repository(PROMOTING);
    await expectEveryStream(again);
    expect(await again.hasMessage(scope, 'chat', 'during-rollback')).toBe(true);
    await commit(again, delegate('third', 1), 1);
    await again.flushScope(scope);
    await again.drainAll();

    // And a second rollback reads the result.
    const second = repository(PROMOTION_OFF);
    await expectEveryStream(second);
    expect(await store.format()).toBe('v4');
  }, 60_000);
});

describe('the new production defaults are inert while promotion is off (CAN-6192)', () => {
  /** Production options before CAN-6192: no format 4 handling, full restaging. */
  const BEFORE: ChatStateV2RepositoryOptions = {};
  /** Production options after CAN-6192, with the promotion flag off. */
  const AFTER: ChatStateV2RepositoryOptions = {
    enableFormat4: true,
    deltaJournalIncrementalStreamMetadata: true,
    format4Promotion: () => false,
  };

  /** Loads, writes, checkpoints, asks spawn readiness and reopens the scope. */
  async function exercise(
    options: ChatStateV2RepositoryOptions,
    at: string,
  ): Promise<void> {
    const target = repository(options, at);
    await target.getState(scope, { chatIds: ['chat'], fullTranscript: true });
    await target.transact(
      scope,
      [
        streaming('chat', 'initial'),
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('reply', 'A reply 🌲 漢字'),
        },
      ],
      { source: 'provider', mutationId: 'reply' },
    );
    await target.transact(
      scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { title: 'Renamed' },
        },
      ],
      { source: 'provider', mutationId: 'rename' },
    );
    await target.generationStoreReadiness(scope);
    await target.flushScope(scope);
    await target.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('after-checkpoint', 'After the checkpoint'),
        },
      ],
      { source: 'provider', mutationId: 'after-checkpoint' },
    );
    await target.generationStoreReadiness(scope);
    await target.drainAll();
    const reopened = repository(options, at);
    await reopened.getState(scope, { chatIds: ['chat'], fullTranscript: true });
    await reopened.flushScope(scope);
    await reopened.drainAll();
  }

  async function contents(at: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const file of await snapshotFormat4Files(at))
      files[file.path] = file.sha256;
    return files;
  }

  it('a format 3 scope ends with byte-identical files under the old and new defaults', async () => {
    // Only the clock is fixed, so the files' timestamps match; timers and IO
    // stay real.
    jest.useFakeTimers({
      now: 1_800_000_000_000,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    const base = join(root, 'base');
    const { backend } = await seed(base);
    backend.releaseJournal();
    const before = join(root, 'before');
    const after = join(root, 'after');
    await cp(base, before, { recursive: true });
    await cp(base, after, { recursive: true });

    await exercise(BEFORE, before);
    await exercise(AFTER, after);

    const expected = await contents(before);
    expect(await contents(after)).toEqual(expected);
    expect(await ChatStorageV2.fromLegacyPaths(pathsAt(after)).format()).toBe(
      'v3',
    );
    // Neither the format 4 journal nor any stream metadata exists, so the
    // incremental metadata writer had nothing to write.
    for (const path of Object.keys(expected)) {
      expect(path).not.toMatch(/delta-journal-v2\.log$/);
      expect(path).not.toMatch(/transcripts\/delegations\//);
    }
  });

  it('never attempts a promotion, so the failed-promotion retry path cannot start', async () => {
    const { store, backend } = await seed();
    backend.releaseJournal();
    const promote = jest.spyOn(writerModule, 'promoteToFormat4Journal');
    const target = repository(AFTER);
    await target.getState(scope);
    for (let index = 0; index < 3; index += 1) {
      await target.transact(
        scope,
        [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: message(`turn-${index}`, 'Activity', 'user'),
          },
        ],
        { source: 'provider', mutationId: `turn-${index}` },
      );
      expect(await target.generationStoreReadiness(scope)).toEqual({
        formatVersion: 3,
        enableFormat4: true,
        promotes: false,
      });
    }
    await target.flushScope(scope);
    expect(promote).not.toHaveBeenCalled();
    expect(await store.format()).toBe('v3');
  });
});

describe('the promotion stop switch (CAN-6192)', () => {
  /** The options a normal build passes, with the flag under the test's control. */
  function switched(flag: { on: boolean }): ChatStateV2RepositoryOptions {
    return { ...PROMOTING, format4Promotion: () => flag.on };
  }

  it('with the switch off a format 3 scope stays format 3 and its spawns stay legacy', async () => {
    const { store, backend } = await seed();
    backend.releaseJournal();
    const target = repository(switched({ on: false }));
    await target.getState(scope);
    expect(await store.format()).toBe('v3');
    expect(await target.generationStoreReadiness(scope)).toEqual({
      formatVersion: 3,
      enableFormat4: true,
      promotes: false,
    });
    expect(await store.format()).toBe('v3');
  });

  it('with the switch on a format 3 scope promotes on load', async () => {
    const { store, backend } = await seed();
    backend.releaseJournal();
    const target = repository(switched({ on: true }));
    await target.getState(scope);
    expect(await store.format()).toBe('v4');
    expect(await target.generationStoreReadiness(scope)).toMatchObject({
      formatVersion: 4,
    });
  });

  it('turning the switch off keeps a promoted scope in format 4 with stream generations', async () => {
    const { store, backend } = await seed();
    backend.releaseJournal();
    const flag = { on: true };
    const promoting = repository(switched(flag));
    await promoting.getState(scope);
    await promoting.openChildStream(scope, delegate('first', 1));
    await promoting.commitChildStream(scope, delegate('first', 1), 'first-0', [
      childRow('first', 0, 'Before the switch went off'),
    ]);
    await promoting.flushScope(scope);
    await promoting.drainAll();
    expect(await store.format()).toBe('v4');

    flag.on = false;
    const stopped = repository(switched(flag));
    expect(await stopped.generationStoreReadiness(scope)).toMatchObject({
      formatVersion: 4,
      enableFormat4: true,
    });
    await stopped.openChildStream(scope, delegate('first', 2));
    const after = childRow('first', 0, 'After the switch went off');
    const committed = await stopped.commitChildStream(
      scope,
      delegate('first', 2),
      'first-2-0',
      [after],
    );
    await stopped.flushScope(scope);
    expect(
      await stopped.getChildStreamMessage(
        scope,
        delegate('first', 2),
        after.id,
        committed.descriptor.streamRevision,
      ),
    ).toEqual(after);
    expect(await store.format()).toBe('v4');
  });

  it('turning the switch off while a failed promotion’s retry is due stops reconciling until it is back on', async () => {
    const { store, backend } = await seed();
    backend.releaseJournal();
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let attempts = 0;
    const flag = { on: true };
    const target = repository({
      ...switched(flag),
      deltaJournalPromotionRetryMs: 10,
      deltaJournalOnBoundary: (point) => {
        if (point === 'catalog-temp-written') {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error('first-fault'));
        }
        return Promise.resolve();
      },
    });
    await target.getState(scope);
    expect(attempts).toBe(1);
    expect(await store.format()).toBe('v3');

    // The retry's backoff passes and the scope sees activity, so the retry is
    // due, but the switch is now off. Cap the reconciliation loop so a
    // regression fails here instead of spinning forever.
    flag.on = false;
    now += 10;
    const wantsRepromotion: unknown = Reflect.get(
      ChatStateV2Backend.prototype,
      'wantsRepromotion',
    );
    if (typeof wantsRepromotion !== 'function')
      throw new Error('wantsRepromotion is missing');
    let asked = 0;
    jest
      .spyOn(ChatStateV2Backend.prototype, 'wantsRepromotion')
      .mockImplementation(function (this: ChatStateV2Backend): boolean {
        asked += 1;
        if (asked > 200) return false;
        const due: unknown = Reflect.apply(wantsRepromotion, this, []);
        return due === true;
      });
    for (let index = 0; index < 2; index += 1) {
      await target.transact(
        scope,
        [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: message(`off-${index}`, 'While the switch is off', 'user'),
          },
        ],
        { source: 'provider', mutationId: `off-${index}` },
      );
      await target.getRevision(scope);
    }
    // The runaway loop queues itself after each reconcile, so give it real
    // time to show.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(asked).toBeLessThan(20);
    expect(attempts).toBe(1);
    expect(await store.format()).toBe('v3');

    // Back on, the kept retry runs at the next activity.
    flag.on = true;
    await target.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('on-again', 'The switch is back on', 'user'),
        },
      ],
      { source: 'provider', mutationId: 'on-again' },
    );
    await target.getRevision(scope);
    expect(attempts).toBe(2);
    expect(await store.format()).toBe('v4');
  });

  it('turning the switch on promotes a loaded format 3 scope at its next spawn, not only after a reload', async () => {
    const { store, backend } = await seed();
    backend.releaseJournal();
    const flag = { on: false };
    const target = repository(switched(flag));
    await target.getState(scope);
    expect(await store.format()).toBe('v3');
    flag.on = true;
    expect(await target.generationStoreReadiness(scope)).toEqual({
      formatVersion: 4,
      enableFormat4: true,
      promotes: false,
    });
    expect(await store.format()).toBe('v4');
  });
});

describe('an older reader refuses a promoted scope', () => {
  it('a format 3 reader refuses with a newer-format error and changes no byte', async () => {
    const { store, backend } = await seed();
    backend.releaseJournal();
    const promoting = repository(PROMOTING);
    await promoting.getState(scope);
    await promoting.openChildStream(scope, delegate('first', 1));
    await promoting.commitChildStream(scope, delegate('first', 1), 'first-0', [
      childRow('first', 0, 'Before the downgrade'),
    ]);
    await promoting.flushScope(scope);
    await promoting.drainAll();
    expect(await store.format()).toBe('v4');

    const before = await snapshotFormat4Files(root);
    const older = ChatStorageV2.fromLegacyPaths(pathsAt(root), {
      maxManifestVersion: 3,
    });
    const reader = new ChatStateV2Backend(older, { deltaJournal: {} });
    await expect(reader.load()).rejects.toBeInstanceOf(
      ChatStorageNewerFormatError,
    );
    reader.releaseJournal();
    await reader.disposeArtifactMaintenance();
    expect(await snapshotFormat4Files(root)).toEqual(before);
  });
});
