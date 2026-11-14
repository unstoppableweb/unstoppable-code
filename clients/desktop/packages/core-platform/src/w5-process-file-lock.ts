import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { observeStoragePathSync } from './storage-path-observation';
import { hostOperatingSystem } from './host-platform';
import { flushDirectory } from './directory-flush';
import type { W5ProcessFileLock } from '@canopy/core-runtime/node/w5/commit-log/apply';
/** Shared with legacy cohort admission; no brand, app or host-registration imports. */
export async function ensureW5PrivateRuntimeDirectory(
  path: string,
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(path);
    const os = hostOperatingSystem();
    const canonicalPath = await realpath(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      identity(canonicalPath) !== identity(path) ||
      (os !== 'win32' && stat.uid !== process.getuid?.())
    ) {
      const error = new Error('The runtime folder is not private.');
      Object.assign(error, { reason: 'runtime-unavailable' });
      throw error;
    }
    // Windows inherits the canonical data root's user ACL. Reparse directory
    // aliases refuse above; POSIX additionally enforces owner and mode.
    if (os !== 'win32' && (stat.mode & 0o077) !== 0) await chmod(path, 0o700);
  } catch (underlying) {
    const error = new Error(
      'The runtime folder cannot be verified as private.',
    );
    Object.assign(error, { reason: 'runtime-unavailable', underlying });
    throw error;
  }
}

import { W5ProcessFileLockTimeoutError } from '@canopy/core-runtime/node/w5/commit-log/errors';
export { W5ProcessFileLockTimeoutError };

function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

function sqliteBusy(error: unknown): boolean {
  const errcode: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'errcode')
      : undefined;
  return errcode === 5 || errcode === 6;
}

function identity(path: string): string {
  const os = hostOperatingSystem();
  // Conservative on case-sensitive macOS volumes: extra exclusion is safe.
  return os === 'win32' || os === 'darwin' ? path.toLowerCase() : path;
}

/**
 * Local filesystems with SQLite byte-range locking only (POSIX and Windows).
 * The permanent database inode is NEVER renamed or removed. BEGIN EXCLUSIVE
 * belongs to this connection; close/crash releases it through the OS. No PID,
 * age, heartbeat or stale-owner inference, and no inherited async reentrancy.
 * Callers must not recursively acquire these locks or delete runtime/locks
 * while a participating host lives. Other users cannot replace private files.
 */
export async function withW5ProcessFileLocks<T>(
  paths: readonly string[],
  options: { dataRoot: string; timeoutMs?: number },
  work: () => Promise<T>,
): Promise<T> {
  if (!paths.length) return work();
  const timeout = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeout) || timeout < 0)
    throw new Error('Invalid W5 lock timeout');
  const root = observeStoragePathSync(resolve(options.dataRoot)).canonicalPath;
  const resources = new Map<string, string>();
  for (const path of paths)
    resources.set(
      identity(observeStoragePathSync(resolve(path)).canonicalPath),
      path,
    );
  const runtime = join(root, 'runtime');
  await ensureW5PrivateRuntimeDirectory(runtime);
  const directory = join(runtime, 'locks');
  await ensureW5PrivateRuntimeDirectory(directory);
  const held: DatabaseSync[] = [];
  const deadline = performance.now() + timeout;
  try {
    for (const [key, path] of [...resources].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const lockPath = join(
        directory,
        `${createHash('sha256').update(key).digest('hex')}.sqlite`,
      );
      // Private parents prevent replacement by other users. Validate existing
      // files without opening a raw descriptor: closing one would release any
      // active POSIX SQLite locks held by this process, including other threads.
      const stat = await lstat(lockPath).catch((error: unknown) => {
        if (code(error) !== 'ENOENT') throw error;
        return undefined;
      });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
        throw new Error('Unsafe W5 process lock file');
      const db = new DatabaseSync(lockPath);
      held.push(db);
      if (hostOperatingSystem() !== 'win32') await chmod(lockPath, 0o600);
      db.exec('PRAGMA busy_timeout = 0');
      for (;;) {
        try {
          db.exec('BEGIN EXCLUSIVE');
          break;
        } catch (error) {
          if (!sqliteBusy(error)) throw error;
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new W5ProcessFileLockTimeoutError(path);
          await delay(Math.min(25, remaining));
        }
      }
    }
    return await work();
  } finally {
    // A connection that failed acquisition is also closed. Never unlink files.
    for (const db of held.reverse()) db.close();
  }
}

/** One acquisition layer at the worker that actually decides and applies. */
export function worktreeListProcessLock(dataRoot: string): W5ProcessFileLock {
  return async (paths, work) => {
    const root = observeStoragePathSync(resolve(dataRoot)).canonicalPath;
    const applicable: string[] = [];
    for (const path of paths) {
      const parts = relative(
        root,
        observeStoragePathSync(resolve(path)).canonicalPath,
      ).split(sep);
      if (
        parts.length === 3 &&
        identity(parts[0] ?? '') === 'workspaces' &&
        identity(parts[2] ?? '') === 'worktrees.json'
      )
        applicable.push(path);
    }
    return withW5ProcessFileLocks(applicable, { dataRoot: root }, work);
  };
}

