import { AsyncLocalStorage } from 'node:async_hooks';
import {
  assertStorageWriteAllowed,
  STORAGE_OWNERSHIP,
  type GuardedStorageNamespace,
  type StorageWriterPrincipal,
} from '@canopy/core-runtime/storage';

export interface StorageAdmissionTarget {
  namespace: GuardedStorageNamespace;
  writer: StorageWriterPrincipal;
}

/** A checked write or nested admission that its operation did not admit. */
export class StorageAdmissionError extends Error {
  public constructor(targets: readonly StorageAdmissionTarget[]) {
    const names = targets.map((t) => `${t.namespace} by ${t.writer}`);
    super(`Storage write not admitted at operation entry: ${names.join(', ')}`);
    this.name = 'StorageAdmissionError';
  }
}

interface AdmissionScope {
  readonly targets: readonly StorageAdmissionTarget[];
  readonly keys: ReadonlySet<string>;
  readonly parent: AdmissionScope | undefined;
  active: boolean;
}

// Process-local only: Phase 1 has one writer process per data directory, so
// cross-process admission is out of scope until a daemon owns a namespace.
const scopes = new AsyncLocalStorage<AdmissionScope>();
const holds = new Map<GuardedStorageNamespace, number>();
const changing = new Set<GuardedStorageNamespace>();
let wakeWaiters: Array<() => void> = [];
/** Invocation-owned routing; revocation also fences inherited async work. */
export interface StorageAuthorityAdmission {
  run<T>(operation: () => Promise<T>): Promise<T>;
  close(): void;
}

interface AuthorityScope {
  readonly namespaces: ReadonlySet<GuardedStorageNamespace>;
  readonly releaseAdmissions: Set<() => void>;
  active: boolean;
}
const authorities = new AsyncLocalStorage<AuthorityScope>();

export function createStorageAuthorityAdmission(
  namespaces: readonly GuardedStorageNamespace[],
): StorageAuthorityAdmission {
  const scope: AuthorityScope = {
    namespaces: new Set(namespaces),
    releaseAdmissions: new Set(),
    active: true,
  };
  return {
    run: (operation) => {
      if (!scope.active)
        return Promise.reject(new Error('Authority admission retired'));
      return authorities.run(scope, operation);
    },
    close: () => {
      scope.active = false;
      for (const release of scope.releaseAdmissions) release();
    },
  };
}

/** One callback's staging permission, never a process-global writer waiver. */
export async function withStorageAuthorityAdmission<T>(
  namespaces: readonly GuardedStorageNamespace[],
  operation: () => Promise<T>,
): Promise<T> {
  const inherited = authorities.getStore();
  if (
    inherited &&
    namespaces.every((namespace) => inherited.namespaces.has(namespace))
  ) {
    if (!inherited.active) throw new Error('Authority admission retired');
    return operation();
  }
  const admission = createStorageAuthorityAdmission(namespaces);
  try {
    return await admission.run(operation);
  } finally {
    admission.close();
  }
}

function authorityRouted(namespace: GuardedStorageNamespace): boolean {
  const scope = authorities.getStore();
  if (!scope?.namespaces.has(namespace)) return false;
  if (!scope.active) throw new Error('Authority admission retired');
  return true;
}

const keyOf = (target: StorageAdmissionTarget): string =>
  `${target.writer}:${target.namespace}`;

// A scope admits only while it holds: background work started inside an
// operation outlives that operation's admission.
function covers(key: string): boolean {
  for (let scope = scopes.getStore(); scope; scope = scope.parent) {
    if (scope.active && scope.keys.has(key)) return true;
  }
  return false;
}

function inAdmittedOperation(): boolean {
  for (let scope = scopes.getStore(); scope; scope = scope.parent) {
    if (scope.active) return true;
  }
  return false;
}

function unadmitted(
  targets: readonly StorageAdmissionTarget[],
): StorageAdmissionTarget[] {
  return targets.filter((target) => !covers(keyOf(target)));
}

/**
 * Tests fail on a missing admission. Production keeps C3a's per-write
 * refusal and admits late, so a missed path never stops a legacy write.
 */
function reportUnadmitted(targets: readonly StorageAdmissionTarget[]): void {
  if (process.env.NODE_ENV === 'test') throw new StorageAdmissionError(targets);
}

function nextRelease(): Promise<void> {
  return new Promise((resolve) => wakeWaiters.push(resolve));
}

function wake(): void {
  const waiters = wakeWaiters;
  wakeWaiters = [];
  for (const resolve of waiters) resolve();
}

/**
 * Runs every checked write; C3a's per-write refusal still runs too. A write
 * its operation did not admit is admitted late, so its namespace is held
 * from the ownership check until the write completes.
 */
