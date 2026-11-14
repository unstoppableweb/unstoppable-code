import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isErrnoException, isRecord } from '../lib/type-guards';

/**
 * Cap on a source database the importer will copy. The copy lands in the temp
 * directory, so an unbounded store would trade a slow read for a full disk.
 */
export const MAX_STORE_DB_BYTES = 512 * 1024 * 1024;

export class StoreMissingError extends Error {
  constructor(dbPath: string) {
    super(`Store database not found: ${dbPath}`);
    this.name = 'StoreMissingError';
  }
}

export class StoreTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super(`Store database is too large to import (${sizeBytes} bytes).`);
    this.name = 'StoreTooLargeError';
  }
}

/** Raised by readers when the store lacks a table or column they need. */
export class StoreSchemaError extends Error {
  constructor(readonly missing: string) {
    super(`Store schema is missing ${missing}.`);
    this.name = 'StoreSchemaError';
  }
}

export interface SqliteSnapshotOptions {
  maxBytes: number;
  /** Where the temporary copy lives; defaults to the OS temp directory. */
  tmpRoot?: string;
  /**
   * A failed first attempt that took longer than this is not retried, so a
   * slow failure returns its error before the caller's own deadline. Omit
   * to always retry.
   */
  retryWithinMs?: number;
}

async function sizeIfPresent(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function copyIfPresent(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
}

/** Failures a second copy cannot change. */
function isFinalSnapshotError(error: unknown): boolean {
  return (
    error instanceof StoreMissingError ||
    error instanceof StoreTooLargeError ||
    error instanceof StoreSchemaError
  );
}

/**
 * Runs `fn` against a read-only copy of a database another app holds open.
 * Opening the live file, even read-only, can checkpoint its WAL or contend with
 * the writer; the copy (the database and its `-wal`) leaves the source
 * untouched. The `-shm` index is not copied: it is only meaningful to the
 * processes sharing the live file, and SQLite rebuilds it from the copied WAL
 * beside the copy.
 *
 * The snapshot is best-effort and read-only. The database and its WAL are
 * copied one after the other while the owner may be writing or checkpointing,
 * so the pair can be torn: a torn copy surfaces as a read error (a malformed
 * image, a missing row the WAL referenced), and such a read is retried once on
 * a fresh copy, unless the first attempt took longer than `retryWithinMs`.
 * The size cap is checked on the source before
 * copying and again on the copies, since the files can grow in between; copies
 * over `maxBytes` fail as {@link StoreTooLargeError}. The temporary directory
 * is removed whether `fn` succeeds or not.
 */
export async function withSqliteSnapshot<T>(
  dbPath: string,
  options: SqliteSnapshotOptions,
  fn: (db: DatabaseSync) => T,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await readSnapshotOnce(dbPath, options, fn);
  } catch (error) {
    if (isFinalSnapshotError(error)) throw error;
    const { retryWithinMs } = options;
    if (
      retryWithinMs !== undefined &&
      performance.now() - startedAt > retryWithinMs
    )
      throw error;
    return readSnapshotOnce(dbPath, options, fn);
  }
}

async function readSnapshotOnce<T>(
  dbPath: string,
  options: SqliteSnapshotOptions,
  fn: (db: DatabaseSync) => T,
): Promise<T> {
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(dbPath)).size;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT')
      throw new StoreMissingError(dbPath);
    throw error;
  }
  sizeBytes += await sizeIfPresent(`${dbPath}-wal`);
  if (sizeBytes > options.maxBytes) throw new StoreTooLargeError(sizeBytes);
  const directory = await mkdtemp(
    join(options.tmpRoot ?? tmpdir(), 'canopy-store-'),
  );
  try {
    const copy = join(directory, 'store.db');
    await copyFile(dbPath, copy);
    await copyIfPresent(`${dbPath}-wal`, `${copy}-wal`);
    // The source can grow between the check above and the copies.
    const copiedBytes =
      (await stat(copy)).size + (await sizeIfPresent(`${copy}-wal`));
    if (copiedBytes > options.maxBytes)
      throw new StoreTooLargeError(copiedBytes);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Checks a store's schema against the columns a reader selects, so a store
 * from an incompatible app version fails with a named column instead of a
 * mid-read SQL error. Returns `"<table>.<column>"` of the first miss, or null.
 */
export function requireTables(
  db: DatabaseSync,
  required: Record<string, string[]>,
): string | null {
  for (const [table, columns] of Object.entries(required)) {
    const present = new Set<string>();
    // Table names come from reader constants, never from store content.
    for (const row of db.prepare(`pragma table_info("${table}")`).all()) {
      if (isRecord(row) && typeof row.name === 'string') present.add(row.name);
    }
    for (const column of columns) {
      if (!present.has(column)) return `${table}.${column}`;
    }
  }
  return null;
}
