import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { OperationLedgerError } from './errors';

/** The schema this build writes; a newer database is never opened. */
export const OPERATION_LEDGER_SCHEMA_VERSION = 3;

const SCHEMA = [
  `CREATE TABLE operation_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`,
  // One row per accepted operation. The receipt columns (caller, kind,
  // idempotency_key, fingerprint) survive the saved outcome, so a retry
  // after the retention window still never reruns the work.
  `CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN
      ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    parent_operation_id TEXT REFERENCES operations (operation_id),
    root_operation_id TEXT NOT NULL,
    authority_id TEXT,
    execution_target_id TEXT,
    runtime_delegation_id TEXT,
    scope_json TEXT NOT NULL,
    organization_id TEXT,
    workspace_id TEXT,
    worktree_id TEXT,
    chat_id TEXT,
    execution_id TEXT,
    repo_id TEXT,
    origin_json TEXT NOT NULL,
    owner_json TEXT NOT NULL,
    caller TEXT,
    idempotency_key TEXT,
    fingerprint TEXT,
    run_epoch TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    progress REAL,
    outcome_json TEXT,
    outcome_expired INTEGER NOT NULL DEFAULT 0 CHECK (outcome_expired IN (0, 1)),
    error_json TEXT,
    cancellation_json TEXT,
    restart_json TEXT,
    CHECK ((caller IS NULL) = (idempotency_key IS NULL)),
    CHECK ((idempotency_key IS NULL) = (fingerprint IS NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX operations_by_receipt
    ON operations (caller, kind, idempotency_key)
    WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX operations_active ON operations (status)
    WHERE status IN ('queued', 'running', 'paused')`,
  `CREATE INDEX operations_by_parent ON operations (parent_operation_id)
    WHERE parent_operation_id IS NOT NULL`,
  `CREATE INDEX operations_by_created ON operations (created_at, operation_id)`,
  `CREATE INDEX operations_to_compact ON operations (completed_at, operation_id)
    WHERE completed_at IS NOT NULL AND outcome_expired = 0`,
  // Durable lifecycle changes, each with the record as it left it. The
  // sequence is the stream cursor; AUTOINCREMENT never reuses one.
  `CREATE TABLE operation_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL REFERENCES operations (operation_id),
    event TEXT NOT NULL,
    previous_status TEXT,
    occurred_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX operation_events_by_operation
    ON operation_events (operation_id, sequence)`,
];

/**
 * Version 2 (CAN-4132): the execution-target registry, delegation leases and
 * one dispatch record per delegated child operation. The builtin
 * `in_process_worker` target is always registered.
 */
const SCHEMA_V2 = [
  `CREATE TABLE execution_targets (
    target_id TEXT PRIMARY KEY,
    record_json TEXT NOT NULL,
    registered_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE delegation_leases (
    lease_id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL REFERENCES execution_targets (target_id),
    run_epoch TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    released_at TEXT,
    record_json TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX delegation_leases_held
    ON delegation_leases (target_id, run_epoch)`,
  `CREATE TABLE delegations (
    delegation_id TEXT PRIMARY KEY,
    parent_operation_id TEXT NOT NULL REFERENCES operations (operation_id),
    child_operation_id TEXT NOT NULL UNIQUE REFERENCES operations (operation_id),
    target_id TEXT NOT NULL REFERENCES execution_targets (target_id),
    lease_id TEXT NOT NULL REFERENCES delegation_leases (lease_id),
    state TEXT NOT NULL,
    record_json TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX delegations_by_parent ON delegations (parent_operation_id)`,
  `CREATE INDEX delegations_unsettled ON delegations (lease_id)
    WHERE state IN ('prepared', 'dispatched', 'reconciling', 'unreachable')`,
];

/**
 * Version 3 (CAN-4145): the last state each initiated-work source has seen
 * per subject, such as a pull request's tracked snapshot. A source records
 * it in the same transaction as the runs that state fired, so seeing an
 * event and accepting its work commit together.
 */
const SCHEMA_V3 = [
  `CREATE TABLE initiated_work_heads (
    source TEXT NOT NULL,
    subject TEXT NOT NULL,
    head TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (source, subject)
  ) STRICT`,
];

/**
 * Identity retention's lookups (CAN-5721): candidate roots by kind and finish
 * time, then each tree by its root. New ledgers create them with their
 * schema; an older schema-3 ledger gets them from its first retention batch,
 * never at open, since building them over a large ledger takes a while. An
 * index is not a format change, so older schema-3 builds still open the file.
 */
export const OPERATION_LEDGER_RETENTION_INDEXES: readonly {
  name: string;
  create: string;
}[] = [
  {
    name: 'operations_by_root',
    create: `CREATE INDEX IF NOT EXISTS operations_by_root
      ON operations (root_operation_id)`,
  },
  {
    name: 'operations_roots_by_kind',
    create: `CREATE INDEX IF NOT EXISTS operations_roots_by_kind
      ON operations (kind, completed_at, operation_id)
      WHERE parent_operation_id IS NULL`,
  },
];

function closeQuietly(db: DatabaseSync): void {
  try {
    if (db.isOpen) db.close();
  } catch {
    // The connection is being discarded after a failure.
  }
}

