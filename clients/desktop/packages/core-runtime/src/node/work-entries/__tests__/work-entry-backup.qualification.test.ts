import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { validateNamespaceBackupRecord } from '../../../storage/backup-record';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import {
  WORK_ENTRIES_BACKUPS_FOLDER,
  backupWorkEntryRegistries,
  createWorkEntryRepository,
  restoreWorkEntryRegistriesBackup,
  type WorkEntryBackupOptions,
  type WorkEntryRegistryFile,
  type WorkEntryRepository,
  type WorkEntryRestoreOptions,
} from '..';

interface Row {
  id: string;
  createdAt: string;
  title?: string;
}

const FILE = 'work-entries.json';
const COWORK = 'workspaces/cowork-1/work-entries.json';
const ADVISOR = 'app-workspaces/app-advisor/work-entries.json';
const BOT = 'app-workspaces/bot--helper/work-entries.json';
const STALE_ADVISOR = 'workspaces/app-advisor/work-entries.json';

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && 'id' in value;

function parse(text: string): WorkEntryRegistryFile<Row> {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('entries' in parsed) ||
    !Array.isArray(parsed.entries)
  )
    throw new Error('Invalid work-entry registry');
  return { version: 1, entries: parsed.entries.filter(isRow) };
}

const registry = (title: string): string =>
  JSON.stringify(
    {
      version: 1,
      entries: [{ id: 'e1', createdAt: '2026-11-20T10:00:00.000Z', title }],
    },
    null,
    2,
  );

const registryPathOf = (workspaceId: string): string =>
  workspaceId === 'app-advisor' || workspaceId.startsWith('bot--')
    ? `app-workspaces/${workspaceId}/${FILE}`
    : `workspaces/${workspaceId}/${FILE}`;

/** The rows with work_entries required_before_flip, as an owner flip would set it. */
const REQUIRED = STORAGE_OWNERSHIP.map((row) =>
  row.id === 'work_entries'
    ? {
        ...row,
        backupPolicy: 'required_before_flip' as const,
        backupShape: 'namespace_backup' as const,
      }
    : row,
);

let roots: string[];
let writerChecks: number;
let failRename: ((target: string) => boolean) | undefined;

function newRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'work-entry-backup-'));
  roots.push(root);
  return root;
}

/** The engine over real files, as the desktop composition binds it. */
function repositoryAt(root: string): WorkEntryRepository<Row> {
  return createWorkEntryRepository<Row>({
    registryPath: (workspaceId) => join(root, registryPathOf(workspaceId)),
    io: {
      readText: (path) => readFile(path, 'utf8').catch(() => null),
      exists: (path) => Promise.resolve(existsSync(path)),
      async mkdirParent(path) {
        await mkdir(dirname(path), { recursive: true });
      },
      tempPath: (path) =>
        join(dirname(path), `.work-entries-${randomUUID()}.tmp`),
      writeFile: (path, data) => writeFile(path, data),
      async rename(source, target) {
        if (failRename?.(target)) throw new Error('Simulated crash');
        await rename(source, target);
      },
      unlink: (path) => unlink(path),
    },
    codec: { parse, serialize: (file) => JSON.stringify(file, null, 2) },
    assertWriter: () => {
      writerChecks += 1;
    },
  });
}

