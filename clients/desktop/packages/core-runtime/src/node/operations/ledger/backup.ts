import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { access, copyFile, rm } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import {
  createNamespaceBackupRecord,
  namespaceBackupPathError,
  type NamespaceBackupRecord,
} from '../../../storage/backup-record';
import { storageRecordsFolder } from '../../../storage/owner-records';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import type {
  StorageOwnershipRow,
  StorageTransitionOwner,
} from '../../../storage/writer-authority';
import {
  persistNamespaceBackupRecord,
  readOwnerFlipRecord,
  writeOwnerFlipRecord,
} from '../../storage-records';
import {
  OPERATION_LEDGER_SCHEMA_VERSION,
  openOperationLedgerDatabase,
  openOperationLedgerDatabaseReadOnly,
} from './database';
import { OperationLedgerError } from './errors';
import type { OperationLedger } from './ledger';

/** The ledger's row in `storage-ownership.yaml`. */
export const OPERATION_LEDGER_NAMESPACE = 'operation_ledger';
/** The rollback migration a backup record names: {@link restoreOperationLedgerBackup}. */
export const OPERATION_LEDGER_ROLLBACK_MIGRATION =
  'restoreOperationLedgerBackup';

export interface OperationLedgerBackupOptions {
  /** The data root that `backupPath` is relative to. */
  dataRoot: string;
  /** Data-root-relative, slash-separated path of the copy to create. */
  backupPath: string;
  /** Trusted host proof that the path is outside every checkout. */
  isOutsideCheckouts: (dataRootRelativePath: string) => boolean;
  /** The host's folder flush: its secure-files port's `syncDirectory`. */
  syncDirectory: (path: string) => Promise<'flushed' | 'unsupported'>;
  clock?: () => number;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * The host path of a data-root-relative backup path. Its nearest existing
 * ancestor must resolve inside the data root, so a symlinked directory
 * cannot carry the copy elsewhere.
 */
function resolveInside(dataRoot: string, relative: string): string {
  const leaves = (): OperationLedgerError =>
    new OperationLedgerError(
      'BACKUP_UNVERIFIED',
      'The backup path leaves the data root.',
    );
  const root = realpathSync(dataRoot);
  const target = resolve(root, ...relative.split(posix.sep));
  if (!target.startsWith(`${root}${sep}`)) throw leaves();
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!isInside(root, realpathSync(ancestor))) throw leaves();
  return target;
}

/** Whether anything, a dangling symlink included, occupies the path. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The facts a copy must hold to stand in for its source. */
interface LedgerFacts {
  ledgerId: string;
  schemaVersion: number;
  eventsHead: number;
  operations: number;
}

