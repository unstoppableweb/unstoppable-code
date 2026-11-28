import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { StorageOwnershipRow } from '../../../storage';
import { StorageRowOwnerError } from '../../../storage/owner-records';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import { assertRowWritable, ownerFlipRecordFile } from '../../storage-records';
import type { PreferencesCodec } from '../codec';
import {
  createDaemonPreferences,
  type DaemonPreferencesOptions,
} from '../daemon-document';
import { PREFERENCES_BACKUPS_FOLDER } from '../family';
import {
  activatePreferencesOwnerFlip,
  type PreferencesOwnerFlipCheckpoint,
  type PreferencesOwnerFlipOptions,
} from '../owner-flip-activation';

const USAGE = ['productAnalytics'] as const;
type Usage = (typeof USAGE)[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(payload: Record<string, unknown>): Record<string, unknown> {
  const usage = isObject(payload.usageData) ? payload.usageData : {};
  return {
    ...payload,
    editorFont:
      typeof payload.editorFont === 'string' ? payload.editorFont : 'default',
    usageData: { productAnalytics: usage.productAnalytics !== false },
  };
}

const codec: PreferencesCodec<Record<string, unknown>> = {
  defaults: normalize({}),
  normalize,
  project: (value) => normalize(value),
  inspect: () => null,
  merge: (existing, patch) => normalize({ ...existing, ...patch }),
};

/** The compiled rows with the preferences row flipped to the daemon. */
const FLIPPED = STORAGE_OWNERSHIP.map((row) =>
  row.id === 'preferences'
    ? { ...row, transitionOwner: 'daemon' as const }
    : row,
);

const PRIMARY = 'preferences.json';
const LAST_GOOD = 'preferences.last-good.json';
const GENERATION = 'preferences.generation.json';

let roots: string[];
beforeEach(() => {
  roots = [];
});
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  // Real path: the backup flushes each folder up to the data root's.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'preferences-flip-'));
  roots.push(root);
  return root;
}

const envelope = (
  version: number,
  generation: number | undefined,
  preferences: Record<string, unknown>,
): string =>
  JSON.stringify(
    generation === undefined
      ? { version, preferences }
      : { version, generation, preferences },
    null,
    2,
  );

/** A profile an Electron build before the flip saved at generation 3. */
function seedPreFlip(at: string): void {
  writeFileSync(join(at, PRIMARY), envelope(1, 3, { editorFont: 'dark' }));
  writeFileSync(join(at, LAST_GOOD), envelope(1, 3, { editorFont: 'dark' }));
  writeFileSync(
    join(at, GENERATION),
    JSON.stringify({ version: 1, generation: 3 }),
  );
}

function read(at: string, name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(at, name), 'utf8'));
  if (!isObject(parsed)) throw new Error(`${name} is not a record`);
  return parsed;
}

/** Every file under `at`, with its bytes, so a case can prove nothing changed. */
function tree(at: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(path, 'utf8');
    }
  };
  walk(at, '');
  return files;
}

function openPreferences(
  at: string,
  overrides: Partial<DaemonPreferencesOptions<Usage>> = {},
): ReturnType<typeof createDaemonPreferences> {
  return createDaemonPreferences({
    dataRoot: at,
    codec,
    usageDataKeys: USAGE,
    syncDirectory: () => Promise.resolve('flushed'),
    ownership: FLIPPED,
    writeVersion: 2,
    log: { error: jest.fn(), warn: jest.fn() },
    ...overrides,
  });
}

type Options = PreferencesOwnerFlipOptions<Record<string, unknown>>;

function launch(at: string, overrides: Partial<Options> = {}): Options {
  return {
    dataRoot: at,
    repository: openPreferences(at).repository,
    preFlipWriters: () => Promise.resolve([]),
    quiesce: (operation) => operation(),
    isOutsideCheckouts: () => true,
    // Refuses a flush of anything but an existing folder.
    syncDirectory: (path) =>
      Promise.resolve(statSync(path).isDirectory() ? 'flushed' : 'unsupported'),
    flushRequiresWriteHandle: false,
    ownership: FLIPPED,
    clock: () => Date.parse('2026-11-26T12:00:00.000Z'),
    log: { error: jest.fn(), warn: jest.fn() },
    ...overrides,
  };
}