/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the database. */
function isLockedError(error: unknown): boolean {
  // Checked structurally: node:sqlite raises its errors from another realm
  // under some hosts, so `instanceof Error` cannot be relied on.
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'errcode');
  return typeof code === 'number' && (code & 0xff) >= 5 && (code & 0xff) <= 6;
}

function pragmaText(db: DatabaseSync, pragma: string, column: string): string {
  const value = db.prepare(`PRAGMA ${pragma}`).get()?.[column];
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function readMeta(db: DatabaseSync, key: string): string | null {
  const table = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operation_meta'`,
    )
    .get();
  if (!table) return null;
  const value = db
    .prepare('SELECT value FROM operation_meta WHERE key = ?')
    .get(key)?.value;
  return typeof value === 'string' ? value : null;
}

function migrate(db: DatabaseSync): void {
  const stored = readMeta(db, 'schema_version');
  if (stored !== null) {
    if (Number(stored) === OPERATION_LEDGER_SCHEMA_VERSION) return;
    if (Number(stored) === 1 || Number(stored) === 2) {
      upgrade(db, () => {
        const statements =
          Number(stored) === 1 ? [...SCHEMA_V2, ...SCHEMA_V3] : SCHEMA_V3;
        for (const statement of statements) db.exec(statement);
        db.prepare(
          `UPDATE operation_meta SET value = ? WHERE key = 'schema_version'`,
        ).run(String(OPERATION_LEDGER_SCHEMA_VERSION));
      });
      return;
    }
    throw new OperationLedgerError(
      'UNSUPPORTED_SCHEMA',
      `The operation ledger has schema ${stored}; this build reads ${String(OPERATION_LEDGER_SCHEMA_VERSION)}.`,
    );
  }
  upgrade(db, () => {
    for (const statement of [
      ...SCHEMA,
      ...SCHEMA_V2,
      ...SCHEMA_V3,
      ...OPERATION_LEDGER_RETENTION_INDEXES.map((index) => index.create),
    ])
      db.exec(statement);
    const insert = db.prepare(
      'INSERT INTO operation_meta (key, value) VALUES (?, ?)',
    );
    insert.run('schema_version', String(OPERATION_LEDGER_SCHEMA_VERSION));
    // The ledger's stable identity: the epoch of its event cursors, so a
    // cursor stays valid across restarts and fails against another ledger.
    insert.run('ledger_id', randomUUID());
    insert.run('events_pruned_through', '0');
  });
}

function upgrade(db: DatabaseSync, run: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    run();
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Opens the operation ledger as its single exclusive writer: WAL,
 * `synchronous=FULL`, `locking_mode=EXCLUSIVE` and the write lock taken
 * before returning, as the W5 commit log does. Another connection or process
 * makes the open fail with `WRITER_UNAVAILABLE` after `openBusyTimeoutMs`,
 * having written nothing.
 */
export function openOperationLedgerDatabase(
  databasePath: string,
  openBusyTimeoutMs = 2_000,
  options: { readonly keepSchema?: boolean } = {},
): DatabaseSync {
  let db: DatabaseSync;
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  } catch (error) {
    throw new OperationLedgerError(
      'STORAGE_UNAVAILABLE',
      'Could not open the operation ledger.',
      error,
    );
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${String(openBusyTimeoutMs)}`);
    if (
      pragmaText(db, 'locking_mode = EXCLUSIVE', 'locking_mode') !== 'exclusive'
    ) {
      throw new OperationLedgerError(
        'STORAGE_UNAVAILABLE',
        'Exclusive locking is unavailable.',
      );
    }
    if (pragmaText(db, 'journal_mode = WAL', 'journal_mode') !== 'wal') {
      throw new OperationLedgerError(
        'STORAGE_UNAVAILABLE',
        'WAL journaling is unavailable.',
      );
    }
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    // Take the write lock now and keep it: in exclusive mode SQLite never
    // releases it until the connection closes.
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
    db.exec('PRAGMA busy_timeout = 0');
    if (options.keepSchema !== true || readMeta(db, 'schema_version') === null)
      migrate(db);
    return db;
  } catch (error) {
    closeQuietly(db);
    if (error instanceof OperationLedgerError) throw error;
    if (isLockedError(error)) {
      throw new OperationLedgerError(
        'WRITER_UNAVAILABLE',
        'Another writer holds the operation ledger.',
        error,
      );
    }
    throw new OperationLedgerError(
      'STORAGE_UNAVAILABLE',
      'Could not open the operation ledger.',
      error,
    );
  }
}

export function migrateOperationLedgerDatabase(db: DatabaseSync): void {
  try {
    migrate(db);
  } catch (error) {
    if (error instanceof OperationLedgerError) throw error;
    throw new OperationLedgerError(
      'STORAGE_UNAVAILABLE',
      'Could not upgrade the operation ledger.',
      error,
    );
  }
}

export function openOperationLedgerDatabaseReadOnly(
  databasePath: string,
): DatabaseSync {
  try {
    return new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    throw new OperationLedgerError(
      'STORAGE_UNAVAILABLE',
      'Could not open the operation ledger.',
      error,
    );
  }
}
