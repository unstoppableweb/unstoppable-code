import { AsyncLocalStorage } from 'node:async_hooks';

export interface W5RepositoryLock {
  kind: 'index' | 'manifest' | 'list';
  path: string;
}
interface Lease {
  lock: W5RepositoryLock;
  active: boolean;
  writable: boolean;
  release: () => void;
  /** Settles once the lease releases. */
  released: Promise<void>;
  taskTail: Promise<void>;
}
interface LockScope {
  active: boolean;
  leases: Map<string, Lease>;
  acquired: Lease[];
  pending: Map<string, Promise<Lease>>;
  tasks: Map<string, Promise<void>>;
  last?: W5RepositoryLock;
}
const scopeContext = new AsyncLocalStorage<LockScope>();
const taskContext = new AsyncLocalStorage<ReadonlyMap<string, Lease>>();
const reservationContext = new AsyncLocalStorage<ReadonlyMap<string, Lease>>();
const tails = new Map<string, Promise<void>>();
const ranks = { index: 0, manifest: 1, list: 2 };

function compare(a: W5RepositoryLock, b: W5RepositoryLock): number {
  return (
    ranks[a.kind] - ranks[b.kind] ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

export function ownsW5RepositoryLock(): boolean {
  return [
    ...Array.from(scopeContext.getStore()?.leases.values() ?? []),
    ...Array.from(taskContext.getStore()?.values() ?? []),
    ...Array.from(reservationContext.getStore()?.values() ?? []),
  ].some((lease) => lease.active);
}

// Read views refuse writes; explicit plain-read leases cannot commit either.
let readOnlyContext: () => boolean = () => false;
let writableLeases = 0;

/** The host names where writes are refused; those locks never order a commit. */
export function setW5ReadOnlyLockContext(test: () => boolean): void {
  readOnlyContext = test;
}

/** A lock that may order a commit is held or queued in this process. */
export function hasW5WritableLocksInFlight(): boolean {
  return writableLeases > 0;
}

/** Per path, the release of each writer-capable lease held or queued on it. */
const writers = new Map<
  string,
  { lock: W5RepositoryLock; released: Set<Promise<void>> }
>();

function trackWriter(lock: W5RepositoryLock, released: Promise<void>): void {
  writableLeases += 1;
  const entry = writers.get(lock.path);
  if (entry) entry.released.add(released);
  else writers.set(lock.path, { lock, released: new Set([released]) });
}

function untrackWriter(lock: W5RepositoryLock, released: Promise<void>): void {
  writableLeases -= 1;
  const entry = writers.get(lock.path);
  entry?.released.delete(released);
  if (entry?.released.size === 0) writers.delete(lock.path);
}

export interface W5WriterInFlight {
  readonly lock: W5RepositoryLock;
  /** Settles once every writer-capable lease on the lock at the call releases. */
  readonly released: Promise<void>;
}

/**
 * The locks `matches` accepts that a writer-capable lease holds or queues
 * for now; synchronous and empty while none does. Writers that arrive later
 * are not included, so a caller that waits cannot starve.
 */
export function w5WritersInFlight(
  matches: (lock: W5RepositoryLock) => boolean,
): W5WriterInFlight[] {
  if (writableLeases === 0) return [];
  return Array.from(writers.values()).flatMap(({ lock, released }) =>
    matches(lock)
      ? [{ lock, released: Promise.all(released).then(() => undefined) }]
      : [],
  );
}

async function acquire(
  lock: W5RepositoryLock,
  readOnly = false,
): Promise<Lease> {
  const previous = tails.get(lock.path) ?? Promise.resolve();
  let release: () => void = () => {};
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(lock.path, tail);
  const writable = !readOnly && !readOnlyContext();
  if (writable) trackWriter(lock, tail);
  await previous;
  const lease: Lease = {
    lock,
    active: true,
    writable,
    released: tail,
    taskTail: Promise.resolve(),
    release: () => {
      if (!lease.active) return;
      lease.active = false;
      if (lease.writable) untrackWriter(lock, tail);
      release();
      if (tails.get(lock.path) === tail) tails.delete(lock.path);
    },
  };
  return lease;
}

/** Same-file writers wait until a scope applies or aborts; pure reads remain ungated. */
export async function withW5RepositoryLock<T>(
  lock: W5RepositoryLock,
  work: () => Promise<T>,
  options?: {
    join?: boolean;
    /** The callback cannot write. Commit scopes still retain a writer lease. */
    readOnly?: boolean;
  },
): Promise<T> {
  const scope = scopeContext.getStore();
  if (scope && !scope.active)
    throw new Error('The W5 commit locks have finished');
  const inherited = taskContext.getStore() ?? new Map<string, Lease>();
  if (inherited.get(lock.path)?.active && (scope || options?.join))
    return work();
  if (
    !reservationContext.getStore()?.get(lock.path)?.active &&
    Array.from(inherited.values()).some(
      (lease) => lease.active && compare(lock, lease.lock) < 0,
    )
  ) {
    throw new Error(
      'W5 commit lock order must be index, manifests, then lists (paths sorted within each kind)',
    );
  }
  if (scope) {
    let lease = scope.leases.get(lock.path);
    if (!lease) {
      let pending = scope.pending.get(lock.path);
      if (!pending) {
        if (scope.last && compare(lock, scope.last) < 0)
          throw new Error(
            'W5 commit lock order must be index, manifests, then lists (paths sorted within each kind)',
          );
        scope.last = lock;
        pending = acquire(lock);
        scope.pending.set(lock.path, pending);
      }
      lease = await pending;
      if (!scope.active) {
        lease.release();
        throw new Error('The W5 commit locks have finished');
      }
      if (!scope.leases.has(lock.path)) {
        scope.leases.set(lock.path, lease);
        scope.acquired.push(lease);
      }
    }
    const owned = new Map<string, Lease>(inherited);
    owned.set(lock.path, lease);
    const previous = scope.tasks.get(lock.path) ?? Promise.resolve();
    const run = previous.then(() => {
      if (!scope.active) throw new Error('The W5 commit locks have finished');
      return taskContext.run(owned, work);
    });
    scope.tasks.set(
      lock.path,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
  const reserved = reservationContext.getStore()?.get(lock.path);
  if (reserved?.active && !inherited.get(lock.path)?.active) {
    const owned = new Map<string, Lease>(inherited);
    owned.set(lock.path, reserved);
    const run = reserved.taskTail.then(() => {
      if (!reserved.active)
        throw new Error('The W5 repository reservation has finished');
      return taskContext.run(owned, work);
    });
    reserved.taskTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  const lease = await acquire(lock, options?.readOnly);
  const owned = new Map<string, Lease>(inherited);
  owned.set(lock.path, lease);
  try {
    return await taskContext.run(owned, work);
  } finally {
    lease.release();
  }
}

export async function acquireW5RepositoryLocks(
  locks: readonly W5RepositoryLock[],
): Promise<void> {
  for (const lock of [...locks].sort(compare))
    await withW5RepositoryLock(lock, () => Promise.resolve());
}

/** Unscoped multi-file commands reserve their locks in the same order without changing commit behavior. */
export async function withW5RepositoryLocks<T>(
  locks: readonly W5RepositoryLock[],
  work: () => Promise<T>,
): Promise<T> {
  if (scopeContext.getStore()) {
    await acquireW5RepositoryLocks(locks);
    return work();
  }
  const ordered = [...locks].sort(compare);
  const enter = async (index: number): Promise<T> => {
    const lock = ordered[index];
    if (!lock) return work();
    const inherited = reservationContext.getStore() ?? new Map<string, Lease>();
    if (
      inherited.get(lock.path)?.active ||
      taskContext.getStore()?.get(lock.path)?.active
    )
      return enter(index + 1);
    if (
      Array.from(taskContext.getStore()?.values() ?? []).some(
        (held) => held.active && compare(lock, held.lock) < 0,
      )
    ) {
      throw new Error(
        'W5 commit lock order must be index, manifests, then lists (paths sorted within each kind)',
      );
    }
    const lease = await acquire(lock);
    const owned = new Map<string, Lease>(inherited);
    owned.set(lock.path, lease);
    try {
      return await reservationContext.run(owned, () => enter(index + 1));
    } finally {
      lease.release();
    }
  };
  return enter(0);
}

/**
 * Runs work as if no commit scope held its locks: leases the caller already
 * holds stay held, and new locks are taken and released as outside a scope.
 */
export function outsideW5CommitLocks<T>(work: () => T): T {
  return scopeContext.exit(work);
}

/** A scope retains its leases through decision/application; nested scopes join. */
export async function withW5CommitLocks<T>(
  locks: readonly W5RepositoryLock[],
  work: () => Promise<T>,
): Promise<T> {
  const inherited = taskContext.getStore() ?? new Map<string, Lease>();
  const combined = new Map<string, Lease>(reservationContext.getStore());
  Array.from(inherited).forEach(([path, lease]) => combined.set(path, lease));
  const leases = new Map<string, Lease>(
    Array.from(combined).filter(([, lease]) => lease.active),
  );
  // A scope may inherit a plain reader's lease and then stage a decision.
  for (const lease of leases.values()) {
    if (!lease.writable && !readOnlyContext()) {
      lease.writable = true;
      trackWriter(lease.lock, lease.released);
    }
  }
  const ordered = Array.from(leases.values())
    .map((lease) => lease.lock)
    .sort(compare);
  const scope: LockScope = {
    active: true,
    leases,
    acquired: [],
    pending: new Map(),
    tasks: new Map(),
    last: ordered[ordered.length - 1],
  };
  try {
    return await scopeContext.run(scope, async (): Promise<T> => {
      await acquireW5RepositoryLocks(locks);
      return work();
    });
  } finally {
    scope.active = false;
    for (const lease of scope.acquired.reverse()) lease.release();
  }
}
