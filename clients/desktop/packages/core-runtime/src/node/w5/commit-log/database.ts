import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { W5CommitLogError } from './errors';
import { workspaceCreationDiagnosticsSchema } from './reservation-diagnostics';

import { W5_COMMIT_LOG_SCHEMA_VERSION } from './schema-version';
export { W5_COMMIT_LOG_SCHEMA_VERSION } from './schema-version';

const SCHEMA_V2 = [
  `CREATE TABLE w5_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`,
  // One monotonic revision per W5 resource (CAN-3799 D4). An absent row is
  // revision 0.
  `CREATE TABLE w5_revisions (
    resource TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 1)
  ) STRICT`,
  // The commit decision of each change: committed here, applied to the JSON
  // files afterwards. `state` is `committed` until every file is written,
  // then `applied`; `recovery-required` when a file changed out of band.
  `CREATE TABLE w5_commits (
    commit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    outcome_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('committed', 'applied', 'recovery-required')),
    diagnostics_json TEXT,
    committed_at TEXT NOT NULL,
    completed_at TEXT,
    outcome_expired INTEGER NOT NULL DEFAULT 0 CHECK (outcome_expired IN (0, 1))
  ) STRICT`,
  `CREATE INDEX w5_commits_by_state ON w5_commits (state, commit_id)`,
  `CREATE INDEX w5_commits_to_compact ON w5_commits (completed_at, commit_id)
    WHERE state = 'applied' AND outcome_expired = 0`,
  // Both fingerprints survive application. Contents are NULL for a removal
  // or once applied; only committed/recovery-required images are read.
  `CREATE TABLE w5_commit_files (
    commit_id INTEGER NOT NULL REFERENCES w5_commits (commit_id),
    path TEXT NOT NULL,
    previous_fingerprint TEXT,
    new_fingerprint TEXT,
    contents TEXT,
    PRIMARY KEY (commit_id, path)
  ) STRICT`,
  `CREATE INDEX w5_commit_files_by_path ON w5_commit_files (path, commit_id)`,
  // Retry identities survive for the lifetime of W5 state, even once the
  // joined commit's saved outcome expires.
  `CREATE TABLE w5_receipts (
    caller TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    commit_id INTEGER NOT NULL REFERENCES w5_commits (commit_id),
    PRIMARY KEY (caller, operation, idempotency_key)
  ) STRICT`,
  // Pending operations that run uncertain effects (clone, git worktree add)
  // before they commit. Distinct from committed outcomes.
  `CREATE TABLE w5_reservations (
    reservation_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    caller TEXT,
    idempotency_key TEXT,
    fingerprint TEXT,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'recovery-required')),
    diagnostics_json TEXT NOT NULL,
    reserved_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX w5_reservations_by_key
    ON w5_reservations (caller, operation, idempotency_key)
    WHERE idempotency_key IS NOT NULL`,
];

/** Not exactly 64 bytes of lowercase hex: links to nothing, not even itself. */
const malformed = (column: string): string =>
  `(${column} IS NOT NULL AND (length(CAST(${column} AS BLOB)) != 64 OR ltrim(${column}, '0123456789abcdef') != ''))`;

/** A file row's key as SQL expressions, such as `NEW.path`. */
interface FileRowKey {
  path: string;
  commitId: string;
}

/**
 * The nearest row of the same path on one side of `row`, ignoring `skip`.
 * INDEXED BY: the primary key would walk every other path's rows instead.
 */
function neighbour(
  alias: string,
  row: FileRowKey,
  side: 'before' | 'after',
  skip?: FileRowKey,
): string {
  const ignored = skip
    ? ` AND NOT (${alias}.path = ${skip.path} AND ${alias}.commit_id = ${skip.commitId})`
    : '';
  return `FROM w5_commit_files ${alias} INDEXED BY w5_commit_files_by_path
    WHERE ${alias}.path = ${row.path}
    AND ${alias}.commit_id ${side === 'before' ? '<' : '>'} ${row.commitId}${ignored}
    ORDER BY ${alias}.commit_id ${side === 'before' ? 'DESC' : 'ASC'} LIMIT 1`;
}

interface Predecessor {
  exists: string;
  image: string;
}

