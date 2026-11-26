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
import { dirname, join, posix, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createNamespaceBackupRecord,
  namespaceBackupPathError,
  type NamespaceBackupRecord,
} from '../../../storage/backup-record';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import {
  OPERATION_LEDGER_SCHEMA_VERSION,
  openOperationLedgerDatabase,
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
    rmSync(staging, { force: true });
  }
}
