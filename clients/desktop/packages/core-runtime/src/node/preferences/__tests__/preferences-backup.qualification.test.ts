import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateNamespaceBackupRecord } from '../../../storage/backup-record';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import {
  PREFERENCES_BACKUPS_FOLDER,
  PREFERENCES_FAMILY_FILES,
  backupPreferences,
  createPreferencesRepository,
  restorePreferencesBackup,
  type PreferencesBackupOptions,
  type PreferencesCodec,
  type PreferencesDocument,
  type PreferencesDocumentSlot,
  type PreferencesRepository,
  type PreferencesRestoreOptions,
} from '..';

interface Value {
  readonly theme: string;
}

const codec: PreferencesCodec<Value> = {
  defaults: { theme: 'system' },
  normalize: (payload) => ({
    theme: typeof payload.theme === 'string' ? payload.theme : 'system',
  }),
  project: (value) => value,
  inspect: () => null,
  merge: (existing, patch) => ({ ...existing, ...patch }),
};

const SLOTS: Readonly<Record<PreferencesDocumentSlot, string>> = {
  primary: 'preferences.json',
  lastGood: 'preferences.last-good.json',
  generation: 'preferences.generation.json',
};

/** The preferences readers over a data root; any write fails the case. */
function readers(at: string): PreferencesRepository<Value> {
  const readOnly = (): Promise<never> =>
    Promise.reject(new Error('The readers must not write.'));
  const document: PreferencesDocument = {
    key: join(at, SLOTS.primary),
    readText: (slot) => readFile(join(at, SLOTS[slot]), 'utf8'),
    exists: (slot) =>
      access(join(at, SLOTS[slot])).then(
        () => true,
        () => false,
      ),
    install: readOnly,
    ensureFolder: readOnly,
    slotPath: (slot) => join(at, SLOTS[slot]),
    backupLocation: (stamp) => join(at, `preferences.backup-${stamp}.json`),
    installBackup: readOnly,
    pruneBackups: readOnly,
  };
  return createPreferencesRepository({
    document: () => document,
    codec,
    log: { error: jest.fn() },
  });
}

async function readBack(at: string): Promise<unknown> {
  const repository = readers(at);
  return {
    stored: await repository.readStoredPayload(),
    authority: await repository.readAuthority({ includeServed: true }),
    files: bytes(at),
  };
}

function bytes(at: string): Record<string, string | null> {
  return Object.fromEntries(
    PREFERENCES_FAMILY_FILES.map((name) => [
      name,
      existsSync(join(at, name)) ? readFileSync(join(at, name), 'utf8') : null,
    ]),
  );
}

const envelope = (version: number, generation: number, theme: string): string =>
  JSON.stringify({ version, generation, preferences: { theme } }, null, 2);

function seed(
  at: string,
  primary = envelope(1, 3, 'dark'),
  lastGood = envelope(1, 3, 'dark'),
): void {
  writeFileSync(join(at, 'preferences.json'), primary);
  writeFileSync(join(at, 'preferences.last-good.json'), lastGood);
  writeFileSync(
    join(at, 'preferences.generation.json'),
    JSON.stringify({ version: 1, generation: 3 }),
  );
  writeFileSync(
    join(at, 'preferences.json.usage-data-denied.json'),
    JSON.stringify({ version: 1, denials: ['2026-11-20T00:00:00.000Z'] }),
  );
}

let roots: string[];
let quiesced: number;

function newRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'preferences-backup-'));
  roots.push(root);
  return root;
}