function predecessorOf(row: FileRowKey, skip?: FileRowKey): Predecessor {
  const from = neighbour('p', row, 'before', skip);
  return {
    exists: `EXISTS (SELECT 1 ${from})`,
    image: `(SELECT p.new_fingerprint ${from})`,
  };
}

/** 1 when a row breaks the chain from `predecessor`, exactly as schema 2's window query counted it. */
function chainBreak(
  row: { previous: string; image: string },
  predecessor: Predecessor,
): string {
  return `(CASE WHEN ${malformed(row.previous)} OR ${malformed(row.image)} THEN 1
    WHEN NOT ${predecessor.exists} THEN 0
    ELSE ${row.previous} IS NOT ${predecessor.image} END)`;
}

const SUCCESSOR = {
  previous: 's.previous_fingerprint',
  image: 's.new_fingerprint',
};

/** `expression` over the row after `row` (alias `s`), or 0 without one. */
function successor(
  expression: string,
  row: FileRowKey,
  skip?: FileRowKey,
): string {
  return `COALESCE((SELECT ${expression} ${neighbour('s', row, 'after', skip)}), 0)`;
}

const NEW_ROW = { path: 'NEW.path', commitId: 'NEW.commit_id' };
const OLD_ROW = { path: 'OLD.path', commitId: 'OLD.commit_id' };

/** Account for NEW, already in the table, between its neighbours. */
function chainInsert(): string {
  const before = predecessorOf(NEW_ROW);
  const row = {
    previous: 'NEW.previous_fingerprint',
    image: 'NEW.new_fingerprint',
  };
  const relinked = `${chainBreak(SUCCESSOR, { exists: '1', image: row.image })} - ${chainBreak(SUCCESSOR, before)}`;
  const change = `${chainBreak(row, before)} + ${successor(relinked, NEW_ROW)}`;
  // Not an upsert: SQLite checks the CHECK constraints of its VALUES row
  // even when it updates instead, and `change` may be negative.
  return `UPDATE w5_file_chains SET decisions = decisions + 1,
      starts_absent = CASE WHEN ${before.exists} THEN starts_absent ELSE ${row.previous} IS NULL END,
      discontinuities = discontinuities + ${change}
    WHERE path = NEW.path;
    INSERT INTO w5_file_chains (path, decisions, starts_absent, discontinuities)
      SELECT NEW.path, 1, ${row.previous} IS NULL, ${change}
      WHERE NOT EXISTS (SELECT 1 FROM w5_file_chains WHERE path = NEW.path);`;
}

/** Account for OLD, no longer in the table (nor `skip`, its replacement). */
function chainDelete(skip?: FileRowKey): string {
  const before = predecessorOf(OLD_ROW, skip);
  const row = {
    previous: 'OLD.previous_fingerprint',
    image: 'OLD.new_fingerprint',
  };
  const relinked = `${chainBreak(SUCCESSOR, before)} - ${chainBreak(SUCCESSOR, { exists: '1', image: row.image })}`;
  return `DELETE FROM w5_file_chains WHERE path = OLD.path AND decisions = 1;
    UPDATE w5_file_chains SET decisions = decisions - 1,
      starts_absent = CASE WHEN ${before.exists} THEN starts_absent
        ELSE ${successor('s.previous_fingerprint IS NULL', OLD_ROW, skip)} END,
      discontinuities = discontinuities - ${chainBreak(row, before)} + ${successor(relinked, OLD_ROW, skip)}
    WHERE path = OLD.path;`;
}

/**
 * Schema 3 (CAN-5563): capture reads a per-path chain summary and a
 * retained-commit count instead of scanning history. Triggers keep both in
 * the transaction of every write to the rows they summarize, in O(log n).
 */
const SCHEMA_V3_TABLES = [
  `CREATE TABLE w5_file_chains (
    path TEXT PRIMARY KEY,
    decisions INTEGER NOT NULL CHECK (decisions > 0),
    starts_absent INTEGER NOT NULL CHECK (starts_absent IN (0, 1)),
    discontinuities INTEGER NOT NULL CHECK (discontinuities BETWEEN 0 AND decisions)
  ) STRICT`,
  `CREATE TABLE w5_commit_totals (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    retained INTEGER NOT NULL CHECK (retained >= 0)
  ) STRICT`,
];

