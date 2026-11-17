import { existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { CODE_GRAPH_SCHEMA_VERSION } from '../types/code-graph';
import {
  CODE_GRAPH_BUSY_TIMEOUT_MS,
  isSqliteBusy,
  openCodeGraphDatabase,
} from './database';
import {
  CodeGraphSchemaNewerError,
  runCodeGraphMigrations,
} from './migrations';

/**
 * The cross-process writer lease for one worktree graph database. Every
 * process that writes a worktree `graph.db` (the build host for builds, seeds,
 * summary repairs, derived analysis and the end-of-build fingerprint; the CLI
 * for builds, snapshot imports and schema migrations) holds this lease for the
 * whole write, so one writer owns the database at a time.
 *
 * The lease is a reserved lock on a sidecar SQLite file beside the graph. The
 * operating system drops the lock when its process exits, so a crashed holder
 * never leaves a stale lease behind. The sidecar is never written or deleted:
 * replacing it while it is held would let a second process lock the new file.
 * Immutable published base generations and private staging databases have a
 * single writer by construction and take no lease.
 */
export interface CodeGraphWriterLease {
  readonly dbPath: string;
  /** Ends the lease. Safe to call more than once. */
  release(): void;
}

export class CodeGraphWriterLeaseBusyError extends Error {
  readonly dbPath: string;

  constructor(dbPath: string) {
    super('Another process is writing this code graph. Try again shortly.');
    this.name = 'CodeGraphWriterLeaseBusyError';
    this.dbPath = dbPath;
  }
}

export interface AcquireCodeGraphWriterLeaseOptions {
  /** How long to wait for another holder; unbounded when omitted. */
  waitMs?: number;
  signal?: AbortSignal;
  /** Called once, when the lease is not immediately available. */
  onWait?: () => void;
  /**
   * Called before the lease is acquired, so before anything is written; a
   * throw refuses the write. A host passes its storage ownership admission
   * here (CAN-6985); graph hosts that own the store pass none.
   */
  admit?: () => void;
}

const LEASE_POLL_MIN_MS = 25;
const LEASE_POLL_MAX_MS = 500;

export function codeGraphWriterLeasePath(dbPath: string): string {
  return `${dbPath}.writer-lease`;
}

function lockOrNull(connection: DatabaseSync): boolean {
  try {
    connection.exec('BEGIN IMMEDIATE');
    return true;
  } catch (error) {
    if (isSqliteBusy(error)) return false;
    throw error;
  }
}

function openLeaseConnection(dbPath: string): DatabaseSync {
  const leasePath = codeGraphWriterLeasePath(dbPath);
  mkdirSync(path.dirname(leasePath), { recursive: true });
  return new DatabaseSync(leasePath, { timeout: 0 });
}

function leaseFor(
  dbPath: string,
  connection: DatabaseSync,
): CodeGraphWriterLease {
  let released = false;
  return {
    dbPath,
    release(): void {
      if (released) return;
      released = true;
      try {
        connection.exec('ROLLBACK');
      } finally {
        connection.close();
      }
    },
  };
}

/** Takes the lease if no other connection holds it; null when one does. */
export function tryAcquireCodeGraphWriterLease(
  dbPath: string,
): CodeGraphWriterLease | null {
  const connection = openLeaseConnection(dbPath);
  try {
    if (lockOrNull(connection)) return leaseFor(dbPath, connection);
  } catch (error) {
    connection.close();
    throw error;
  }
  connection.close();
  return null;
}

/**
 * Waits for the lease, polling with backoff. Rejects with
 * {@link CodeGraphWriterLeaseBusyError} when `waitMs` runs out, or with the
 * signal's reason when it aborts.
 */
export async function acquireCodeGraphWriterLease(
  dbPath: string,
  options: AcquireCodeGraphWriterLeaseOptions = {},
): Promise<CodeGraphWriterLease> {
  options.admit?.();
  const deadline =
    options.waitMs === undefined ? Infinity : Date.now() + options.waitMs;
  const connection = openLeaseConnection(dbPath);
  let delayMs = LEASE_POLL_MIN_MS;
  let waiting = false;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      if (lockOrNull(connection)) return leaseFor(dbPath, connection);
      if (Date.now() >= deadline)
        throw new CodeGraphWriterLeaseBusyError(dbPath);
      if (!waiting) {
        waiting = true;
        options.onWait?.();
      }
      await delay(
        Math.min(delayMs, Math.max(0, deadline - Date.now())),
        undefined,
        { signal: options.signal },
      ).catch(() => undefined);
      delayMs = Math.min(delayMs * 2, LEASE_POLL_MAX_MS);
    }
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Runs `fn` while holding the lease, releasing it however `fn` settles. */
export async function withCodeGraphWriterLease<T>(
  dbPath: string,
  fn: () => Promise<T> | T,
  options?: AcquireCodeGraphWriterLeaseOptions,
): Promise<T> {
  const lease = await acquireCodeGraphWriterLease(dbPath, options);
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

/**
 * Whether opening the graph for reads would write it: it is missing, not yet
 * in WAL mode, or behind the current schema. A newer schema is refused here,
 * as the migrations would refuse it, because a reader may open the graph
 * without running them.
 */
function openingWouldWrite(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true;
  const db = new DatabaseSync(dbPath, {
    readOnly: true,
    timeout: CODE_GRAPH_BUSY_TIMEOUT_MS,
  });
  try {
    const mode: unknown = db.prepare('PRAGMA journal_mode').get();
    if (
      mode === null ||
      typeof mode !== 'object' ||
      Reflect.get(mode, 'journal_mode') !== 'wal'
    )
      return true;
    const table = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'graph_metadata'",
      )
      .get();
    if (table === undefined) return true;
    const row: unknown = db
      .prepare("SELECT value FROM graph_metadata WHERE key = 'schema_version'")
      .get();
    const version =
      row !== null && typeof row === 'object'
        ? Number(Reflect.get(row, 'value'))
        : 0;
    if (version > CODE_GRAPH_SCHEMA_VERSION)
      throw new CodeGraphSchemaNewerError(version);
    return version !== CODE_GRAPH_SCHEMA_VERSION;
  } finally {
    db.close();
  }
}

/**
 * Prepares a worktree graph for a reader that opens it with the engine or a
 * plain connection: when opening would create, convert or migrate it, that
 * write runs here under the writer lease. A current graph is left alone, so
 * readers never wait for a build that holds the lease.
 */
export async function ensureCodeGraphDatabaseCurrent(
  dbPath: string,
  options?: AcquireCodeGraphWriterLeaseOptions,
): Promise<void> {
  if (!openingWouldWrite(dbPath)) return;
  await withCodeGraphWriterLease(
    dbPath,
    () => {
      const db = openCodeGraphDatabase(dbPath);
      try {
        runCodeGraphMigrations(db);
      } finally {
        db.close();
      }
    },
    options,
  );
}
