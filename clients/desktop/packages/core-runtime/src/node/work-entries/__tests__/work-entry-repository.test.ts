import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createWorkEntryRepository,
  workEntryRegistryRevision,
  WorkEntryRegistryRevisionConflictError,
  WorkEntryRowIncarnationConflictError,
  type WorkEntryRegistryFile,
  type WorkEntryRegistryReconciliation,
  type WorkEntryRepository,
} from '..';

interface Row {
  id: string;
  createdAt: string;
  pinned?: boolean;
}

const T0 = '2026-11-20T10:00:00.000Z';
const T1 = '2026-11-20T11:00:00.000Z';
const COWORK = 'cowork-1';
const BOT = 'bot--helper';

function isRow(value: unknown): value is Row {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'createdAt' in value &&
    typeof value.createdAt === 'string'
  );
}

function parse(text: string): WorkEntryRegistryFile<Row> {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('entries' in parsed) ||
    !Array.isArray(parsed.entries) ||
    !parsed.entries.every(isRow)
  )
    throw new Error('Invalid work-entry registry');
  return { version: 1, entries: parsed.entries.filter(isRow) };
}

const bytes = (entries: Row[]): string =>
  JSON.stringify({ version: 1, entries }, null, 2);

let root: string;
let renameHook: ((source: string, target: string) => Promise<void>) | undefined;
let reconciliation: Partial<WorkEntryRegistryReconciliation<Row>> | undefined;
let listChanged: string[];
let published: string[];
let writerChecks: number;
let repository: WorkEntryRepository<Row>;

function registryPath(workspaceId: string): string {
  const family =
    workspaceId.startsWith('bot--') || workspaceId === 'app-advisor'
      ? 'app-workspaces'
      : 'workspaces';
  return join(root, family, workspaceId, 'work-entries.json');
}

const raw = (workspaceId: string): Promise<string> =>
  readFile(registryPath(workspaceId), 'utf8');

async function seed(workspaceId: string, text: string): Promise<void> {
  await mkdir(dirname(registryPath(workspaceId)), { recursive: true });
  await writeFile(registryPath(workspaceId), text, 'utf8');
}