const SCHEMA_V3_BACKFILL = [
  `INSERT INTO w5_file_chains (path, decisions, starts_absent, discontinuities)
    SELECT path, COUNT(*), MAX(position = 1 AND previous IS NULL), SUM(CASE
      WHEN ${malformed('previous')} OR ${malformed('image')} THEN 1
      WHEN position = 1 THEN 0
      ELSE previous IS NOT before END)
    FROM (SELECT path, previous_fingerprint AS previous, new_fingerprint AS image,
      LAG(new_fingerprint) OVER chain AS before,
      ROW_NUMBER() OVER chain AS position
      FROM w5_commit_files WINDOW chain AS (PARTITION BY path ORDER BY commit_id))
    GROUP BY path`,
  `INSERT INTO w5_commit_totals (singleton, retained)
    SELECT 1, COUNT(*) FROM w5_commits`,
];

const SCHEMA_V3_TRIGGERS = [
  `CREATE TRIGGER w5_file_chains_insert AFTER INSERT ON w5_commit_files
    BEGIN ${chainInsert()} END`,
  `CREATE TRIGGER w5_file_chains_delete AFTER DELETE ON w5_commit_files
    BEGIN ${chainDelete()} END`,
  // Only tests rewrite these columns; a rewrite is a delete and an insert.
  `CREATE TRIGGER w5_file_chains_update
    AFTER UPDATE OF commit_id, path, previous_fingerprint, new_fingerprint ON w5_commit_files
    BEGIN ${chainDelete(NEW_ROW)} ${chainInsert()} END`,
  `CREATE TRIGGER w5_commit_totals_insert AFTER INSERT ON w5_commits
    BEGIN UPDATE w5_commit_totals SET retained = retained + 1; END`,
  `CREATE TRIGGER w5_commit_totals_delete AFTER DELETE ON w5_commits
    BEGIN UPDATE w5_commit_totals SET retained = retained - 1; END`,
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

function readSchemaVersion(db: DatabaseSync): number | null {
  const table = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'w5_meta'`,
    )
    .get();
  if (!table) return null;
  const value = db
    .prepare(`SELECT value FROM w5_meta WHERE key = 'schema_version'`)
    .get()?.value;
  return typeof value === 'string' ? Number(value) : null;
}

function migrateV1(db: DatabaseSync, migratedAt: string): void {
  db.exec('ALTER TABLE w5_commits ADD COLUMN completed_at TEXT');
  db.exec(`ALTER TABLE w5_commits ADD COLUMN outcome_expired INTEGER
    NOT NULL DEFAULT 0 CHECK (outcome_expired IN (0, 1))`);
  db.exec('ALTER TABLE w5_commit_files ADD COLUMN new_fingerprint TEXT');
  // v1 did not record completion time. Give its applied receipts a full
  // window from migration rather than guess when they finished applying.
  db.prepare(
    `UPDATE w5_commits SET completed_at = ? WHERE state = 'applied'`,
  ).run(migratedAt);
  const update = db.prepare(`UPDATE w5_commit_files SET new_fingerprint = ?,
    contents = CASE WHEN ? = 'applied' THEN NULL ELSE contents END
    WHERE commit_id = ? AND path = ?`);
  const rows = db
    .prepare(
      `SELECT f.commit_id, f.path, f.contents, c.state
    FROM w5_commit_files f JOIN w5_commits c USING (commit_id)`,
    )
    .iterate();
  for (let next = rows.next(); !next.done; next = rows.next()) {
    const row = next.value;
    const fingerprint =
      typeof row.contents === 'string'
        ? createHash('sha256').update(row.contents, 'utf8').digest('hex')
        : null;
    update.run(fingerprint, row.state, row.commit_id, row.path);
  }
  db.exec(`CREATE INDEX w5_commits_to_compact ON w5_commits (completed_at, commit_id)
    WHERE state = 'applied' AND outcome_expired = 0`);
}

/** Summarize existing history once with schema 2's own window query. */
function migrateV2(db: DatabaseSync): void {
  for (const statement of [
    ...SCHEMA_V3_TABLES,
    ...SCHEMA_V3_BACKFILL,
    ...SCHEMA_V3_TRIGGERS,
  ])
    db.exec(statement);
}

function migrate(db: DatabaseSync, migratedAt: string): void {
  const version = readSchemaVersion(db);
  if (version === W5_COMMIT_LOG_SCHEMA_VERSION) return;
  if (version !== null && version !== 1 && version !== 2 && version !== 3) {
    throw new W5CommitLogError(
      'UNSUPPORTED_SCHEMA',
      `The W5 commit log has schema ${String(version)}; this build reads ${String(W5_COMMIT_LOG_SCHEMA_VERSION)}.`,
    );
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version === 1) migrateV1(db, migratedAt);
    else if (version === null)
      for (const statement of SCHEMA_V2) db.exec(statement);
    if (version !== 3) migrateV2(db);
    db.exec('ALTER TABLE w5_reservations ADD COLUMN workspace_identity TEXT');
    db.exec(
      'CREATE UNIQUE INDEX w5_workspace_identity ON w5_reservations(lower(workspace_identity)) WHERE workspace_identity IS NOT NULL',
    );
    // Legacy duplicates/unknown claims must stay recoverable, not prevent opening the log.
    db.exec(`CREATE TABLE w5_legacy_workspace_claims (
      reservation_id TEXT PRIMARY KEY REFERENCES w5_reservations(reservation_id) ON DELETE CASCADE,
      workspace_identity TEXT
    ) STRICT`);
    const legacy = db.prepare(`INSERT INTO w5_legacy_workspace_claims
      (reservation_id, workspace_identity) VALUES (?, ?)`);
    for (const row of db
      .prepare(
        `SELECT reservation_id, operation, diagnostics_json
      FROM w5_reservations`,
      )
      .all()) {
      // Historical schema 1–3 creators, not the mutable live operation registry.
      // Other operations cannot leave an unknown workspace creation claim.
      if (
        ![
          'core.workspace.create',
          'core.workspace.import',
          'core.workspace.composition.combine',
          'core.workspace.composition.promote',
          'core.workspace.composition.split',
          'core.sharedContainer.fork',
        ].includes(String(row.operation))
      )
        continue;
      let diagnostics: unknown;
      try {
        diagnostics =
          typeof row.diagnostics_json === 'string'
            ? JSON.parse(row.diagnostics_json)
            : null;
      } catch {
        diagnostics = null;
      }
      const parsed = workspaceCreationDiagnosticsSchema.safeParse(diagnostics);
      legacy.run(
        row.reservation_id,
        parsed.success ? parsed.data.workspaceId : null,
      );
    }
    db.prepare(
      `INSERT INTO w5_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(String(W5_COMMIT_LOG_SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Opens the W5 commit log as its single exclusive writer: WAL,
 * `synchronous=FULL`, `locking_mode=EXCLUSIVE` and the write lock taken
 * before returning, as the Agent Ledger store does. Another connection or
 * process makes the open fail with `WRITER_UNAVAILABLE` after
 * `openBusyTimeoutMs`, having written nothing.
 */
export function openW5CommitLogDatabase(
  databasePath: string,
  openBusyTimeoutMs = 2_000,
  migratedAt = new Date().toISOString(),
): DatabaseSync {
  let db: DatabaseSync;
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  } catch (error) {
    throw new W5CommitLogError(
      'STORAGE_UNAVAILABLE',
      'Could not open the W5 commit log.',
      error,
    );
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${String(openBusyTimeoutMs)}`);
    if (
      pragmaText(db, 'locking_mode = EXCLUSIVE', 'locking_mode') !== 'exclusive'
    ) {
      throw new W5CommitLogError(
        'STORAGE_UNAVAILABLE',
        'Exclusive locking is unavailable.',
      );
    }
    if (pragmaText(db, 'journal_mode = WAL', 'journal_mode') !== 'wal') {
      throw new W5CommitLogError(
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
    migrate(db, migratedAt);
    return db;
  } catch (error) {
    closeQuietly(db);
    if (error instanceof W5CommitLogError) throw error;
    if (isLockedError(error)) {
      throw new W5CommitLogError(
        'WRITER_UNAVAILABLE',
        'Another writer holds the W5 commit log.',
        error,
      );
    }
    throw new W5CommitLogError(
      'STORAGE_UNAVAILABLE',
      'Could not open the W5 commit log.',
      error,
    );
  }
}