export function admitStorageWrite<T>(
  target: StorageAdmissionTarget,
  write: () => Promise<T>,
): Promise<T> {
  authorityRouted(target.namespace);
  const missing = unadmitted([target]);
  if (missing.length === 0) return write();
  reportUnadmitted(missing);
  return withStorageAdmission(missing, write);
}

/**
 * Admits every W5 namespace an operation will write before its first
 * mutation, and holds their ownership stable until it settles: an ownership
 * change waits for the operation. A nested call must stay within the
 * enclosing admission; it takes its own hold, so detached nested work stays
 * admitted after the enclosing operation settles. Starts `operation`
 * synchronously when no ownership change is in progress.
 */
export async function withStorageAdmission<T>(
  targets: readonly StorageAdmissionTarget[],
  operation: () => Promise<T>,
): Promise<T> {
  for (const target of targets) authorityRouted(target.namespace);
  const missing = unadmitted(targets);
  const parent = scopes.getStore();
  if (missing.length > 0 && inAdmittedOperation()) reportUnadmitted(missing);
  // A namespace an enclosing operation holds cannot be mid-change.
  const unheld = new Set(missing.map((target) => target.namespace));
  while (Array.from(unheld).some((namespace) => changing.has(namespace))) {
    await nextRelease();
  }
  // Retirement may have happened while waiting for an ownership change.
  for (const target of targets) authorityRouted(target.namespace);
  const authority = authorities.getStore();
  const namespaces = Array.from(new Set(targets.map((t) => t.namespace)));
  for (const namespace of namespaces) {
    holds.set(namespace, (holds.get(namespace) ?? 0) + 1);
  }
  const scope: AdmissionScope = {
    targets,
    keys: new Set(targets.map(keyOf)),
    parent,
    active: true,
  };
  // Routed callbacks cannot write locally. Once their transport is retired,
  // a stuck Git child must not pin the process-wide ownership-change barrier.
  const release = (): void => {
    if (!scope.active) return;
    scope.active = false;
    authority?.releaseAdmissions.delete(release);
    for (const namespace of namespaces) {
      const remaining = (holds.get(namespace) ?? 1) - 1;
      if (remaining > 0) holds.set(namespace, remaining);
      else holds.delete(namespace);
    }
    wake();
  };
  if (
    authority &&
    namespaces.every((namespace) => authority.namespaces.has(namespace))
  )
    authority.releaseAdmissions.add(release);
  try {
    for (const { namespace, writer } of missing) {
      if (!authorityRouted(namespace))
        assertStorageWriteAllowed(namespace, writer, STORAGE_OWNERSHIP);
    }
    return await scopes.run(scope, operation);
  } finally {
    release();
  }
}

/**
 * Starts `start` synchronously under a nested admission of everything the
 * current operation admits, so work it starts stays held after that operation
 * settles. Outside an admitted operation it only starts `start`.
 */
export function inheritStorageAdmission<T>(
  start: () => PromiseLike<T>,
): Promise<T> {
  const inherited = new Map<string, StorageAdmissionTarget>();
  for (let scope = scopes.getStore(); scope; scope = scope.parent) {
    if (!scope.active) continue;
    for (const target of scope.targets) inherited.set(keyOf(target), target);
  }
  if (inherited.size === 0) return Promise.resolve(start());
  // Every target is held already, so this starts `start` synchronously.
  return withStorageAdmission(Array.from(inherited.values()), () =>
    Promise.resolve(start()),
  );
}

/** Runs `run` outside every admission, so its writes admit themselves. */
export function outsideStorageAdmission<T>(run: () => T): T {
  return authorities.exit(() => scopes.exit(run));
}

/**
 * The only way to change W5 ownership in this process: waits until no
 * admitted operation holds the namespaces, then blocks new admissions until
 * `change` settles. Waiting admissions never block it from starting, so a
 * steady stream of operations can delay it but cannot deadlock it.
 *
 * No writer preference: admissions that arrive while it waits are still
 * admitted. Blocking them would deadlock an operation that takes a lock
 * before admitting (find-or-create's split-destination lock) against an
 * admitted one waiting for that lock. Revisit when the ownership flip
 * lands: a flip that must not wait indefinitely quiesces writers first.
 */
export async function withStorageOwnershipChange<T>(
  namespaces: readonly GuardedStorageNamespace[],
  change: () => T | Promise<T>,
): Promise<T> {
  if (inAdmittedOperation()) {
    throw new Error('An admitted operation cannot change storage ownership');
  }
  while (
    namespaces.some(
      (namespace) => changing.has(namespace) || holds.has(namespace),
    )
  ) {
    await nextRelease();
  }
  for (const namespace of namespaces) changing.add(namespace);
  try {
    return await change();
  } finally {
    for (const namespace of namespaces) changing.delete(namespace);
    wake();
  }
}
