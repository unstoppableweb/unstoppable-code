import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  MEMORY_LOCK_DIRNAME,
  MEMORY_LOCK_OWNER_FILENAME,
  MEMORY_SYNC_TIMINGS,
  MemoryLocalLockOwnerFileSchema,
  type MemoryLocalLockOwnerFile,
} from '@canopy/protocol/memory-sync';
import { renameWithRetry } from '../../lib/atomic-file';
import {
  MEMORY_DIR_MODE,
  MEMORY_FILE_MODE,
  ensureOwnerOnlyDir,
  isNodeError,
  runHoldingMemoryScopeLock,
} from '@canopy/memory-store/memory-files';

/*
 * The cross-process lock of one memory scope directory: `<scope>/.lock/`,
 * born holding its `owner.json`. It keeps the app, a second app instance and
 * any other local writer out of each other's short critical sections;
 * `withMemoryWriteLock` serializes writers within this process first.
 *
 * Every move of the lock directory (a takeover, a release) and every
 * heartbeat runs under the takeover mutex `<scope>/.lock.takeover/`, so a
 * lock seen there under the mutex stays the same lock with the same owner
 * until its mutex holder moves it. A holder checks that `.lock` still names
 * its token before each write it commits.
 *
 * Lock entries are inspected without following links: a link or junction
 * planted at a lock name is never a lock, is moved aside as stale, and
 * nothing is read or written through it.
 */

const TAKEOVER_DIRNAME = `${MEMORY_LOCK_DIRNAME}.takeover`;
const PENDING_PREFIX = `${MEMORY_LOCK_DIRNAME}.pending-`;
const STALE_PREFIX = `${MEMORY_LOCK_DIRNAME}.stale-`;
const RELEASED_PREFIX = `${MEMORY_LOCK_DIRNAME}.released-`;
const STOLEN_MARKER = 'stolen';
const DEFAULT_TIMEOUT_MS = 2 * MEMORY_SYNC_TIMINGS.localLockStaleMs;
const RETRY_MIN_MS = 10;
const RETRY_MAX_MS = 250;
/** A live pid this long silent on the same host is a reused pid. */
const PID_REUSE_GUARD_MS = 10 * 60_000;
/**
 * Moved-aside locks and mutexes stay as `.lock.stale-<token>` this long, so a
 * process that judged the same owner stale cannot rename a newer one into
 * that name.
 */
const STALE_TOMBSTONE_RETENTION_MS = 10 * 60_000;
/** Codes of a rename refused because its target exists (EPERM on Windows). */
const TARGET_TAKEN_CODES = [
  'EEXIST',
  'ENOTEMPTY',
  'ENOTDIR',
  'EPERM',
  'EACCES',
  'EBUSY',
];
const TRANSIENT_READ_CODES = ['EPERM', 'EACCES', 'EBUSY'];
const TRANSIENT_READ_ATTEMPTS = 3;

type LockProcessKind = MemoryLocalLockOwnerFile['processKind'];

export interface MemoryScopeLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  hostname?: string;
  pid?: number;
  processKind?: LockProcessKind;
  isProcessAlive?: (pid: number) => boolean;
}

interface LockEnvironment {
  timeoutMs: number;
  staleMs: number;
  heartbeatMs: number;
  now: () => number;
  hostname: string;
  pid: number;
  processKind: LockProcessKind;
  isProcessAlive: (pid: number) => boolean;
}

export class LocalMemoryScopeLockTimeoutError extends Error {
  constructor() {
    super(
      `Another ${BRAND.displayName} process is changing these memories. Try again in a moment.`,
    );
    this.name = 'LocalMemoryScopeLockTimeoutError';
  }
}

/**
 * The scope's lock no longer names this writer: another process took it
 * over, or a takeover moved a newer holder's lock aside and could not put it
 * back. Nothing more is written under it.
 */
export class LocalMemoryScopeLockLostError extends Error {
  constructor() {
    super(
      `Another ${BRAND.displayName} process took over these memories before this change was saved. Try again.`,
    );
    this.name = 'LocalMemoryScopeLockLostError';
  }
}

/** Tokens of the locks and takeover mutexes this process holds now. */
const heldTokens = new Set<string>();

