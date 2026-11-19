import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  chmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hostOperatingSystem } from './host-platform';

const DEFAULT_POLL_MS = 100;
const INCOMPLETE_OWNER_GRACE_MS = 30_000;
const MISSING_LOCK = Symbol('missing-lock');
const LIVENESS_DIRECTORY = '.owner-liveness';
const LIVENESS_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface OwnerLockRecord {
  version: 1;
  pid: number;
  nonce: string;
  createdAt: string;
  /** Absent in records written by builds from before CAN-5736. */
  liveness?: string;
}

export interface OwnerLockFileOptions {
  /** How long a waiter polls before it gives up. */
  maxWaitMs: number;
  pollMs?: number;
  timeoutMessage: string;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

async function assertOwnedPath(
  target: string,
  expected: 'directory' | 'file',
): Promise<void> {
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link for lock ${expected}: ${target}`);
  }
  const matchesType =
    expected === 'directory' ? targetStat.isDirectory() : targetStat.isFile();
  if (!matchesType) {
    throw new Error(`Lock ${expected} has the wrong type: ${target}`);
  }
  if (
    typeof process.getuid === 'function' &&
    targetStat.uid !== process.getuid()
  ) {
    throw new Error(`Lock ${expected} is not owned by this user: ${target}`);
  }
}

/** Creates `directory` private to this user, refusing a link or a foreign owner. */
export async function ensurePrivateLockDirectory(
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertOwnedPath(directory, 'directory');
  if (hostOperatingSystem() !== 'win32') {
    await chmod(directory, 0o700);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

/*
 * Lock owner liveness (CAN-5736). While a process holds any lock in a lock
 * directory, it holds an exclusive SQLite transaction on
 * `<lock dir>/.owner-liveness/<token>.sqlite`, and records the token in every
 * lock it takes there. The file is removed with the process's last lock, so
 * nothing stays open in a directory that may later be deleted. The OS releases that byte-range
 * lock when the process exits or crashes, so a waiter that can take the
 * transaction itself, or finds the file gone, has proven the owner dead, even
 * when its PID now belongs to another process. Records without a token come
 * from older builds and keep PID liveness. Never open and close a raw
 * descriptor on a held token file: on POSIX that drops this process's lock.
 */
interface HeldLiveness {
  readonly token: string;
  readonly database: DatabaseSync;
  holds: number;
}
const heldLiveness = new Map<string, HeldLiveness>();

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('errcode' in error)) {
    return false;
  }
  return error.errcode === 5 || error.errcode === 6;
}

function closeQuietly(database: DatabaseSync): void {
  try {
    database.close();
  } catch {
    // Closing releases nothing this caller still needs.
  }
}

function livenessFile(lockDirectory: string, token: string): string {
  return path.join(lockDirectory, LIVENESS_DIRECTORY, `${token}.sqlite`);
}

/** Whether the process holding `token` for `lockDirectory` may still run. */
function isLivenessHeld(lockDirectory: string, token: string): boolean {
  const directory = path.resolve(lockDirectory);
  if (heldLiveness.get(directory)?.token === token) return true;
  const file = livenessFile(directory, token);
  try {
    const fileStat = lstatSync(file);
    if (!fileStat.isFile()) return true;
  } catch (error) {
    return errorCode(error) !== 'ENOENT';
  }
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(file);
  } catch {
    return true;
  }
  // Remove the file before releasing the proof on POSIX: a process that is
  // still creating this token then fails its lock or its inode check. Windows
  // refuses to delete a file that a live owner holds open, so it removes after.
  const removeWhileHeld = hostOperatingSystem() !== 'win32';
  try {
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('PRAGMA journal_mode = MEMORY');
    database.exec('BEGIN EXCLUSIVE');
    if (removeWhileHeld) removeDeadLiveness(file);
    database.exec('ROLLBACK');
  } catch {
    closeQuietly(database);
    return true;
  }
  closeQuietly(database);
  if (!removeWhileHeld) removeDeadLiveness(file);
  return false;
}

function removeDeadLiveness(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Another waiter proved the same owner dead and removed the file.
  }
}

function sweepDeadLiveness(lockDirectory: string): void {
  for (const name of readdirSync(
    path.join(lockDirectory, LIVENESS_DIRECTORY),
  )) {
    const token = name.endsWith('.sqlite')
      ? name.slice(0, -'.sqlite'.length)
      : '';
    if (LIVENESS_TOKEN.test(token)) isLivenessHeld(lockDirectory, token);
  }
}

/** Takes, or adds a hold on, this process's liveness token for `lockDirectory`. */
function holdLiveness(lockDirectory: string): void {
  const directory = path.resolve(lockDirectory);
  const held = heldLiveness.get(directory);
  if (held) {
    held.holds += 1;
    return;
  }
  ensurePrivateLockDirectorySync(path.join(directory, LIVENESS_DIRECTORY));
  sweepDeadLiveness(directory);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    const file = livenessFile(directory, token);
    const descriptor = openSync(file, 'wx', 0o600);
    let created: bigint;
    try {
      created = fstatSync(descriptor, { bigint: true }).ino;
    } finally {
      closeSync(descriptor);
    }
    const database = new DatabaseSync(file);
    try {
      database.exec('PRAGMA busy_timeout = 0');
      database.exec('PRAGMA journal_mode = MEMORY');
      database.exec('BEGIN EXCLUSIVE');
      // A sweeping waiter may have removed the file before the lock was taken.
      if (lstatSync(file, { bigint: true }).ino === created) {
        heldLiveness.set(directory, { token, database, holds: 1 });
        return;
      }
    } catch (error) {
      if (!isSqliteBusy(error) && errorCode(error) !== 'ENOENT') {
        closeQuietly(database);
        throw error;
      }
    }
    closeQuietly(database);
  }
  throw new Error(`Could not record lock owner liveness in ${directory}`);
}

/** Drops a hold; the last one removes the token file and releases its lock. */
function releaseLiveness(lockDirectory: string): void {
  const directory = path.resolve(lockDirectory);
  const held = heldLiveness.get(directory);
  if (!held) return;
  held.holds -= 1;
  if (held.holds > 0) return;
  heldLiveness.delete(directory);
  const file = livenessFile(directory, held.token);
  const removeWhileHeld = hostOperatingSystem() !== 'win32';
  if (removeWhileHeld) removeDeadLiveness(file);
  try {
    held.database.exec('ROLLBACK');
  } catch {
    // Closing below releases the transaction as well.
  }
  closeQuietly(held.database);
  if (!removeWhileHeld) removeDeadLiveness(file);
}

function heldLivenessToken(lockDirectory: string): string {
  const held = heldLiveness.get(path.resolve(lockDirectory));
  if (!held) throw new Error(`No lock owner liveness in ${lockDirectory}`);
  return held.token;
}

function isOwnerAlive(owner: OwnerLockRecord, lockDirectory: string): boolean {
  return owner.liveness === undefined
    ? isProcessAlive(owner.pid)
    : isLivenessHeld(lockDirectory, owner.liveness);
}

function parseLockOwner(contents: string): OwnerLockRecord | null {
  try {
    const value: unknown = JSON.parse(contents);
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      !('pid' in value) ||
      !('nonce' in value) ||
      !('createdAt' in value)
    ) {
      return null;
    }
    const version = value.version;
    const pid = value.pid;
    const nonce = value.nonce;
    const createdAt = value.createdAt;
    const liveness = 'liveness' in value ? value.liveness : undefined;
    return version === 1 &&
      typeof pid === 'number' &&
      Number.isInteger(pid) &&
      typeof nonce === 'string' &&
      typeof createdAt === 'string'
      ? {
          version,
          pid,
          nonce,
          createdAt,
          ...(typeof liveness === 'string' &&
            LIVENESS_TOKEN.test(liveness) && { liveness }),
        }
      : null;
  } catch {
    return null;
  }
}

function newOwner(lockPath: string): OwnerLockRecord {
  return {
    version: 1,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
    liveness: heldLivenessToken(path.dirname(lockPath)),
  };
}

async function staleLockSnapshot(
  lockPath: string,
): Promise<string | typeof MISSING_LOCK | null> {
  try {
    await assertOwnedPath(lockPath, 'file');
    const contents = await readFile(lockPath, 'utf8');
    const owner = parseLockOwner(contents);
    if (owner) {
      return isOwnerAlive(owner, path.dirname(lockPath)) ? null : contents;
    }
    try {
      const lockStat = await stat(lockPath);
      return Date.now() - lockStat.mtimeMs >= INCOMPLETE_OWNER_GRACE_MS
        ? contents
        : null;
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? MISSING_LOCK : null;
    }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? MISSING_LOCK : null;
  }
}

async function tryReclaimStaleLock(lockPath: string): Promise<boolean> {
  const staleSnapshot = await staleLockSnapshot(lockPath);
  if (staleSnapshot === null) {
    return false;
  }
  if (staleSnapshot === MISSING_LOCK) {
    return true;
  }

  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimOwnerPath = path.join(reclaimPath, 'owner.json');
  const reclaimOwner = newOwner(lockPath);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(reclaimPath, { mode: 0o700 });
      await assertOwnedPath(reclaimPath, 'directory');
      try {
        await writeFile(reclaimOwnerPath, JSON.stringify(reclaimOwner), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        await rmdir(reclaimPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      await assertOwnedPath(reclaimPath, 'directory');
      if (await removeStaleReclaimDirectory(reclaimPath, reclaimOwnerPath)) {
        continue;
      }
      return false;
    }

    try {
      const current = await readFile(lockPath, 'utf8').catch((error) => {
        if (errorCode(error) === 'ENOENT') {
          return MISSING_LOCK;
        }
        throw error;
      });
      if (current !== staleSnapshot) {
        return current === MISSING_LOCK;
      }
      await unlink(lockPath);
      return true;
    } finally {
      await releaseReclaimDirectory(
        reclaimPath,
        reclaimOwnerPath,
        reclaimOwner,
      );
    }
  }

  return false;
}

async function removeStaleReclaimDirectory(
  reclaimPath: string,
  ownerPath: string,
): Promise<boolean> {
  await assertOwnedPath(reclaimPath, 'directory');
  let snapshot: string;
  try {
    snapshot = await readFile(ownerPath, 'utf8');
    const owner = parseLockOwner(snapshot);
    if (owner) {
      if (isOwnerAlive(owner, path.dirname(reclaimPath))) return false;
    } else if (
      Date.now() - (await stat(ownerPath)).mtimeMs <
      INCOMPLETE_OWNER_GRACE_MS
    ) {
      return false;
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return false;
    try {
      if (
        Date.now() - (await stat(reclaimPath)).mtimeMs <
        INCOMPLETE_OWNER_GRACE_MS
      ) {
        return false;
      }
      await rmdir(reclaimPath);
      return true;
    } catch {
      return false;
    }
  }

  try {
    if ((await readFile(ownerPath, 'utf8')) !== snapshot) return false;
    await unlink(ownerPath);
    await rmdir(reclaimPath);
    return true;
  } catch {
    return false;
  }
}

async function releaseReclaimDirectory(
  reclaimPath: string,
  ownerPath: string,
  owner: OwnerLockRecord,
): Promise<void> {
  try {
    await assertOwnedPath(reclaimPath, 'directory');
    const current = parseLockOwner(await readFile(ownerPath, 'utf8'));
    if (current?.nonce !== owner.nonce) return;
    await unlink(ownerPath);
    await rmdir(reclaimPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

async function releaseOwnedLock(
  lockPath: string,
  owner: OwnerLockRecord,
): Promise<void> {
  try {
    await assertOwnedPath(lockPath, 'file');
    const current = parseLockOwner(await readFile(lockPath, 'utf8'));
    if (current?.nonce === owner.nonce) {
      await unlink(lockPath);
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Runs `operation` while holding `lockPath`, an exclusively created
 * `{pid, nonce, liveness}` file in a private directory, across every process
 * of this user. A lock whose owner has exited is reclaimed, even when its PID
 * was reused; a live owner is never displaced, so a waiter gives up after
 * `maxWaitMs`.
 */
export async function withOwnerLockFile<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: OwnerLockFileOptions,
): Promise<T> {
  const lockDirectory = path.dirname(lockPath);
  holdLiveness(lockDirectory);
  try {
    const deadline = Date.now() + options.maxWaitMs;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

    while (Date.now() < deadline) {
      const owner = newOwner(lockPath);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw error;
        }
        if (await tryReclaimStaleLock(lockPath)) {
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }

      try {
        await handle.writeFile(JSON.stringify(owner), 'utf8');
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      try {
        await handle.close();
      } catch (error) {
        // Left in place, this live-PID lock is never reclaimed: every later
        // waiter, in any process, times out after maxWaitMs.
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      await assertOwnedPath(lockPath, 'file');
      try {
        return await operation();
      } finally {
        await releaseOwnedLock(lockPath, owner);
      }
    }

    throw new Error(options.timeoutMessage);
  } finally {
    releaseLiveness(lockDirectory);
  }
}

function assertOwnedPathSync(
  target: string,
  expected: 'directory' | 'file',
): void {
  const targetStat = lstatSync(target);
  if (targetStat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link for lock ${expected}: ${target}`);
  }
  const matchesType =
    expected === 'directory' ? targetStat.isDirectory() : targetStat.isFile();
  if (!matchesType) {
    throw new Error(`Lock ${expected} has the wrong type: ${target}`);
  }
  if (
    typeof process.getuid === 'function' &&
    targetStat.uid !== process.getuid()
  ) {
    throw new Error(`Lock ${expected} is not owned by this user: ${target}`);
  }
}

