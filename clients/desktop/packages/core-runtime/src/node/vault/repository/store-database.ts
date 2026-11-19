import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import type { PlatformOperatingSystem } from '../../../platform/platform-services';
import type { VaultIoClass } from '../../../vault/contracts';
import { VAULT_RECORD_FORMAT } from './record-format';
import {
  blob,
  integer,
  text,
  type VaultStoreRow,
  type VaultStoredHeader,
} from './store-records';
import { VAULT_STORE_SCHEMA, VAULT_STORE_SCHEMA_VERSION } from './store-schema';
import { isVaultId } from './vault-keys';

/*
 * Opens the vault store as its single exclusive writer, as the Agent Ledger
 * and W5 commit log do: WAL, `synchronous=FULL`, `locking_mode=EXCLUSIVE` and
 * the write lock taken before returning. macOS adds `fullfsync` (2026-10-29
 * checkpoint; its cost to the daemon thread is unmeasured). `secure_delete`
 * zeroes erased ciphertext in the pages it rewrites; the database file and
 * the WAL keep it until the next checkpoint, which each committed tombstone
 * runs. Windows rests on SQLite's file flushes and the folder flush (CAN-5153):
 * "API-level flush; namespace ordering undocumented; power-loss unverified"
 * (CAN-5151).
 */

export type VaultStoreOpenStep =
  /** The vault folder or database file could not be created or flushed. */
  | 'folder'
  /** `secureFiles.permissions` did not report the folder or a file private. */
  | 'permissions'
  /** SQLite could not open or configure the file. */
  | 'open'
  /** Another connection or process holds the store. */
  | 'writer'
  /** A required journal, sync, lock or erase setting did not take effect. */
  | 'durability'
  /** `quick_check` found damage. */
  | 'integrity'
  /** A newer, unknown or foreign schema. */
  | 'schema'
  /** The header names no valid vault or another record format. */
  | 'header'
  /** The header could not be checkpointed into the database file. */
  | 'checkpoint'
  /**
   * Records without a header, or a journal without its database: never
   * re-created over (plan Q4c item 7).
   */
  | 'init_state';

/** Every failed open; `step` is internal context, never a branch for callers. */
export interface VaultStoreUnavailable {
  readonly kind: 'store_unavailable';
  readonly step: VaultStoreOpenStep;
  /** Set when a filesystem call threw; diagnostic only, never a branch. */
  readonly io?: VaultIoClass;
}

export function vaultStoreUnavailable(
  step: VaultStoreOpenStep,
  io?: VaultIoClass,
): VaultStoreUnavailable {
  return Object.freeze(
    io
      ? { kind: 'store_unavailable', step, io }
      : { kind: 'store_unavailable', step },
  );
}

export interface VaultStoreDatabase {
  readonly db: DatabaseSync;
  readonly header: VaultStoredHeader | null;
}

export interface VaultStoreDurability {
  readonly journalMode: string;
  readonly lockingMode: string;
  /** SQLite's numeric level; 2 is FULL. */
  readonly synchronous: number;
  readonly fullfsync: boolean;
  readonly secureDelete: boolean;
}

function pragma(db: DatabaseSync, statement: string, column: string): unknown {
  const value = db.prepare(`PRAGMA ${statement}`).get()?.[column];
  return typeof value === 'string' ? value.toLowerCase() : value;
}

export function readDurability(db: DatabaseSync): VaultStoreDurability {
  const synchronous = pragma(db, 'synchronous', 'synchronous');
  return {
    journalMode: String(pragma(db, 'journal_mode', 'journal_mode')),
    lockingMode: String(pragma(db, 'locking_mode', 'locking_mode')),
    synchronous: typeof synchronous === 'number' ? synchronous : -1,
    fullfsync: pragma(db, 'fullfsync', 'fullfsync') === 1,
    secureDelete: pragma(db, 'secure_delete', 'secure_delete') === 1,
  };
}

function configureDurability(
  db: DatabaseSync,
  os: PlatformOperatingSystem,
): boolean {
  if (pragma(db, 'locking_mode = EXCLUSIVE', 'locking_mode') !== 'exclusive')
    return false;
  if (pragma(db, 'journal_mode = WAL', 'journal_mode') !== 'wal') return false;
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA secure_delete = ON');
  if (os === 'darwin') db.exec('PRAGMA fullfsync = ON');
  const applied = readDurability(db);
  return (
    applied.synchronous === 2 &&
    applied.secureDelete &&
    applied.fullfsync === (os === 'darwin')
  );
}

/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the database. */
function isLockedError(error: unknown): boolean {
  // Structural: node:sqlite errors can come from another realm.
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'errcode');
  return typeof code === 'number' && [5, 6].includes(code & 0xff);
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get();
  return row ? integer(row, 'n') : 0;
}

function schemaObjects(db: DatabaseSync): string {
  return JSON.stringify(
    db
      .prepare(
        'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
      )
      .all(),
  );
}

let currentSchema: string | undefined;

// Built by SQLite from this build's statements, so stored SQL text compares
// exactly.
function currentSchemaObjects(): string {
  if (currentSchema !== undefined) return currentSchema;
  const reference = new DatabaseSync(':memory:');
  try {
    for (const statement of VAULT_STORE_SCHEMA) reference.exec(statement);
    currentSchema = schemaObjects(reference);
    return currentSchema;
  } finally {
    reference.close();
  }
}

function createSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of VAULT_STORE_SCHEMA) db.exec(statement);
    db.prepare(
      `INSERT INTO vault_meta (key, value) VALUES ('schema_version', ?)`,
    ).run(String(VAULT_STORE_SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// True when the schema is current, after creating it in an empty database.
// Any object, SQLite's own included, makes the file not empty.
function migrate(db: DatabaseSync): boolean {
  if (count(db, 'SELECT count(*) AS n FROM sqlite_master') === 0) {
    createSchema(db);
    return true;
  }
  const meta = count(
    db,
    `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'vault_meta'`,
  );
  if (meta === 0) return false;
  const version = db
    .prepare(`SELECT value FROM vault_meta WHERE key = 'schema_version'`)
    .get()?.value;
  // Every table, column, constraint, index and trigger, by name and SQL: the
  // tombstone rule lives in a trigger.
  return (
    version === String(VAULT_STORE_SCHEMA_VERSION) &&
    schemaObjects(db) === currentSchemaObjects()
  );
}

export function decodeHeader(row: VaultStoreRow): VaultStoredHeader | null {
  const vaultId = text(row, 'vault_id');
  if (
    integer(row, 'format_version') !== VAULT_RECORD_FORMAT.version ||
    !isVaultId(vaultId)
  )
    return null;
  // The box stays untrusted: unwrapping decides `key_missing` (Q4c item 7).
  return {
    vaultId,
    wrappedDataKey: {
      nonce: blob(row, 'wrap_nonce'),
      ciphertext: blob(row, 'wrap_ciphertext'),
      tag: blob(row, 'wrap_tag'),
    },
    createdAt: text(row, 'created_at'),
  };
}

/** Test seam: wraps a WAL checkpoint; throw, or return false for an incomplete one. */
export type VaultCheckpointHook = (checkpoint: () => boolean) => boolean;

function runCheckpoint(db: DatabaseSync): boolean {
  const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  // `log` is -1 when the checkpoint could not run.
  return (
    row?.busy === 0 &&
    typeof row.log === 'number' &&
    row.log >= 0 &&
    row.log === row.checkpointed
  );
}

/**
 * Until a checkpoint, a header lives only in the WAL, and a lost WAL would
 * look like an empty store that init starts over. False or a throw: the
 * header may not be in the database file.
 */
export function checkpointWal(
  db: DatabaseSync,
  hook: VaultCheckpointHook | undefined,
): boolean {
  const checkpoint = (): boolean => runCheckpoint(db);
  return hook ? hook(checkpoint) : checkpoint();
}

export function hasRecords(db: DatabaseSync): boolean {
  // A used intent sequence counts even after retention removed its rows.
  return (
    count(
      db,
      `SELECT (EXISTS (SELECT 1 FROM vault_entries)
        OR EXISTS (SELECT 1 FROM vault_intents)
        OR EXISTS (SELECT 1 FROM vault_tombstones)
        OR EXISTS (SELECT 1 FROM vault_meta WHERE key IN ('copilot_migration_v1', 'copilot_migration_format', 'copilot_authority_v1', 'copilot_authority_format'))
        OR EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'vault_intents')) AS n`,
    ) === 1
  );
}

interface OpenProgress {
  step: VaultStoreOpenStep;
}

interface OpenSettings {
  readonly os: PlatformOperatingSystem;
  readonly openBusyTimeoutMs: number;
  readonly checkpoint?: VaultCheckpointHook;
  /** Fails instead of creating the file: a reopen never starts a store over. */
  readonly existing?: boolean;
}

function existingFile(databasePath: string): URL {
  const url = pathToFileURL(databasePath);
  url.searchParams.set('mode', 'rw');
  return url;
}

function initialize(
  db: DatabaseSync,
  { os, openBusyTimeoutMs, checkpoint }: OpenSettings,
  progress: OpenProgress,
): VaultStoreDatabase | VaultStoreUnavailable {
  db.exec(`PRAGMA busy_timeout = ${String(openBusyTimeoutMs)}`);
  progress.step = 'durability';
  if (!configureDurability(db, os)) return vaultStoreUnavailable('durability');
  // Take the write lock now and keep it: in exclusive mode SQLite never
  // releases it until the connection closes.
  progress.step = 'writer';
  db.exec('BEGIN IMMEDIATE');
  db.exec('COMMIT');
  db.exec('PRAGMA busy_timeout = 0');
  progress.step = 'integrity';
  if (pragma(db, 'quick_check', 'quick_check') !== 'ok')
    return vaultStoreUnavailable('integrity');
  progress.step = 'schema';
  if (!migrate(db)) return vaultStoreUnavailable('schema');
  progress.step = 'header';
  const row = db.prepare('SELECT * FROM vault_header').get();
  const header = row ? decodeHeader(row) : null;
  if (row && !header) return vaultStoreUnavailable('header');
  if (!header && hasRecords(db)) return vaultStoreUnavailable('init_state');
  // Re-checkpoints a header whose init checkpoint failed before any record
  // joins it in the WAL.
  progress.step = 'checkpoint';
  if (header && !checkpointWal(db, checkpoint))
    return vaultStoreUnavailable('checkpoint');
  return { db, header };
}

export function closeVaultStoreDatabase(db: DatabaseSync): void {
  try {
    if (db.isOpen) db.close();
  } catch {
    // The connection is being discarded after a failure.
  }
}

/** Fails closed with nothing written when another connection holds the store. */
export function openVaultStoreDatabase(
  databasePath: string,
  settings: OpenSettings,
): VaultStoreDatabase | VaultStoreUnavailable {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(
      settings.existing ? existingFile(databasePath) : databasePath,
    );
  } catch {
    return vaultStoreUnavailable('open');
  }
  const progress: OpenProgress = { step: 'open' };
  let result: VaultStoreDatabase | VaultStoreUnavailable;
  try {
    result = initialize(db, settings, progress);
  } catch (error) {
    result = vaultStoreUnavailable(
      isLockedError(error) ? 'writer' : progress.step,
    );
  }
  if (!('db' in result)) closeVaultStoreDatabase(db);
  return result;
}