/** The owner record and the persisted backup record it cites, checked against each other. */
function ownerAndBackup(at: string): {
  owner: Record<string, unknown>;
  backup: Record<string, unknown>;
} {
  const owner = read(at, 'storage-records/preferences/owner-flip.json');
  const backup = read(at, 'storage-records/preferences/namespace-backup.json');
  const verifiedBy = backup.verifiedBy;
  if (!isObject(verifiedBy) || typeof verifiedBy.digest !== 'string')
    throw new Error('the backup record has no digest');
  expect(owner).toMatchObject({
    namespaceId: 'preferences',
    fromOwner: 'legacy',
    toOwner: 'daemon',
    workPackage: 'W5',
    backupRecord: `storage-records/preferences/namespace-backup.json#sha256:${verifiedBy.digest}`,
  });
  if (typeof backup.backupPath !== 'string')
    throw new Error('the backup record has no path');
  expect(existsSync(join(at, backup.backupPath))).toBe(true);
  return { owner, backup };
}

describe('preference owner-flip activation (CAN-8052): admission', () => {
  it('under the compiled rows is inert: it reads, waits for and writes nothing', async () => {
    const root = newRoot();
    seedPreFlip(root);
    const before = tree(root);
    const preFlipWriters = jest.fn(() => Promise.resolve([]));
    let quiesced = 0;
    await expect(
      activatePreferencesOwnerFlip(
        launch(root, {
          ownership: STORAGE_OWNERSHIP,
          repository: openPreferences(root, { ownership: STORAGE_OWNERSHIP })
            .repository,
          preFlipWriters,
          quiesce: (operation) => {
            quiesced += 1;
            return operation();
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'inert' });
    expect(preFlipWriters).not.toHaveBeenCalled();
    expect(quiesced).toBe(0);
    expect(tree(root)).toEqual(before);
  });

  it('defers while a writer from before the flip is live, or when the peers cannot be listed', async () => {
    const root = newRoot();
    seedPreFlip(root);
    const before = tree(root);
    await expect(
      activatePreferencesOwnerFlip(
        launch(root, { preFlipWriters: () => Promise.resolve(['electron']) }),
      ),
    ).resolves.toEqual({ kind: 'deferred', peers: ['electron'] });
    await expect(
      activatePreferencesOwnerFlip(
        launch(root, {
          preFlipWriters: () => Promise.reject(new Error('no presence')),
        }),
      ),
    ).resolves.toEqual({ kind: 'deferred', peers: ['unknown'] });
    expect(tree(root)).toEqual(before);
  });

  it('leaves a row a rollback returned, or whose record cannot be read, untouched', async () => {
    const root = newRoot();
    seedPreFlip(root);
    const record = ownerFlipRecordFile(root, 'preferences');
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, '{ torn');
    const torn = tree(root);
    await expect(
      activatePreferencesOwnerFlip(launch(root)),
    ).resolves.toMatchObject({ kind: 'record-unreadable' });
    expect(tree(root)).toEqual(torn);

    writeFileSync(
      record,
      JSON.stringify({
        namespaceId: 'preferences',
        fromOwner: 'daemon',
        toOwner: 'legacy',
        workPackage: 'W5',
        backupRecord: `storage-records/preferences/namespace-backup.json#sha256:${'a'.repeat(64)}`,
        flippedAt: '2026-11-26T11:00:00.000Z',
      }),
    );
    const returned = tree(root);
    await expect(activatePreferencesOwnerFlip(launch(root))).resolves.toEqual({
      kind: 'owned-elsewhere',
      owner: 'legacy',
    });
    expect(tree(root)).toEqual(returned);
  });
});

describe('preference owner-flip activation (CAN-8052): T8', () => {
  it('backs up the family as it was, writes version 2, records the daemon, then stays active', async () => {
    const root = newRoot();
    seedPreFlip(root);
    const preFlip = readFileSync(join(root, PRIMARY), 'utf8');
    const preferences = openPreferences(root);
    const order: string[] = [];
    const outcome = await activatePreferencesOwnerFlip(
      launch(root, {
        repository: preferences.repository,
        quiesce: async (operation) => {
          order.push('quiesce');
          const result = await operation();
          order.push('admit');
          return result;
        },
        checkpoint: (point) => {
          order.push(point);
        },
      }),
    );
    expect(outcome.kind).toBe('activated');
    expect(order).toEqual([
      'quiesce',
      'quiesced',
      'backed-up',
      'written',
      'recorded',
      'admit',
    ]);
    expect(read(root, PRIMARY)).toEqual({
      version: 2,
      generation: 4,
      preferences: normalize({ editorFont: 'dark' }),
    });
    // Last-good follows through the refresher (Q2).
    await preferences.repository.flush();
    expect(read(root, LAST_GOOD)).toMatchObject({ version: 2, generation: 4 });

    const { backup } = ownerAndBackup(root);
    expect(String(backup.backupPath)).toMatch(
      new RegExp(`^${PREFERENCES_BACKUPS_FOLDER}/owner-flip-`),
    );
    // The backup holds the family from before the flip.
    expect(
      readFileSync(join(root, String(backup.backupPath), PRIMARY), 'utf8'),
    ).toBe(preFlip);

    // Electron's writer is refused from here; the daemon's is admitted.
    await expect(
      assertRowWritable(root, 'preferences', 'electron_main'),
    ).rejects.toBeInstanceOf(StorageRowOwnerError);
    await preferences.repository.update(() => ({ editorFont: 'light' }));
    await preferences.repository.flush();
    expect(read(root, PRIMARY)).toMatchObject({ version: 2, generation: 5 });

    const after = tree(root);
    await expect(activatePreferencesOwnerFlip(launch(root))).resolves.toEqual({
      kind: 'active',
    });
    expect(tree(root)).toEqual(after);
  });

  it('a fresh profile is recorded without writing a document', async () => {
    const root = newRoot();
    await expect(
      activatePreferencesOwnerFlip(launch(root)),
    ).resolves.toMatchObject({ kind: 'activated' });
    expect(existsSync(join(root, PRIMARY))).toBe(false);
    ownerAndBackup(root);
  });

  it.each<PreferencesOwnerFlipCheckpoint>([
    'quiesced',
    'backed-up',
    'written',
    'recorded',
  ])('a restart after %s completes the activation once', async (crashAt) => {
    const root = newRoot();
    seedPreFlip(root);
    const preFlip = readFileSync(join(root, PRIMARY), 'utf8');
    const crash = new Error(`crashed at ${crashAt}`);
    const crashed = openPreferences(root).repository;
    await expect(
      activatePreferencesOwnerFlip(
        launch(root, {
          repository: crashed,
          checkpoint: (point) => {
            if (point === crashAt) throw crash;
          },
        }),
      ),
    ).rejects.toBe(crash);
    // A crash also ends the last-good refresh a save started.
    await crashed.flush();

    const restartedRepository = openPreferences(root).repository;
    const restarted = await activatePreferencesOwnerFlip(
      launch(root, {
        repository: restartedRepository,
        clock: () => Date.parse('2026-11-26T12:05:00.000Z'),
      }),
    );
    await restartedRepository.flush();
    expect(restarted.kind).toBe(
      crashAt === 'recorded' ? 'active' : 'activated',
    );
    // Version 2 is written once, whichever launch wrote it.
    expect(read(root, PRIMARY)).toEqual({
      version: 2,
      generation: 4,
      preferences: normalize({ editorFont: 'dark' }),
    });
    expect(read(root, GENERATION)).toEqual({ version: 1, generation: 4 });
    const { backup } = ownerAndBackup(root);
    // One copy, the cited one. Before version 2 was written, the restart
    // reuses the copy it had; after, it takes another of version 2.
    const copies = readdirSync(join(root, PREFERENCES_BACKUPS_FOLDER));
    expect(copies).toHaveLength(1);
    expect(backup.backupPath).toBe(
      `${PREFERENCES_BACKUPS_FOLDER}/${copies[0]}`,
    );
    const copied = readFileSync(
      join(root, PREFERENCES_BACKUPS_FOLDER, copies[0], PRIMARY),
      'utf8',
    );
    if (crashAt === 'written')
      expect(JSON.parse(copied)).toMatchObject({ version: 2, generation: 4 });
    else expect(copied).toBe(preFlip);

    const settled = tree(root);
    await expect(activatePreferencesOwnerFlip(launch(root))).resolves.toEqual({
      kind: 'active',
    });
    expect(tree(root)).toEqual(settled);
  });

  it('a failed backup still serves version 2, and a later launch writes the backup and the record', async () => {
    const root = newRoot();
    seedPreFlip(root);
    const log = { error: jest.fn(), warn: jest.fn() };
    const preferences = openPreferences(root);
    // The copy is written, then a folder flush under it is not confirmed.
    const failing = await activatePreferencesOwnerFlip(
      launch(root, {
        repository: preferences.repository,
        log,
        syncDirectory: (path) =>
          Promise.resolve(
            path.includes(`${join('backups', 'preferences')}`)
              ? 'unsupported'
              : 'flushed',
          ),
      }),
    );
    expect(failing).toMatchObject({ kind: 'pending', step: 'backup' });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(read(root, PRIMARY)).toMatchObject({ version: 2, generation: 4 });
    // The failed backup removed its copy, and nothing cites one.
    expect(readdirSync(join(root, PREFERENCES_BACKUPS_FOLDER))).toEqual([]);
    expect(existsSync(join(root, 'storage-records'))).toBe(false);
    // Serving: the daemon writes. Until a record lands, so may Electron (gate 3).
    await preferences.repository.update(() => ({ editorFont: 'light' }));
    await preferences.repository.flush();
    await expect(
      assertRowWritable(root, 'preferences', 'electron_main'),
    ).resolves.toBeUndefined();

    // A backup refused before any copy is retried the same way.
    await expect(
      activatePreferencesOwnerFlip(
        launch(root, { isOutsideCheckouts: () => false }),
      ),
    ).resolves.toMatchObject({ kind: 'pending', step: 'backup' });

    const later = await activatePreferencesOwnerFlip(launch(root));
    expect(later.kind).toBe('activated');
    const { backup } = ownerAndBackup(root);
    expect(read(root, join(String(backup.backupPath), PRIMARY))).toMatchObject({
      version: 2,
      generation: 5,
      preferences: { editorFont: 'light' },
    });
  });

  it('does not record the owner when version 2 cannot be written', async () => {
    const root = newRoot();
    // A newer format latches recovery, so no save can convert it.
    writeFileSync(join(root, PRIMARY), envelope(3, 3, { editorFont: 'dark' }));
    const log = { error: jest.fn(), warn: jest.fn() };
    await expect(
      activatePreferencesOwnerFlip(launch(root, { log })),
    ).resolves.toMatchObject({ kind: 'pending', step: 'envelope' });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(read(root, PRIMARY)).toMatchObject({ version: 3 });
    expect(existsSync(ownerFlipRecordFile(root, 'preferences'))).toBe(false);
    // Every launch retries; an unchanged family keeps its one copy.
    const copies = readdirSync(join(root, PREFERENCES_BACKUPS_FOLDER));
    expect(copies).toHaveLength(1);
    for (let retry = 0; retry < 2; retry += 1)
      await expect(
        activatePreferencesOwnerFlip(launch(root)),
      ).resolves.toMatchObject({ kind: 'pending', step: 'envelope' });
    expect(readdirSync(join(root, PREFERENCES_BACKUPS_FOLDER))).toEqual(copies);

    // A repository composed to write version 1 never earns the record either.
    const v1 = newRoot();
    seedPreFlip(v1);
    await expect(
      activatePreferencesOwnerFlip(
        launch(v1, {
          repository: openPreferences(v1, { writeVersion: 1 }).repository,
        }),
      ),
    ).resolves.toMatchObject({ kind: 'pending', step: 'envelope' });
    expect(existsSync(ownerFlipRecordFile(v1, 'preferences'))).toBe(false);
  });
});

/**
 * A v1.16.1 recovery of a version 2 file: backs it up under its name, with
 * no random tail, writes version 1 defaults and leaves the record.
 */
function resetByOlderBuild(
  at: string,
  stamp = '2026-11-26T13-00-00-000Z',
): string {
  const raw = readFileSync(join(at, PRIMARY), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error('primary is not a record');
  const backup = `preferences.backup-${stamp}.json`;
  writeFileSync(
    join(at, backup),
    JSON.stringify(
      {
        ...parsed,
        __error: { reason: 'version', message: 'Unsupported.' },
        rawContent: raw,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(at, PRIMARY), envelope(1, undefined, {}));
  writeFileSync(join(at, LAST_GOOD), envelope(1, undefined, {}));
  return backup;
}

/** A flip daemon's version 2 family at generation 5. */
function seedFlipped(at: string): void {
  writeFileSync(join(at, PRIMARY), envelope(2, 5, { editorFont: 'dark' }));
  writeFileSync(join(at, LAST_GOOD), envelope(2, 5, { editorFont: 'dark' }));
  writeFileSync(
    join(at, GENERATION),
    JSON.stringify({ version: 1, generation: 5 }),
  );
}

describe('preference owner-flip activation (CAN-8052): silent restore', () => {
  it('serves a qualifying version 2 backup over a version 1 primary, then saves it at version 2', async () => {
    const root = newRoot();
    seedFlipped(root);
    const backup = resetByOlderBuild(root);
    const reset = tree(root);
    const log = { error: jest.fn(), warn: jest.fn() };
    const { repository } = openPreferences(root, { log });
    await expect(repository.read('runtime')).resolves.toMatchObject({
      editorFont: 'dark',
    });
    await expect(repository.readAuthority()).resolves.toMatchObject({
      authority: 'ok',
      preferences: { editorFont: 'dark' },
    });
    await expect(repository.readStoredPayload()).resolves.toMatchObject({
      kind: 'read',
      source: 'primary',
      payload: { editorFont: 'dark' },
    });
    // A read writes nothing and shows nothing; the restore is logged once.
    expect(tree(root)).toEqual(reset);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), {
      backupPath: join(root, backup),
      generation: 5,
    });
    expect(log.error).not.toHaveBeenCalled();

    await repository.update(() => ({ usageData: { productAnalytics: true } }));
    expect(read(root, PRIMARY)).toEqual({
      version: 2,
      generation: 6,
      preferences: normalize({ editorFont: 'dark' }),
    });
  });

  it('restores with no generation record, and catches a reset made while the daemon runs', async () => {
    const root = newRoot();
    seedFlipped(root);
    const { repository } = openPreferences(root);
    await expect(repository.read('runtime')).resolves.toMatchObject({
      editorFont: 'dark',
    });
    resetByOlderBuild(root);
    unlinkSync(join(root, GENERATION));
    await expect(repository.read('runtime')).resolves.toMatchObject({
      editorFont: 'dark',
    });
  });

  it('serves the restore to a read between the save’s record and its primary, and drops it once a later save is stored', async () => {
    const root = newRoot();
    seedFlipped(root);
    resetByOlderBuild(root);
    const midSave: unknown[] = [];
    let armed = false;
    const preferences = openPreferences(root, {
      // A save installs the record, then the primary; each install flushes.
      syncDirectory: async () => {
        const raised =
          read(root, GENERATION).generation === 6 &&
          read(root, PRIMARY).version === 1;
        if (armed && raised) {
          armed = false;
          midSave.push(await preferences.repository.readStoredPayload());
        }
        return 'flushed';
      },
    });
    const { repository } = preferences;
    await expect(repository.read('runtime')).resolves.toMatchObject({
      editorFont: 'dark',
    });
    armed = true;
    await repository.update(() => ({ usageData: { productAnalytics: true } }));
    expect(midSave).toEqual([
      expect.objectContaining({ payload: { editorFont: 'dark' } }),
    ]);

    // A build that bumps the record saves version 1 over it: kept as saved.
    writeFileSync(join(root, PRIMARY), envelope(1, 7, { editorFont: 'light' }));
    writeFileSync(
      join(root, GENERATION),
      JSON.stringify({ version: 1, generation: 7 }),
    );
    await expect(repository.read('runtime')).resolves.toMatchObject({
      editorFont: 'light',
    });
  });

  it('keeps a version 1 primary without a qualifying backup', async () => {
    const kept = async (
      prepare: (at: string) => void,
      ownership: readonly StorageOwnershipRow[] = FLIPPED,
    ): Promise<unknown> => {
      const root = newRoot();
      seedFlipped(root);
      resetByOlderBuild(root);
      prepare(root);
      const before = tree(root);
      const { repository } = openPreferences(root, { ownership });
      const value = await repository.read('runtime');
      expect(tree(root)).toEqual(before);
      return value;
    };
    const defaults: unknown = expect.objectContaining({
      editorFont: 'default',
    });

    // A build that bumps the record saved after the reset.
    await expect(
      kept((at) => {
        writeFileSync(
          join(at, PRIMARY),
          envelope(1, 6, { editorFont: 'light' }),
        );
        writeFileSync(
          join(at, GENERATION),
          JSON.stringify({ version: 1, generation: 6 }),
        );
      }),
    ).resolves.toMatchObject({ editorFont: 'light' });
    // The newest backup is not a version 2 envelope.
    await expect(
      kept((at) =>
        writeFileSync(
          join(
            at,
            'preferences.backup-2026-11-26T14-00-00-000Z-0b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.json',
          ),
          JSON.stringify({
            version: 1,
            preferences: { editorFont: 'other' },
            __error: {},
          }),
        ),
      ),
    ).resolves.toEqual(defaults);
    // An unreadable generation record proves nothing.
    await expect(
      kept((at) => writeFileSync(join(at, GENERATION), '{ torn')),
    ).resolves.toEqual(defaults);
    // A version 2 backup whose generation is not a valid one.
    await expect(
      kept((at) => {
        for (const name of readdirSync(at))
          if (name.startsWith('preferences.backup-'))
            writeFileSync(
              join(at, name),
              JSON.stringify({
                version: 2,
                generation: -1,
                preferences: { editorFont: 'dark' },
              }),
            );
      }),
    ).resolves.toEqual(defaults);
    // No backup at all.
    await expect(
      kept((at) => {
        for (const name of readdirSync(at))
          if (name.startsWith('preferences.backup-'))
            unlinkSync(join(at, name));
      }),
    ).resolves.toEqual(defaults);
    // Under the compiled rows the restore is off.
    await expect(kept(() => undefined, STORAGE_OWNERSHIP)).resolves.toEqual(
      defaults,
    );
  });
});