/** Synchronous {@link ensurePrivateLockDirectory}. */
export function ensurePrivateLockDirectorySync(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertOwnedPathSync(directory, 'directory');
  if (hostOperatingSystem() !== 'win32') {
    chmodSync(directory, 0o700);
  }
}

function staleLockSnapshotSync(
  lockPath: string,
): string | typeof MISSING_LOCK | null {
  try {
    assertOwnedPathSync(lockPath, 'file');
    const contents = readFileSync(lockPath, 'utf8');
    const owner = parseLockOwner(contents);
    if (owner) {
      return isOwnerAlive(owner, path.dirname(lockPath)) ? null : contents;
    }
    try {
      const lockStat = statSync(lockPath);
      return Date.now() - lockStat.mtimeMs >= INCOMPLETE_OWNER_GRACE_MS
        ? contents
        : null;
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? MISSING_LOCK : null;
    }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? MISSING_LOCK : null;
  }
}

function tryReclaimStaleLockSync(lockPath: string): boolean {
  const staleSnapshot = staleLockSnapshotSync(lockPath);
  if (staleSnapshot === null) {
    return false;
  }
  if (staleSnapshot === MISSING_LOCK) {
    return true;
  }

  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimOwnerPath = path.join(reclaimPath, 'owner.json');
  const reclaimOwner = newOwner(lockPath);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(reclaimPath, { mode: 0o700 });
      assertOwnedPathSync(reclaimPath, 'directory');
      try {
        writeFileSync(reclaimOwnerPath, JSON.stringify(reclaimOwner), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        try {
          rmdirSync(reclaimPath);
        } catch {
          // Preserve the original failure if cleanup also fails.
        }
        throw error;
      }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      assertOwnedPathSync(reclaimPath, 'directory');
      if (removeStaleReclaimDirectorySync(reclaimPath, reclaimOwnerPath)) {
        continue;
      }
      return false;
    }

    try {
      let current: string | typeof MISSING_LOCK;
      try {
        current = readFileSync(lockPath, 'utf8');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        current = MISSING_LOCK;
      }
      if (current !== staleSnapshot) {
        return current === MISSING_LOCK;
      }
      unlinkSync(lockPath);
      return true;
    } finally {
      releaseReclaimDirectorySync(reclaimPath, reclaimOwnerPath, reclaimOwner);
    }
  }

  return false;
}