function readFacts(db: DatabaseSync): LedgerFacts {
  const meta = (key: string): string => {
    const value = db
      .prepare('SELECT value FROM operation_meta WHERE key = ?')
      .get(key)?.value;
    if (typeof value !== 'string')
      throw new OperationLedgerError(
        'BACKUP_UNVERIFIED',
        `The ledger has no ${key}.`,
      );
    return value;
  };
  const head = db
    .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'operation_events'`)
    .get()?.seq;
  const operations = db
    .prepare('SELECT COUNT(*) AS count FROM operations')
    .get()?.count;
  return {
    ledgerId: meta('ledger_id'),
    schemaVersion: Number(meta('schema_version')),
    eventsHead: head === undefined || head === null ? 0 : Number(head),
    operations: Number(operations),
  };
}

function verifyCopy(path: string, expected: LedgerFacts): void {
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = copy.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok')
      throw new OperationLedgerError(
        'BACKUP_UNVERIFIED',
        'The backup copy failed its integrity check.',
      );
    const facts = readFacts(copy);
    if (
      facts.ledgerId !== expected.ledgerId ||
      facts.schemaVersion !== expected.schemaVersion ||
      facts.eventsHead !== expected.eventsHead ||
      facts.operations !== expected.operations
    )
      throw new OperationLedgerError(
        'BACKUP_UNVERIFIED',
        'The backup copy does not match the ledger it was taken from.',
      );
  } finally {
    copy.close();
  }
}

/**
 * Restore-test a copy without touching it: copy it aside, open the copy as
 * the ledger's writer would, and compare it with the source facts.
 */
function restoreTest(path: string, expected: LedgerFacts): void {
  const scratch = `${path}.restore-test-${randomUUID()}`;
  try {
    copyFileSync(path, scratch);
    const db = openOperationLedgerDatabase(scratch, 0);
    try {
      const facts = readFacts(db);
      if (
        facts.ledgerId !== expected.ledgerId ||
        facts.eventsHead !== expected.eventsHead
      )
        throw new OperationLedgerError(
          'BACKUP_UNVERIFIED',
          'The restored copy does not match the ledger it was taken from.',
        );
    } finally {
      db.close();
    }
  } finally {
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(`${scratch}${suffix}`, { force: true });
  }
}

/**
 * Take a verified online backup of the open ledger and return its
 * `namespace_backup` record (`storage-backup-restore.schema.yaml`). The copy
 * is written by the ledger's own connection (`VACUUM INTO`), checked for
 * integrity and against the source, digested, and restore-tested before the
 * record is issued. Runs on the writer's connection, so no write interleaves.
 */
export async function backupOperationLedger(
  ledger: OperationLedger,
  options: OperationLedgerBackupOptions,
): Promise<NamespaceBackupRecord> {
  const clock = options.clock ?? Date.now;
  const pathError = namespaceBackupPathError(
    options.backupPath,
    options.isOutsideCheckouts,
  );
  if (pathError !== undefined)
    throw new OperationLedgerError('BACKUP_UNVERIFIED', pathError);
  const target = resolveInside(options.dataRoot, options.backupPath);
  // A backup never replaces a file: not an earlier copy, and never the live
  // ledger or its write-ahead log.
  if (occupied(target))
    throw new OperationLedgerError(
      'BACKUP_UNVERIFIED',
      'The backup path already exists.',
    );
  mkdirSync(dirname(target), { recursive: true });
  const createdAt = new Date(clock()).toISOString();
  const source = readFacts(ledger.connection);
  ledger.connection.prepare('VACUUM INTO ?').run(target);
  syncFile(target);
  if ((await options.syncDirectory(dirname(target))) !== 'flushed')
    throw new OperationLedgerError('BACKUP_UNVERIFIED', 'Backup not flushed.');
  verifyCopy(target, source);
  const digest = sha256(target);
  restoreTest(target, source);
  return createNamespaceBackupRecord(
    {
      namespaceId: OPERATION_LEDGER_NAMESPACE,
      backupPath: options.backupPath,
      sourceRevision: `${source.ledgerId}:${String(source.eventsHead)}`,
      schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
      createdAt,
      verifiedBy: { algorithm: 'sha256', digest },
      rollbackMigration: OPERATION_LEDGER_ROLLBACK_MIGRATION,
      restoreTestedAt: new Date(
        Math.max(clock(), Date.parse(createdAt)),
      ).toISOString(),
    },
    { rows: STORAGE_OWNERSHIP, isOutsideCheckouts: options.isOutsideCheckouts },
  );
}

/** Tables a restore replaces, children before the rows they reference. */
/** Every ledger table, so a restore rewinds all of them. */
export const RESTORED_TABLES = [
  'initiated_work_heads',
  'delegations',
  'delegation_leases',
  'execution_targets',
  'operation_events',
  'operations',
  'operation_meta',
  'sqlite_sequence',
] as const;

function migrateStagedCopy(db: DatabaseSync, staging: string): void {
  db.prepare('ATTACH DATABASE ? AS staged').run(staging);
  let version: unknown;
  try {
    version = db
      .prepare(
        `SELECT value FROM staged.operation_meta WHERE key = 'schema_version'`,
      )
      .get()?.value;
  } catch {
    version = undefined;
  } finally {
    db.exec('DETACH DATABASE staged');
  }
  if (version === '1' || version === '2')
    openOperationLedgerDatabase(staging, 0).close();
}

/**
 * The rollback migration a backup record names. Verifies a private staged
 * copy against the record, then replaces the ledger's contents with it in
 * one transaction on the ledger's own exclusive connection, so no other
 * writer can open the ledger at any point of the restore. The database file
 * itself is never replaced, so its write-ahead log stays consistent.
 */
export function restoreOperationLedgerBackup(
  record: NamespaceBackupRecord,
  options: {
    dataRoot: string;
    databasePath: string;
    isOutsideCheckouts: (dataRootRelativePath: string) => boolean;
  },
): void {
  const verified = createNamespaceBackupRecord(record, {
    rows: STORAGE_OWNERSHIP,
    isOutsideCheckouts: options.isOutsideCheckouts,
  });
  if (
    verified.namespaceId !== OPERATION_LEDGER_NAMESPACE ||
    verified.verifiedBy.algorithm !== 'sha256' ||
    verified.schemaVersion !== OPERATION_LEDGER_SCHEMA_VERSION
  )
    throw new OperationLedgerError(
      'BACKUP_UNVERIFIED',
      'This record is not an operation ledger backup this build reads.',
    );
  const copy = resolveInside(options.dataRoot, verified.backupPath);
  if (!isInside(realpathSync(options.dataRoot), realpathSync(copy)))
    throw new OperationLedgerError(
      'BACKUP_UNVERIFIED',
      'The backup path leaves the data root.',
    );
  // Refuses while another writer holds the live ledger, and holds the lock
  // from here until the restore commits.
  const db = openOperationLedgerDatabase(options.databasePath, 0);
  const staging = join(
    dirname(options.databasePath),
    `.restore-${randomUUID()}.sqlite`,
  );
  try {
    copyFileSync(copy, staging);
    if (sha256(staging) !== verified.verifiedBy.digest)
      throw new OperationLedgerError(
        'BACKUP_UNVERIFIED',
        'The backup copy does not match its record.',
      );
    migrateStagedCopy(db, staging);
    db.prepare('ATTACH DATABASE ? AS backup').run(staging);
    try {
      const integrity = db.prepare('PRAGMA backup.integrity_check').get();
      const schema = db
        .prepare(
          `SELECT value FROM backup.operation_meta WHERE key = 'schema_version'`,
        )
        .get()?.value;
      if (
        integrity?.integrity_check !== 'ok' ||
        schema !== String(OPERATION_LEDGER_SCHEMA_VERSION)
      )
        throw new OperationLedgerError(
          'BACKUP_UNVERIFIED',
          'The backup copy is not a readable operation ledger.',
        );
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('PRAGMA defer_foreign_keys = ON');
        for (const table of RESTORED_TABLES)
          db.exec(`DELETE FROM main.${table}`);
        for (const table of [...RESTORED_TABLES].reverse())
          db.exec(
            `INSERT INTO main.${table} SELECT * FROM backup.${table} ORDER BY rowid`,
          );
        // The restored event log rewinds, so the ledger takes a new cursor
        // identity: every cursor issued before the restore needs a snapshot.
        db.prepare(
          `UPDATE main.operation_meta SET value = ? WHERE key = 'ledger_id'`,
        ).run(randomUUID());
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      db.exec('DETACH DATABASE backup');
    }
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(`${staging}${suffix}`, { force: true });
  }
}

export interface OperationLedgerReturnOptions {
  readonly owner?: StorageTransitionOwner;
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly isOutsideCheckouts: (dataRootRelativePath: string) => boolean;
  readonly syncDirectory: (path: string) => Promise<'flushed' | 'unsupported'>;
  readonly acceptNewerLoss?: 'person-confirmed';
  readonly ownership?: readonly StorageOwnershipRow[];
  readonly clock?: () => number;
}

const RETURNABLE: readonly StorageTransitionOwner[] = ['legacy', 'daemon'];

async function flushOwnerRecords(
  options: OperationLedgerReturnOptions,
): Promise<void> {
  const folder = join(
    options.dataRoot,
    ...storageRecordsFolder(OPERATION_LEDGER_NAMESPACE).split('/'),
  );
  for (const path of [folder, dirname(folder), options.dataRoot])
    if ((await options.syncDirectory(path)) !== 'flushed')
      throw new OperationLedgerError(
        'STORAGE_UNAVAILABLE',
        "The operation ledger's owner record could not be confirmed flushed.",
      );
}

async function ledgerExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return false;
    throw error;
  }
}

function tagged(value: SQLOutputValue): unknown {
  if (value === null) return ['null'];
  if (typeof value === 'bigint') return ['integer', value.toString()];
  if (typeof value === 'number')
    return [Number.isInteger(value) ? 'integer' : 'real', value];
  if (ArrayBuffer.isView(value))
    return [
      'blob',
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
        'hex',
      ),
    ];
  return ['text', value];
}

function tableDigest(db: DatabaseSync): string {
  const hash = createHash('sha256');
  for (const table of RESTORED_TABLES) {
    hash.update(`${table}\n`);
    const order = table === 'sqlite_sequence' ? 'name' : 'rowid';
    const where = table === 'operation_meta' ? ` WHERE key <> 'ledger_id'` : '';
    for (const row of db
      .prepare(`SELECT * FROM ${table}${where} ORDER BY ${order}`)
      .all())
      hash.update(`${JSON.stringify(Object.values(row).map(tagged))}\n`);
  }
  return hash.digest('hex');
}

function isEmptyLedger(db: DatabaseSync): boolean {
  return RESTORED_TABLES.filter(
    (table) => table !== 'operation_meta' && table !== 'sqlite_sequence',
  ).every(
    (table) =>
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count === 0,
  );
}

async function sameContents(
  record: NamespaceBackupRecord,
  options: { readonly dataRoot: string; readonly databasePath: string },
): Promise<boolean> {
  const folder = dirname(options.databasePath);
  const staged = join(folder, `.return-live-${randomUUID()}.sqlite`);
  const scratch = join(folder, `.return-check-${randomUUID()}.sqlite`);
  try {
    let live = openOperationLedgerDatabaseReadOnly(options.databasePath);
    let liveDigest: string;
    try {
      const version = live
        .prepare(
          `SELECT value FROM operation_meta WHERE key = 'schema_version'`,
        )
        .get()?.value;
      if (version === '1' || version === '2') {
        live.prepare('VACUUM INTO ?').run(staged);
        live.close();
        live = openOperationLedgerDatabase(staged, 0);
      } else if (version !== String(OPERATION_LEDGER_SCHEMA_VERSION))
        return false;
      if (isEmptyLedger(live)) return true;
      liveDigest = tableDigest(live);
    } finally {
      if (live.isOpen) live.close();
    }
    await copyFile(resolveInside(options.dataRoot, record.backupPath), scratch);
    const copy = openOperationLedgerDatabase(scratch, 0);
    try {
      return tableDigest(copy) === liveDigest;
    } finally {
      copy.close();
    }
  } finally {
    for (const path of [staged, scratch])
      for (const suffix of ['', '-wal', '-shm'])
        await rm(`${path}${suffix}`, { force: true });
  }
}

const DAEMON_COPY =
  /^backups\/operation-ledger\/\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}\.sqlite$/;

export async function discardUncitedOperationLedgerCopy(
  dataRoot: string,
  backupPath: string,
): Promise<void> {
  if (!DAEMON_COPY.test(backupPath))
    throw new OperationLedgerError(
      'BACKUP_UNVERIFIED',
      'Only a copy the background service named can be discarded.',
    );
  const target = resolveInside(dataRoot, backupPath);
  for (const suffix of ['', '-wal', '-shm'])
    await rm(`${target}${suffix}`, { force: true });
}

export async function returnOperationLedger(
  record: NamespaceBackupRecord,
  options: OperationLedgerReturnOptions,
): Promise<void> {
  const { owner } = options;
  if (owner === undefined || !RETURNABLE.includes(owner))
    throw new OperationLedgerError(
      'STORAGE_UNAVAILABLE',
      'Name the owner to return the operation ledger to: the app or the background service.',
    );
  const read = await readOwnerFlipRecord(
    options.dataRoot,
    OPERATION_LEDGER_NAMESPACE,
  );
  if (read.kind === 'unreadable')
    throw new OperationLedgerError(
      'STORAGE_UNAVAILABLE',
      "The operation ledger's owner record can't be read, so nothing was restored.",
    );
  if (read.kind === 'record' && !RETURNABLE.includes(read.record.toOwner))
    throw new OperationLedgerError(
      'STORAGE_UNAVAILABLE',
      `The operation ledger's owner record names ${read.record.toOwner}, so nothing was restored.`,
    );
  if (
    options.acceptNewerLoss !== 'person-confirmed' &&
    (await ledgerExists(options.databasePath)) &&
    !(await sameContents(record, options))
  )
    throw new OperationLedgerError(
      'NEWER_STATE',
      'The operation ledger changed since this backup. Nothing was restored.',
    );
  restoreOperationLedgerBackup(record, options);
  if (read.kind === 'record' && read.record.toOwner === owner) {
    await flushOwnerRecords(options);
    return;
  }
  const writes = {
    syncDirectory: options.syncDirectory,
    isOutsideCheckouts: options.isOutsideCheckouts,
    ownership: options.ownership,
  };
  await persistNamespaceBackupRecord(options.dataRoot, record, writes);
  await writeOwnerFlipRecord(
    options.dataRoot,
    {
      namespaceId: OPERATION_LEDGER_NAMESPACE,
      fromOwner:
        read.kind === 'record'
          ? read.record.toOwner
          : owner === 'legacy'
            ? 'daemon'
            : 'legacy',
      toOwner: owner,
      workPackage: read.kind === 'record' ? read.record.workPackage : 'W6',
      backupDigest: record.verifiedBy.digest,
      flippedAt: new Date((options.clock ?? Date.now)()).toISOString(),
    },
    writes,
  );
}