function options(
  dataRoot: string,
  overrides: Partial<PreferencesBackupOptions & PreferencesRestoreOptions> = {},
): PreferencesBackupOptions & PreferencesRestoreOptions {
  return {
    dataRoot,
    name: 'before-flip',
    isOutsideCheckouts: () => true,
    // Refuses a flush of anything but an existing folder.
    syncDirectory: (path) =>
      Promise.resolve(statSync(path).isDirectory() ? 'flushed' : 'unsupported'),
    flushRequiresWriteHandle: false,
    quiesce: (operation) => {
      quiesced += 1;
      return operation();
    },
    clock: () => Date.parse('2026-11-25T12:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  roots = [];
  quiesced = 0;
});

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('preferences backup and restore (CAN-7924)', () => {
  it('restores into an empty data root equal through the preferences readers', async () => {
    const source = newRoot();
    seed(source);
    const record = await backupPreferences(options(source));
    expect(quiesced).toBe(1);
    expect(record).toMatchObject({
      namespaceId: 'preferences',
      backupPath: `${PREFERENCES_BACKUPS_FOLDER}/before-flip`,
      rollbackMigration: 'restorePreferencesBackup',
    });
    expect(
      validateNamespaceBackupRecord(record, {
        rows: STORAGE_OWNERSHIP,
        isOutsideCheckouts: () => true,
      }).ok,
    ).toBe(true);

    const target = newRoot();
    cpSync(join(source, 'backups'), join(target, 'backups'), {
      recursive: true,
    });
    await expect(
      restorePreferencesBackup(record, options(target)),
    ).resolves.toEqual({ restored: [...PREFERENCES_FAMILY_FILES] });
    expect(await readBack(target)).toEqual(await readBack(source));
    expect(readdirSync(join(target, PREFERENCES_BACKUPS_FOLDER))).toEqual([
      'before-flip',
    ]);
  });

  it('refuses an older backup over newer writes unless a person confirms and logs the loss', async () => {
    const root = newRoot();
    seed(root);
    const backedUp = await readBack(root);
    const record = await backupPreferences(options(root));
    writeFileSync(join(root, 'preferences.json'), envelope(1, 4, 'light'));
    writeFileSync(
      join(root, 'preferences.generation.json'),
      JSON.stringify({ version: 1, generation: 4 }),
    );
    const newer = bytes(root);

    await expect(
      restorePreferencesBackup(record, options(root)),
    ).rejects.toMatchObject({ code: 'NEWER_STATE' });
    expect(bytes(root)).toEqual(newer);

    const log = jest.fn();
    const result = await restorePreferencesBackup(
      record,
      options(root, { acceptNewerLoss: { confirmedBy: 'person', log } }),
    );
    expect(log).toHaveBeenCalledWith({
      backupPath: record.backupPath,
      files: ['preferences.generation.json', 'preferences.json'],
    });
    expect(result.restored).toEqual([
      'preferences.generation.json',
      'preferences.json',
    ]);
    expect(await readBack(root)).toEqual(backedUp);
    // The replaced writes are set aside, never deleted.
    const aside = join(root, result.setAside ?? 'missing');
    expect(bytes(aside)).toEqual({
      ...Object.fromEntries(
        PREFERENCES_FAMILY_FILES.map((name) => [name, null]),
      ),
      'preferences.json': newer['preferences.json'],
      'preferences.generation.json': newer['preferences.generation.json'],
    });
  });

  it('round-trips a version 2 family byte for byte', async () => {
    const source = newRoot();
    const v2 = envelope(2, 3, 'dark');
    seed(source, v2, v2);
    const record = await backupPreferences(options(source));
    const target = newRoot();
    cpSync(join(source, 'backups'), join(target, 'backups'), {
      recursive: true,
    });
    await restorePreferencesBackup(record, options(target));
    // Bytes only: how this build's readers take version 2 is CAN-7925's.
    expect(bytes(target)).toEqual(bytes(source));
    expect(bytes(target)).toMatchObject({
      'preferences.json': v2,
      'preferences.last-good.json': v2,
    });
  });

  it('issues no record while the preferences row is not required_before_flip', async () => {
    const root = newRoot();
    seed(root);
    const ownership = STORAGE_OWNERSHIP.map((row) =>
      row.id === 'preferences'
        ? { ...row, backupPolicy: 'none' as const }
        : row,
    );
    await expect(
      backupPreferences(options(root, { ownership })),
    ).rejects.toMatchObject({ code: 'NOT_REQUIRED_BEFORE_FLIP' });
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });
});