export class W5DesktopDeleteAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'W5DesktopDeleteAdmissionError';
  }
}

/**
 * W6h3's chosen admission mechanism, not an A20 policy approval. Rollback
 * journal SHARED readers are desktop presence; EXCLUSIVE is one whole delete.
 * Never use WAL, rename this inode, or infer safety from a released lock:
 * the commit log's durable reservation bridges process death and live children.
 */
export interface W5DesktopDeleteGate {
  close(): void;
  protectReservation(id: string): void;
  completeReservation(id: string): void;
}

async function initializeDesktopDeleteGate(
  db: DatabaseSync,
  kind: 'desktop' | 'delete',
): Promise<boolean> {
  const deadline = performance.now() + 5_000;
  let initialized = false;
  for (;;) {
    try {
      const mode = db.prepare('PRAGMA journal_mode').get();
      if (mode?.journal_mode !== 'delete')
        throw new Error('Unsafe admission journal mode');
      db.exec('PRAGMA synchronous = FULL');
      if (db.prepare('PRAGMA user_version').get()?.user_version === 0) {
        // Only initialize virgin evidence, rechecked under first-opener exclusion.
        db.exec('BEGIN EXCLUSIVE');
        if (
          db.prepare('PRAGMA user_version').get()?.user_version === 0 &&
          !db.prepare('SELECT name FROM sqlite_master LIMIT 1').get()
        ) {
          db.exec(
            'CREATE TABLE deletion_hold (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), reservation_id TEXT NOT NULL) STRICT; PRAGMA user_version = 1; COMMIT',
          );
          initialized = true;
        } else db.exec('ROLLBACK');
      }
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 1)
        throw new W5DesktopDeleteAdmissionError(
          'Desktop admission evidence is incomplete or from another version. Keep the data folder unchanged for manual recovery.',
        );
      return initialized;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      const remaining = deadline - performance.now();
      if (kind !== 'desktop' || !sqliteBusy(error) || remaining <= 0)
        throw error;
      // A rival initializer can block even PRAGMA reads, then hold lifetime SHARED.
      await delay(Math.min(25, remaining));
    }
  }
}

export async function acquireW5DesktopDeleteGate(
  dataRoot: string,
  kind: 'desktop' | 'delete',
): Promise<W5DesktopDeleteGate> {
  const root = observeStoragePathSync(resolve(dataRoot)).canonicalPath;
  const directory = join(root, 'runtime', 'locks');
  await ensureW5PrivateRuntimeDirectory(join(root, 'runtime'));
  await ensureW5PrivateRuntimeDirectory(directory);
  const path = join(directory, 'desktop-delete.sqlite');
  const stat = await lstat(path).catch((error: unknown) => {
    if (code(error) !== 'ENOENT') throw error;
    return undefined;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
    throw new W5DesktopDeleteAdmissionError(
      'Desktop presence cannot be verified. Nothing was deleted.',
    );
  const db = new DatabaseSync(path);
  try {
    if (hostOperatingSystem() !== 'win32') await chmod(path, 0o600);
    db.exec('PRAGMA busy_timeout = 0');
    if (await initializeDesktopDeleteGate(db, kind))
      for (const parent of [directory, dirname(directory), root, dirname(root)])
        await flushDirectory(parent);
    if (kind === 'delete') db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec(kind === 'delete' ? 'BEGIN EXCLUSIVE' : 'BEGIN');
    // Unlike the exclusively held canonical log, this latch is readable at
    // startup after owner death. It references the log, never replaces it.
    if (db.prepare('SELECT reservation_id FROM deletion_hold').get())
      throw new W5DesktopDeleteAdmissionError(
        'An interrupted CLI deletion needs manual recovery. Keep the existing files, commit log and idempotency key. Do not rerun deletion or start the desktop until recovery is complete.',
      );
    const change = (id: string, finish: boolean): void => {
      if (kind !== 'delete' || !id)
        throw new Error('Invalid deletion admission');
      // EXCLUSIVE locking mode retains exclusion across these durable commits.
      if (!db.isTransaction) db.exec('BEGIN EXCLUSIVE');
      if (finish) {
        const result = db
          .prepare(
            'DELETE FROM deletion_hold WHERE singleton = 1 AND reservation_id = ?',
          )
          .run(id);
        if (result.changes !== 1)
          throw new Error('Deletion admission identity changed');
      } else db.prepare('INSERT INTO deletion_hold VALUES (1, ?)').run(id);
      db.exec('COMMIT');
    };
    return {
      close: () => db.close(),
      protectReservation: (id) => change(id, false),
      completeReservation: (id) => change(id, true),
    };
  } catch (error) {
    db.close();
    if (sqliteBusy(error))
      throw new W5DesktopDeleteAdmissionError(
        kind === 'delete'
          ? 'A desktop app or another worktree operation is using this data folder. Delete the worktree in the desktop app, or quit it and try again. Nothing was deleted.'
          : 'A CLI worktree deletion is using this data folder. Wait for it to finish before starting the app.',
      );
    throw error;
  }
}