function currentProcessKind(): LockProcessKind {
  if (process.env.JEST_WORKER_ID !== undefined) return 'test';
  return process.versions.electron ? 'app' : 'cli';
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function lockEnvironment(options: MemoryScopeLockOptions): LockEnvironment {
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    staleMs: options.staleMs ?? MEMORY_SYNC_TIMINGS.localLockStaleMs,
    heartbeatMs:
      options.heartbeatMs ?? MEMORY_SYNC_TIMINGS.localLockHeartbeatMs,
    now: options.now ?? Date.now,
    hostname: options.hostname ?? hostname(),
    pid: options.pid ?? process.pid,
    processKind: options.processKind ?? currentProcessKind(),
    isProcessAlive: options.isProcessAlive ?? processIsAlive,
  };
}

/**
 * Mutex sections take milliseconds; a holder silent for a third of the lock's
 * stale time stopped. Shorter than the lock's, so a dead mutex holder cannot
 * hold up a live lock holder's heartbeat until that lock looks stale.
 */
function mutexStaleMs(env: LockEnvironment): number {
  return Math.floor(env.staleMs / 3);
}

function newOwner(env: LockEnvironment): MemoryLocalLockOwnerFile {
  const now = new Date(env.now()).toISOString();
  return {
    version: 1,
    token: randomUUID(),
    pid: env.pid,
    hostname: env.hostname,
    processKind: env.processKind,
    acquiredAt: now,
    heartbeatAt: now,
  };
}

function serializeOwner(owner: MemoryLocalLockOwnerFile): string {
  return `${JSON.stringify(owner, null, 2)}\n`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether `path` is a real directory, not a link to one. */
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readOwner(
  lockDir: string,
): Promise<MemoryLocalLockOwnerFile | null> {
  if (!(await isRealDirectory(lockDir))) return null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const parsed = MemoryLocalLockOwnerFileSchema.safeParse(
        JSON.parse(
          await readFile(join(lockDir, MEMORY_LOCK_OWNER_FILENAME), 'utf8'),
        ),
      );
      return parsed.success ? parsed.data : null;
    } catch (error) {
      // Windows refuses to open a file being renamed over for a moment.
      if (
        attempt < TRANSIENT_READ_ATTEMPTS &&
        TRANSIENT_READ_CODES.some((code) => isNodeError(error, code))
      ) {
        await delay(RETRY_MIN_MS);
        continue;
      }
      return null;
    }
  }
}

interface LockInspection {
  owner: MemoryLocalLockOwnerFile | null;
  /** The entry's inode, naming an owner-less one. */
  inode: string;
  modifiedMs: number;
  /** A link, junction or file at the lock's name: never a lock, always stale. */
  linked: boolean;
}