function removeStaleReclaimDirectorySync(
  reclaimPath: string,
  ownerPath: string,
): boolean {
  assertOwnedPathSync(reclaimPath, 'directory');
  let snapshot: string;
  try {
    snapshot = readFileSync(ownerPath, 'utf8');
    const owner = parseLockOwner(snapshot);
    if (owner) {
      if (isOwnerAlive(owner, path.dirname(reclaimPath))) return false;
    } else if (
      Date.now() - statSync(ownerPath).mtimeMs <
      INCOMPLETE_OWNER_GRACE_MS
    ) {
      return false;
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return false;
    try {
      if (
        Date.now() - statSync(reclaimPath).mtimeMs <
        INCOMPLETE_OWNER_GRACE_MS
      ) {
        return false;
      }
      rmdirSync(reclaimPath);
      return true;
    } catch {
      return false;
    }
  }

  try {
    if (readFileSync(ownerPath, 'utf8') !== snapshot) return false;
    unlinkSync(ownerPath);
    rmdirSync(reclaimPath);
    return true;
  } catch {
    return false;
  }
}

function releaseReclaimDirectorySync(
  reclaimPath: string,
  ownerPath: string,
  owner: OwnerLockRecord,
): void {
  try {
    assertOwnedPathSync(reclaimPath, 'directory');
    const current = parseLockOwner(readFileSync(ownerPath, 'utf8'));
    if (current?.nonce !== owner.nonce) return;
    unlinkSync(ownerPath);
    rmdirSync(reclaimPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function releaseOwnedLockSync(lockPath: string, owner: OwnerLockRecord): void {
  try {
    assertOwnedPathSync(lockPath, 'file');
    const current = parseLockOwner(readFileSync(lockPath, 'utf8'));
    if (current?.nonce === owner.nonce) {
      unlinkSync(lockPath);
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Synchronous {@link withOwnerLockFile}. Blocks between attempts and refuses
 * after `maxWaitMs`; `operation` must be synchronous.
 */
export function withOwnerLockFileSync<T>(
  lockPath: string,
  operation: () => T,
  options: OwnerLockFileOptions,
): T {
  const lockDirectory = path.dirname(lockPath);
  holdLiveness(lockDirectory);
  try {
    const deadline = Date.now() + options.maxWaitMs;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    while (Date.now() < deadline) {
      const owner = newOwner(lockPath);
      let fd: number;
      try {
        fd = openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        if (tryReclaimStaleLockSync(lockPath)) continue;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
        continue;
      }
      try {
        writeFileSync(fd, JSON.stringify(owner), 'utf8');
      } catch (error) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the original failure if cleanup also fails.
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // Preserve the original failure if cleanup also fails.
        }
        throw error;
      }
      try {
        closeSync(fd);
      } catch (error) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Preserve the original failure if cleanup also fails.
        }
        throw error;
      }
      assertOwnedPathSync(lockPath, 'file');
      try {
        return operation();
      } finally {
        releaseOwnedLockSync(lockPath, owner);
      }
    }
    throw new Error(options.timeoutMessage);
  } finally {
    releaseLiveness(lockDirectory);
  }
}