async function strays(workspaceId: string): Promise<string[]> {
  return (await readdir(dirname(registryPath(workspaceId)))).filter((name) =>
    name.endsWith('.tmp'),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'work-entry-repository-'));
  renameHook = undefined;
  reconciliation = undefined;
  listChanged = [];
  published = [];
  writerChecks = 0;
  repository = createWorkEntryRepository<Row>({
    registryPath,
    io: {
      readText: (path) =>
        readFile(path, 'utf8').catch((error: unknown) => {
          // Not `instanceof Error`: fs errors can come from another realm.
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return null;
          throw error;
        }),
      exists: (path) =>
        stat(path).then(
          () => true,
          () => false,
        ),
      async mkdirParent(path) {
        await mkdir(dirname(path), { recursive: true });
      },
      tempPath: (path) =>
        join(dirname(path), `.work-entries-${randomUUID()}.tmp`),
      writeFile: (path, data) => writeFile(path, data, 'utf8'),
      rename: (source, target) =>
        renameHook ? renameHook(source, target) : rename(source, target),
      unlink: (path) => unlink(path),
    },
    codec: { parse, serialize: (file) => JSON.stringify(file, null, 2) },
    reconciler: () =>
      reconciliation === undefined
        ? undefined
        : (
            _workspaceId,
            entries,
          ): Promise<WorkEntryRegistryReconciliation<Row>> =>
            Promise.resolve({ ...reconciliation, rows: entries }),
    publishGroups: (workspaceId) => published.push(workspaceId),
    onListChanged: (workspaceId) => listChanged.push(workspaceId),
    assertWriter: () => {
      writerChecks += 1;
    },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Work Entry repository with injected roots (CAN-4476)', () => {
  test('writes under both roots through one atomic install each', async () => {
    for (const workspaceId of [COWORK, BOT]) {
      await repository.transact(workspaceId, async (tx) => {
        const file = await tx.read();
        await tx.write({
          version: 1,
          entries: [...file.entries, { id: 'a', createdAt: T0 }],
        });
      });
      expect(await raw(workspaceId)).toBe(bytes([{ id: 'a', createdAt: T0 }]));
      expect(await strays(workspaceId)).toEqual([]);
    }
    expect(registryPath(BOT)).toContain(join('app-workspaces', BOT));
    expect(writerChecks).toBe(2);
    expect(listChanged).toEqual([]);
    await expect(repository.rowState(COWORK, 'a')).resolves.toBe('present');
    await expect(repository.rowState(COWORK, 'b')).resolves.toBe('absent');
    await expect(repository.rowState('cowork-2', 'a')).resolves.toBe(
      'missing-registry',
    );
  });

  test('a refused install rolls the group back, or reports both failures', async () => {
    const a = { id: 'a', createdAt: T0 };
    await seed(COWORK, bytes([a]));
    renameHook = (): Promise<void> =>
      Promise.reject(
        Object.assign(new Error('registry EACCES'), { code: 'EACCES' }),
      );
    const rollbacks: string[] = [];
    reconciliation = {
      rollback: (): Promise<void> => {
        rollbacks.push('rollback');
        return Promise.resolve();
      },
    };
    const write = (): Promise<void> =>
      repository.transact(COWORK, (tx) =>
        tx.write({ version: 1, entries: [{ ...a, pinned: true }] }),
      );
    await expect(write()).rejects.toMatchObject({
      message: 'registry EACCES',
    });
    expect(rollbacks).toEqual(['rollback']);

    reconciliation = {
      rollback: (): Promise<void> =>
        Promise.reject(new Error('group rollback')),
    };
    await expect(write()).rejects.toMatchObject({
      message: 'Registry write and group rollback failed',
      errors: [
        expect.objectContaining({ message: 'registry EACCES' }),
        expect.objectContaining({ message: 'group rollback' }),
      ],
    });
    // A refused grouped write without a reconciler never reaches the disk.
    reconciliation = undefined;
    renameHook = undefined;
    await expect(
      repository.transact(COWORK, (tx) =>
        tx.write({ version: 1, entries: [] }, { sidebarItemGroupId: 'g' }),
      ),
    ).rejects.toMatchObject({
      message: 'Sidebar item group service is not initialized',
    });
    expect(await raw(COWORK)).toBe(bytes([a]));
    expect(await strays(COWORK)).toEqual([]);
    expect(published).toEqual([]);
  });

  test('a retire during a write keeps the installed bytes and fences the queue', async () => {
    const a = { id: 'a', createdAt: T0 };
    await seed(COWORK, bytes([a]));
    let retired: Promise<unknown> | undefined;
    renameHook = async (source, target): Promise<void> => {
      await rename(source, target);
      retired ??= repository.retire(COWORK);
    };
    const rollbacks: string[] = [];
    reconciliation = {
      rollback: (): Promise<void> => {
        rollbacks.push('rollback');
        return Promise.resolve();
      },
    };
    const deleted = {
      message: `Work Entry project has been deleted: ${COWORK}`,
    };
    const first = repository.transact(COWORK, (tx) =>
      tx.write({ version: 1, entries: [{ ...a, pinned: true }] }),
    );
    // Queued behind the first write; the tombstone lands before it runs.
    const second = repository.removeRow(COWORK, 'a');
    await expect(first).rejects.toMatchObject(deleted);
    await expect(second).rejects.toMatchObject(deleted);
    await retired;
    // The post-rename admission check: the install stays, the group rolls back.
    expect(await raw(COWORK)).toBe(bytes([{ ...a, pinned: true }]));
    expect(rollbacks).toEqual(['rollback']);
    expect(repository.isRetired(COWORK)).toBe(true);
    await expect(repository.appendRows(COWORK, [])).rejects.toMatchObject(
      deleted,
    );
    expect(published).toEqual([]);
    expect(listChanged).toEqual([]);

    repository.activate(COWORK);
    await expect(repository.appendRows(COWORK, [a])).resolves.toBe(false);
    await expect(
      repository.appendRows(COWORK, [{ id: 'b', createdAt: T1 }]),
    ).resolves.toBe(true);
    expect(
      (await repository.readStrict(COWORK)).entries.map((r) => r.id),
    ).toEqual(['a', 'b']);
  });

  test('a failed transaction never blocks the next one in the queue', async () => {
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failing = repository.transact(COWORK, async () => {
      order.push('first');
      await gate;
      throw new Error('first failed');
    });
    const next = repository.transact(COWORK, async (tx) => {
      order.push('second');
      const file = await tx.read();
      await tx.write({
        version: 1,
        entries: [...file.entries, { id: 'a', createdAt: T0 }],
      });
      return 'second done';
    });
    release();
    await expect(failing).rejects.toMatchObject({ message: 'first failed' });
    await expect(next).resolves.toBe('second done');
    expect(order).toEqual(['first', 'second']);
    expect(await raw(COWORK)).toBe(bytes([{ id: 'a', createdAt: T0 }]));

    // A committed write whose follow-up failed signals the list on settle.
    await expect(
      repository.transact(COWORK, (tx) => {
        tx.invalidateOnSettle();
        return Promise.reject(new Error('group publish failed'));
      }),
    ).rejects.toMatchObject({ message: 'group publish failed' });
    expect(listChanged).toEqual([COWORK]);
  });

  test('a reorder must name every entry once', async () => {
    const a = { id: 'a', createdAt: T0 };
    const b = { id: 'b', createdAt: T1 };
    await seed(COWORK, bytes([a, b]));
    await repository.reorder(COWORK, ['b', 'a']);
    expect(await raw(COWORK)).toBe(bytes([b, a]));
    for (const ids of [['a'], ['a', 'a'], ['a', 'c']])
      await expect(repository.reorder(COWORK, ids)).rejects.toMatchObject({
        message: 'Work entry reorder does not match entries',
      });
    expect(await raw(COWORK)).toBe(bytes([b, a]));
  });

  test('an expected revision refuses a stale registry and passes a current one', async () => {
    const a = { id: 'a', createdAt: T0 };
    const b = { id: 'b', createdAt: T1 };
    const pinnedA = { ...a, pinned: true };
    await seed(COWORK, bytes([a, b]));
    const { file, revision } = await repository.readWithRevision(COWORK);
    expect(file.entries).toEqual([a, b]);
    expect(revision).toMatch(/^wer1-[0-9a-f]{32}$/);
    expect(revision).toBe(workEntryRegistryRevision([a, b]));
    // Order and row identity change the revision; a new createdAt is a new row.
    expect(workEntryRegistryRevision([b, a])).not.toBe(revision);
    expect(workEntryRegistryRevision([{ id: 'a', createdAt: T1 }, b])).not.toBe(
      revision,
    );
    await expect(repository.readWithRevision('cowork-2')).resolves.toEqual({
      file: { version: 1, entries: [] },
      revision: workEntryRegistryRevision([]),
    });

    // A display-field write keeps the revision, so a guarded write still runs.
    await repository.transact(COWORK, (tx) =>
      tx.write({ version: 1, entries: [pinnedA, b] }),
    );
    await expect(
      repository.transact(
        COWORK,
        async (tx) => (await tx.read()).entries.map((row) => row.pinned),
        { expectedRevision: revision },
      ),
    ).resolves.toEqual([true, undefined]);

    await repository.reorder(COWORK, ['b', 'a']);
    let ran = false;
    const staleTransaction = repository.transact(
      COWORK,
      () => {
        ran = true;
        return Promise.resolve();
      },
      { expectedRevision: revision },
    );
    await expect(staleTransaction).rejects.toBeInstanceOf(
      WorkEntryRegistryRevisionConflictError,
    );
    expect(ran).toBe(false);
    const stale = repository.reorder(COWORK, ['a', 'b'], {
      expectedRevision: revision,
    });
    await expect(stale).rejects.toBeInstanceOf(
      WorkEntryRegistryRevisionConflictError,
    );
    await expect(stale).rejects.toMatchObject({
      expected: revision,
      current: workEntryRegistryRevision([b, a]),
    });
    expect(await raw(COWORK)).toBe(bytes([b, pinnedA]));
    expect(listChanged).toEqual([]);

    const current = await repository.readWithRevision(COWORK);
    await repository.reorder(COWORK, ['a', 'b'], {
      expectedRevision: current.revision,
    });
    expect(await raw(COWORK)).toBe(bytes([pinnedA, b]));

    // An edit made on disk outside the repository is a conflict too.
    const beforeOutsideEdit = await repository.readWithRevision(COWORK);
    await seed(COWORK, bytes([pinnedA]));
    await expect(
      repository.reorder(COWORK, ['a'], {
        expectedRevision: beforeOutsideEdit.revision,
      }),
    ).rejects.toBeInstanceOf(WorkEntryRegistryRevisionConflictError);
    expect(await raw(COWORK)).toBe(bytes([pinnedA]));
  });

  test('a guarded write queued behind a retire reports the deletion', async () => {
    await seed(COWORK, bytes([{ id: 'a', createdAt: T0 }]));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = repository.transact(COWORK, () => gate);
    const guarded = repository.reorder(COWORK, ['a'], {
      expectedRevision: 'wer1-stale',
    });
    const retired = repository.retire(COWORK);
    release();
    await blocking;
    await expect(guarded).rejects.toMatchObject({
      message: `Work Entry project has been deleted: ${COWORK}`,
    });
    await retired;
  });

  test('a row removal with an expected createdAt refuses another incarnation', async () => {
    const a = { id: 'a', createdAt: T0 };
    const b = { id: 'b', createdAt: T1 };
    await seed(COWORK, bytes([a, b]));
    const stale = repository.removeRow(COWORK, 'a', { expectedCreatedAt: T1 });
    await expect(stale).rejects.toBeInstanceOf(
      WorkEntryRowIncarnationConflictError,
    );
    await expect(stale).rejects.toMatchObject({
      entryId: 'a',
      expectedCreatedAt: T1,
      currentCreatedAt: T0,
    });
    expect(await raw(COWORK)).toBe(bytes([a, b]));
    expect(writerChecks).toBe(0);
    expect(listChanged).toEqual([]);
    await repository.removeRow(COWORK, 'a', { expectedCreatedAt: T0 });
    expect(await raw(COWORK)).toBe(bytes([b]));
    // An absent row is already gone; without the guard nothing is refused.
    await repository.removeRow(COWORK, 'a', { expectedCreatedAt: T0 });
    await repository.removeRow(COWORK, 'b');
    expect(await raw(COWORK)).toBe(bytes([]));

    // A guarded removal queued behind a retire reports the deletion.
    await seed(COWORK, bytes([a]));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = repository.transact(COWORK, () => gate);
    const guarded = repository.removeRow(COWORK, 'a', {
      expectedCreatedAt: T1,
    });
    const retired = repository.retire(COWORK);
    release();
    await blocking;
    await expect(guarded).rejects.toMatchObject({
      message: `Work Entry project has been deleted: ${COWORK}`,
    });
    await retired;
  });

  test('an unstarted removal takes only the same, empty incarnation', async () => {
    const b = { id: 'b', createdAt: T1 };
    await seed(COWORK, bytes([b]));
    const removed: string[] = [];
    const unstarted = (createdAt: string, empty: boolean): Promise<boolean> =>
      repository.removeIfUnstarted(COWORK, 'b', createdAt, {
        isEmpty: () => Promise.resolve(empty),
        onRemoved: () => removed.push('b'),
      });
    await expect(unstarted(T0, true)).resolves.toBe(false);
    await expect(unstarted(T1, false)).resolves.toBe(false);
    expect(await raw(COWORK)).toBe(bytes([b]));
    await expect(unstarted(T1, true)).resolves.toBe(true);
    expect(await raw(COWORK)).toBe(bytes([]));
    expect(removed).toEqual(['b']);
  });

  test('a raw install keeps the bytes, refuses an invalid file and skips the reconciler', async () => {
    // Bytes that are not valid UTF-8 inside a string still parse, as cp kept them.
    const text = Buffer.concat([
      Buffer.from(
        `{"version":1,"entries":[{"id":"a","createdAt":"${T0}","t":"`,
      ),
      Buffer.from([0xff, 0xc3]),
      Buffer.from('"}]}\n'),
    ]);
    let reconciled = 0;
    reconciliation = {
      afterWrite: (): Promise<void> => {
        reconciled += 1;
        return Promise.resolve();
      },
    };
    await repository.installRaw(BOT, text);
    expect(await readFile(registryPath(BOT))).toEqual(text);
    expect(reconciled).toBe(0);
    expect(published).toEqual([]);
    expect(listChanged).toEqual([]);
    expect(writerChecks).toBe(1);

    await expect(
      repository.installRaw(BOT, Buffer.from('{"version":2}')),
    ).rejects.toMatchObject({ message: 'Invalid work-entry registry' });
    expect(await readFile(registryPath(BOT))).toEqual(text);
    expect(await strays(BOT)).toEqual([]);

    await repository.retire(BOT);
    await expect(repository.installRaw(BOT, text)).rejects.toMatchObject({
      message: `Work Entry project has been deleted: ${BOT}`,
    });
    await expect(repository.exists(BOT)).resolves.toBe(true);
    await expect(repository.readIfPresent('bot--missing')).resolves.toBeNull();
  });
});