async function inspectLock(lockDir: string): Promise<LockInspection | null> {
  try {
    const info = await lstat(lockDir, { bigint: true });
    const linked = !info.isDirectory();
    return {
      owner: linked ? null : await readOwner(lockDir),
      inode: info.ino.toString(),
      modifiedMs: linked ? 0 : Number(info.mtimeMs),
      linked,
    };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

/**
 * An owner is stale once it has not refreshed its heartbeat for `staleMs`
 * and, on this host, its process is gone. A directory without a readable
 * owner is stale once it is that old.
 */
function isStale(
  lock: LockInspection,
  env: LockEnvironment,
  staleMs: number,
): boolean {
  const now = env.now();
  const { owner } = lock;
  if (owner === null) return now - lock.modifiedMs > staleMs;
  const silentMs = Math.abs(now - Date.parse(owner.heartbeatAt));
  if (silentMs <= staleMs) return false;
  if (owner.hostname !== env.hostname) return true;
  if (owner.pid === env.pid) return !heldTokens.has(owner.token);
  return !env.isProcessAlive(owner.pid) || silentMs > PID_REUSE_GUARD_MS;
}

function lockName(lock: LockInspection): string {
  return lock.owner?.token ?? `inode-${lock.inode}`;
}

function sameLock(left: LockInspection, right: LockInspection): boolean {
  return left.owner !== null || right.owner !== null
    ? left.owner?.token === right.owner?.token
    : left.inode === right.inode;
}

/**
 * Creates `<scope>/<name>` already holding `owner.json`: the owner is written
 * into a private sibling, which is renamed into place. A directory never
 * renames onto one that is not empty (nor onto any directory on Windows), so
 * this creates the whole lock or nothing. False when the name is taken.
 */
async function createLockDir(
  scopeDir: string,
  name: string,
  owner: MemoryLocalLockOwnerFile,
): Promise<boolean> {
  const pending = join(scopeDir, `${PENDING_PREFIX}${randomUUID()}`);
  try {
    await mkdir(pending, { mode: MEMORY_DIR_MODE });
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
    await ensureOwnerOnlyDir(scopeDir, { trustedScopeRoot: scopeDir });
    await mkdir(pending, { mode: MEMORY_DIR_MODE });
  }
  try {
    await writeFile(
      join(pending, MEMORY_LOCK_OWNER_FILENAME),
      serializeOwner(owner),
      { encoding: 'utf8', mode: MEMORY_FILE_MODE, flag: 'wx' },
    );
    await rename(pending, join(scopeDir, name));
    return true;
  } catch (error) {
    await rm(pending, { recursive: true, force: true }).catch(() => undefined);
    if (TARGET_TAKEN_CODES.some((code) => isNodeError(error, code))) {
      return false;
    }
    throw error;
  }
}

/**
 * Moves the stale lock or mutex at `<scope>/<name>` aside, then checks that
 * what moved is the one judged stale; a newer one is put straight back.
 * Resolves whether `name` is now free. Rejects with
 * {@link LocalMemoryScopeLockLostError} when a newer one moved and could not
 * be put back: its holder lost it, which is never ignored.
 */
async function moveStaleAside(
  scopeDir: string,
  name: string,
  stale: LockInspection,
): Promise<boolean> {
  const live = join(scopeDir, name);
  const tombstone = join(scopeDir, `${STALE_PREFIX}${lockName(stale)}`);
  try {
    await renameWithRetry(live, tombstone);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    // Another process already moved this owner's lock into that name.
    if (TARGET_TAKEN_CODES.some((code) => isNodeError(error, code))) {
      return false;
    }
    throw error;
  }
  const moved = await inspectLock(tombstone);
  if (moved === null || sameLock(moved, stale)) {
    if (moved !== null && !moved.linked) {
      await writeFile(join(tombstone, STOLEN_MARKER), '', {
        mode: MEMORY_FILE_MODE,
        flag: 'wx',
      }).catch(() => undefined);
    }
    return true;
  }
  try {
    await renameWithRetry(tombstone, live);
  } catch {
    process.emitWarning(
      'Moved a newer local memory lock aside during a takeover and could not put it back',
      { code: 'LOCAL_MEMORY_LOCK_DISPLACED' },
    );
    throw new LocalMemoryScopeLockLostError();
  }
  return false;
}

/** Removes `<scope>/<name>` only while it is `token`'s; false when not. */
async function removeIfOwned(
  scopeDir: string,
  name: string,
  token: string,
): Promise<boolean> {
  const directory = join(scopeDir, name);
  if ((await readOwner(directory))?.token !== token) return false;
  const released = join(scopeDir, `${RELEASED_PREFIX}${token}`);
  await renameWithRetry(directory, released);
  await rm(released, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function tryTakeMutex(
  scopeDir: string,
  owner: MemoryLocalLockOwnerFile,
  env: LockEnvironment,
): Promise<boolean> {
  if (await createLockDir(scopeDir, TAKEOVER_DIRNAME, owner)) return true;
  const holder = await inspectLock(join(scopeDir, TAKEOVER_DIRNAME));
  if (holder === null || !isStale(holder, env, mutexStaleMs(env))) {
    return false;
  }
  return (
    (await moveStaleAside(scopeDir, TAKEOVER_DIRNAME, holder)) &&
    createLockDir(scopeDir, TAKEOVER_DIRNAME, owner)
  );
}

/**
 * Takes the scope's takeover mutex, waiting up to `waitMs` for a live holder
 * and moving aside one that stopped. Its token, or null when not taken.
 */
async function takeMutex(
  scopeDir: string,
  env: LockEnvironment,
  waitMs: number,
): Promise<string | null> {
  const deadline = env.now() + waitMs;
  let retryMs = RETRY_MIN_MS;
  for (;;) {
    const owner = newOwner(env);
    if (await tryTakeMutex(scopeDir, owner, env)) {
      heldTokens.add(owner.token);
      return owner.token;
    }
    if (env.now() >= deadline) return null;
    await delay(retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }
}

async function releaseMutex(scopeDir: string, token: string): Promise<void> {
  heldTokens.delete(token);
  if (!(await removeIfOwned(scopeDir, TAKEOVER_DIRNAME, token))) {
    process.emitWarning(
      'A local memory lock takeover this process ran was moved aside as stale',
      { code: 'LOCAL_MEMORY_LOCK_MUTEX_LOST' },
    );
  }
}

async function withMutex<T>(
  scopeDir: string,
  token: string,
  section: () => Promise<T>,
): Promise<T> {
  try {
    return await section();
  } finally {
    await releaseMutex(scopeDir, token).catch((error: unknown) => {
      process.emitWarning(
        error instanceof Error ? error.message : String(error),
        { code: 'LOCAL_MEMORY_LOCK_MUTEX_RELEASE_FAILED' },
      );
    });
  }
}

/**
 * Takes over the scope's lock when it is still stale under the takeover
 * mutex. Resolves whether `.lock` is now free to create.
 */
async function takeOverStaleLock(
  scopeDir: string,
  env: LockEnvironment,
): Promise<boolean> {
  const mutex = await takeMutex(scopeDir, env, 0);
  if (mutex === null) return false;
  return withMutex(scopeDir, mutex, async () => {
    const stale = await inspectLock(join(scopeDir, MEMORY_LOCK_DIRNAME));
    if (stale === null) return true;
    if (!isStale(stale, env, env.staleMs)) return false;
    if (!(await moveStaleAside(scopeDir, MEMORY_LOCK_DIRNAME, stale))) {
      return false;
    }
    const owner = stale.owner;
    process.emitWarning(
      owner === null
        ? 'Took over a local memory lock without a readable owner'
        : `Took over a local memory lock process ${owner.pid} on ${owner.hostname} stopped refreshing`,
      { code: 'LOCAL_MEMORY_LOCK_STOLEN' },
    );
    return true;
  });
}

async function writeOwner(
  lockDir: string,
  owner: MemoryLocalLockOwnerFile,
): Promise<void> {
  const target = join(lockDir, MEMORY_LOCK_OWNER_FILENAME);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serializeOwner(owner), {
      encoding: 'utf8',
      mode: MEMORY_FILE_MODE,
    });
    await renameWithRetry(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Removes released lock directories and, after their retention, moved-aside
 * and abandoned pending ones; under the takeover mutex, best effort.
 */
async function removeOldTombstones(
  scopeDir: string,
  env: LockEnvironment,
): Promise<void> {
  const names = (await readdir(scopeDir).catch((): string[] => [])).filter(
    (name) =>
      name.startsWith(RELEASED_PREFIX) ||
      name.startsWith(STALE_PREFIX) ||
      name.startsWith(PENDING_PREFIX),
  );
  if (names.length === 0) return;
  const mutex = await takeMutex(scopeDir, env, 0).catch(() => null);
  if (mutex === null) return;
  await withMutex(scopeDir, mutex, async () => {
    for (const name of names) {
      const path = join(scopeDir, name);
      const info = await lstat(path).catch(() => null);
      if (
        info !== null &&
        (name.startsWith(RELEASED_PREFIX) ||
          env.now() - info.mtimeMs > STALE_TOMBSTONE_RETENTION_MS)
      ) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
}

export interface MemoryScopeLock {
  readonly token: string;
  /** Whether this process found its lock taken over while holding it. */
  readonly lost: boolean;
  /**
   * Rejects with {@link LocalMemoryScopeLockLostError} unless the scope's
   * lock still names this token. Call it right before each write commit.
   */
  assertHeld(): Promise<void>;
  /** Removes the lock while it is still this one's; never another's. */
  release(): Promise<void>;
}

function holdLock(
  scopeDir: string,
  owner: MemoryLocalLockOwnerFile,
  env: LockEnvironment,
): MemoryScopeLock {
  const lockDir = join(scopeDir, MEMORY_LOCK_DIRNAME);
  heldTokens.add(owner.token);
  let lost = false;
  let released = false;
  let beating: Promise<void> = Promise.resolve();
  const markLost = (): void => {
    if (lost) return;
    lost = true;
    process.emitWarning(
      'Another process took over a local memory lock this process held',
      { code: 'LOCAL_MEMORY_LOCK_LOST' },
    );
  };
  const stillOwned = async (): Promise<boolean> =>
    (await readOwner(lockDir))?.token === owner.token;
  const beat = async (): Promise<void> => {
    if (lost || released) return;
    const mutex = await takeMutex(scopeDir, env, env.heartbeatMs);
    if (mutex === null) return;
    await withMutex(scopeDir, mutex, async () => {
      if (!(await stillOwned())) {
        markLost();
        return;
      }
      await writeOwner(lockDir, {
        ...owner,
        heartbeatAt: new Date(env.now()).toISOString(),
      });
    });
  };
  const timer = setInterval(() => {
    beating = beating.then(beat).catch(() => undefined);
  }, env.heartbeatMs);
  timer.unref();
  return {
    token: owner.token,
    get lost(): boolean {
      return lost;
    },
    async assertHeld(): Promise<void> {
      await beating;
      if (!lost && !(await stillOwned())) markLost();
      if (lost || released) throw new LocalMemoryScopeLockLostError();
    },
    async release(): Promise<void> {
      if (released) return;
      clearInterval(timer);
      await beating;
      released = true;
      try {
        const mutex = await takeMutex(scopeDir, env, env.timeoutMs);
        if (mutex === null) {
          process.emitWarning(
            'Could not release a local memory lock; it is taken over once stale',
            { code: 'LOCAL_MEMORY_LOCK_RELEASE_DEFERRED' },
          );
          return;
        }
        const removed = await withMutex(scopeDir, mutex, () =>
          removeIfOwned(scopeDir, MEMORY_LOCK_DIRNAME, owner.token),
        );
        if (!removed) markLost();
      } finally {
        heldTokens.delete(owner.token);
      }
    },
  };
}

/**
 * Waits for and takes the scope's lock, taking over a stale one. Rejects
 * with {@link LocalMemoryScopeLockTimeoutError} when a live holder keeps it
 * past the timeout. Hold it only for local file work, never across a network
 * call or a model run.
 */
export async function acquireMemoryScopeLock(
  scopeDir: string,
  options: MemoryScopeLockOptions = {},
): Promise<MemoryScopeLock> {
  const env = lockEnvironment(options);
  const lockDir = join(scopeDir, MEMORY_LOCK_DIRNAME);
  const deadline = env.now() + env.timeoutMs;
  let retryMs = RETRY_MIN_MS;
  for (;;) {
    const owner = newOwner(env);
    if (await createLockDir(scopeDir, MEMORY_LOCK_DIRNAME, owner)) {
      const lock = holdLock(scopeDir, owner, env);
      await removeOldTombstones(scopeDir, env);
      return lock;
    }
    const holder = await inspectLock(lockDir);
    if (
      holder !== null &&
      isStale(holder, env, env.staleMs) &&
      (await takeOverStaleLock(scopeDir, env))
    ) {
      continue;
    }
    if (env.now() >= deadline) throw new LocalMemoryScopeLockTimeoutError();
    if (holder === null) {
      // The holder just left; try again at once, but never spin.
      await delay(RETRY_MIN_MS);
      continue;
    }
    await delay(retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }
}

/**
 * Runs `critical` holding the scope's lock. Writes it commits through the
 * memory file helpers check the lock first (`assertMemoryScopeLockHeld`), so
 * once another process takes the lock over, the next one rejects with
 * {@link LocalMemoryScopeLockLostError} instead of writing.
 */
export async function withMemoryScopeLock<T>(
  scopeDir: string,
  critical: () => Promise<T>,
  options: MemoryScopeLockOptions = {},
): Promise<T> {
  const lock = await acquireMemoryScopeLock(scopeDir, options);
  try {
    return await runHoldingMemoryScopeLock(lock, critical);
  } finally {
    await lock.release();
  }
}