function seed(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const read = (root: string, path: string): string | null =>
  existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;

function options(
  dataRoot: string,
  overrides: Partial<
    WorkEntryBackupOptions<Row> & WorkEntryRestoreOptions<Row>
  > = {},
): WorkEntryBackupOptions<Row> & WorkEntryRestoreOptions<Row> {
  return {
    dataRoot,
    name: 'before-flip',
    fileName: FILE,
    repository: repositoryAt(dataRoot),
    registryPathOf,
    parse,
    isOutsideCheckouts: () => true,
    // Refuses a flush of anything but an existing folder.
    syncDirectory: (path) =>
      Promise.resolve(statSync(path).isDirectory() ? 'flushed' : 'unsupported'),
    flushRequiresWriteHandle: false,
    ownership: REQUIRED,
    clock: () => Date.parse('2026-11-26T12:00:00.000Z'),
    ...overrides,
  };
}

async function copyBackups(source: string, target: string): Promise<void> {
  await cp(join(source, 'backups'), join(target, 'backups'), {
    recursive: true,
  });
}

beforeEach(() => {
  roots = [];
  writerChecks = 0;
  failRename = undefined;
});

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('Work Entry registry backup and restore (CAN-4476)', () => {
  it('backs up both containers and restores through the repository, equal byte for byte and through parse', async () => {
    const source = newRoot();
    seed(source, COWORK, registry('cowork'));
    seed(source, ADVISOR, registry('advisor'));
    seed(source, BOT, registry('bot'));
    seed(source, STALE_ADVISOR, registry('stale advisor'));
    // Neither matches the row's patterns.
    seed(source, 'workspaces/index.json', '{}');
    seed(source, 'workspaces/cowork-1/.work-entries-x.tmp', 'partial');

    const record = await backupWorkEntryRegistries(options(source));
    expect(record).toMatchObject({
      namespaceId: 'work_entries',
      backupPath: `${WORK_ENTRIES_BACKUPS_FOLDER}/before-flip`,
      schemaVersion: 1,
      rollbackMigration: 'restoreWorkEntryRegistriesBackup',
    });
    expect(
      validateNamespaceBackupRecord(record, {
        rows: REQUIRED,
        isOutsideCheckouts: () => true,
      }).ok,
    ).toBe(true);
    const backup = join(source, record.backupPath);
    for (const path of [ADVISOR, BOT, COWORK, STALE_ADVISOR])
      expect(read(backup, path)).toBe(read(source, path));
    expect(existsSync(join(backup, 'workspaces/index.json'))).toBe(false);
    expect(
      existsSync(join(backup, 'workspaces/cowork-1/.work-entries-x.tmp')),
    ).toBe(false);

    // The bot workspace was deleted since; its folder is not recreated.
    const target = newRoot();
    await copyBackups(source, target);
    mkdirSync(join(target, 'workspaces/cowork-1'), { recursive: true });
    mkdirSync(join(target, 'app-workspaces/app-advisor'), { recursive: true });
    writerChecks = 0;
    await expect(
      restoreWorkEntryRegistriesBackup(record, options(target)),
    ).resolves.toEqual({
      restored: [ADVISOR, COWORK],
      notInstalled: [BOT, STALE_ADVISOR],
    });
    expect(writerChecks).toBe(2);
    for (const path of [ADVISOR, COWORK]) {
      expect(read(target, path)).toBe(read(source, path));
      expect(parse(read(target, path) ?? '')).toEqual(
        parse(read(source, path) ?? ''),
      );
    }
    expect(existsSync(join(target, 'app-workspaces/bot--helper'))).toBe(false);
    expect(existsSync(join(target, STALE_ADVISOR))).toBe(false);
    expect(readdirSync(join(target, WORK_ENTRIES_BACKUPS_FOLDER))).toEqual([
      'before-flip',
    ]);

    writeFileSync(join(target, record.backupPath, COWORK), registry('edited'));
    await expect(
      restoreWorkEntryRegistriesBackup(record, options(target)),
    ).rejects.toThrow('The backup does not match its record.');
  });

  it('copies each served registry in its workspace queue', async () => {
    const root = newRoot();
    seed(root, COWORK, registry('before'));
    seed(root, STALE_ADVISOR, registry('stale'));
    const repository = repositoryAt(root);
    const queued: string[] = [];
    let reached: () => void = () => undefined;
    const backupQueued = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // Holds the cowork queue until the backup waits behind it, then writes
    // late enough that a copy outside the queue would read the old bytes.
    const held = repository.transact('cowork-1', async () => {
      await backupQueued;
      await new Promise((resolve) => setTimeout(resolve, 50));
      seed(root, COWORK, registry('after'));
    });
    const record = await backupWorkEntryRegistries(
      options(root, {
        repository: {
          ...repository,
          transact: (workspaceId, fn) => {
            queued.push(workspaceId);
            reached();
            return repository.transact(workspaceId, fn);
          },
        },
      }),
    );
    await held;
    expect(queued).toEqual(['cowork-1']);
    expect(read(join(root, record.backupPath), COWORK)).toBe(registry('after'));
  });

  it('refuses an older backup over newer registries unless a person confirms and logs the loss', async () => {
    const root = newRoot();
    seed(root, COWORK, registry('backed up'));
    seed(root, ADVISOR, registry('advisor'));
    const record = await backupWorkEntryRegistries(options(root));
    seed(root, COWORK, registry('newer'));
    // A workspace created since the backup keeps its registry.
    seed(root, 'workspaces/cowork-2/work-entries.json', registry('created'));

    await expect(
      restoreWorkEntryRegistriesBackup(record, options(root)),
    ).rejects.toMatchObject({ code: 'NEWER_STATE' });
    expect(read(root, COWORK)).toBe(registry('newer'));

    const log = jest.fn();
    const result = await restoreWorkEntryRegistriesBackup(
      record,
      options(root, { acceptNewerLoss: { confirmedBy: 'person', log } }),
    );
    expect(log).toHaveBeenCalledWith({
      backupPath: record.backupPath,
      files: [COWORK],
    });
    expect(result.restored).toEqual([COWORK]);
    expect(read(root, COWORK)).toBe(registry('backed up'));
    expect(read(root, 'workspaces/cowork-2/work-entries.json')).toBe(
      registry('created'),
    );
    // The replaced registry is set aside, never deleted.
    const aside = join(root, result.setAside ?? 'missing');
    expect(read(aside, COWORK)).toBe(registry('newer'));
    expect(read(aside, ADVISOR)).toBeNull();
  });

  it('resumes an interrupted restore from its journal', async () => {
    const root = newRoot();
    seed(root, COWORK, registry('backed up cowork'));
    seed(root, ADVISOR, registry('backed up advisor'));
    const record = await backupWorkEntryRegistries(options(root));
    seed(root, COWORK, registry('newer cowork'));
    seed(root, ADVISOR, registry('newer advisor'));
    const confirm = {
      acceptNewerLoss: { confirmedBy: 'person' as const, log: jest.fn() },
    };

    failRename = (target): boolean => target.endsWith(COWORK);
    await expect(
      restoreWorkEntryRegistriesBackup(record, options(root, confirm)),
    ).rejects.toThrow('Simulated crash');
    expect(read(root, ADVISOR)).toBe(registry('backed up advisor'));
    expect(read(root, COWORK)).toBe(registry('newer cowork'));
    const journal = join(root, record.backupPath, 'restore-journal.json');
    expect(existsSync(journal)).toBe(true);

    failRename = undefined;
    // Progress, not new writes: no confirmation needed to finish.
    const result = await restoreWorkEntryRegistriesBackup(
      record,
      options(root),
    );
    expect(result.restored).toEqual([COWORK]);
    expect(read(root, COWORK)).toBe(registry('backed up cowork'));
    expect(existsSync(journal)).toBe(false);
    const aside = join(root, result.setAside ?? 'missing');
    expect(read(aside, ADVISOR)).toBe(registry('newer advisor'));
    expect(read(aside, COWORK)).toBe(registry('newer cowork'));
  });

  it('refuses to install over a write that lands after the restore began', async () => {
    const root = newRoot();
    seed(root, COWORK, registry('backed up'));
    const record = await backupWorkEntryRegistries(options(root));
    seed(root, COWORK, registry('newer'));
    const repository = repositoryAt(root);
    const restore = restoreWorkEntryRegistriesBackup(
      record,
      options(root, {
        acceptNewerLoss: { confirmedBy: 'person', log: jest.fn() },
        repository: {
          ...repository,
          installRaw: async (workspaceId, bytes, installOptions) => {
            seed(root, COWORK, registry('concurrent'));
            await repository.installRaw(workspaceId, bytes, installOptions);
          },
        },
      }),
    );
    await expect(restore).rejects.toThrow(
      'changed while it was being restored',
    );
    expect(read(root, COWORK)).toBe(registry('concurrent'));
  });

  it('refuses a symbolic link or a registry its restore could not install, and removes what it wrote', async () => {
    const root = newRoot();
    seed(root, COWORK, registry('cowork'));
    seed(root, ADVISOR, '{"version": 1, "entries": [');
    await expect(backupWorkEntryRegistries(options(root))).rejects.toThrow(
      `The restore test of ${ADVISOR} does not parse equal.`,
    );
    const outside = newRoot();
    seed(outside, FILE, registry('outside'));
    rmSync(join(root, ADVISOR));
    symlinkSync(outside, join(root, 'workspaces/elsewhere'));
    await expect(backupWorkEntryRegistries(options(root))).rejects.toThrow(
      'workspaces/elsewhere is a symbolic link.',
    );
    expect(readdirSync(join(root, WORK_ENTRIES_BACKUPS_FOLDER))).toEqual([]);
  });

  it('stays dormant: the real work_entries row issues no record and refuses a restore', async () => {
    const row = STORAGE_OWNERSHIP.find(({ id }) => id === 'work_entries');
    expect(row?.backupPolicy).toBe('none');
    const root = newRoot();
    seed(root, COWORK, registry('cowork'));
    await expect(
      backupWorkEntryRegistries(
        options(root, { ownership: STORAGE_OWNERSHIP }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_REQUIRED_BEFORE_FLIP' });
    expect(existsSync(join(root, 'backups'))).toBe(false);

    const record = await backupWorkEntryRegistries(options(root));
    await expect(
      restoreWorkEntryRegistriesBackup(
        record,
        options(root, { ownership: STORAGE_OWNERSHIP }),
      ),
    ).rejects.toThrow('not a required_before_flip namespace_backup row');
  });
});
