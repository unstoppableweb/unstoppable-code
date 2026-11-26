import type { CloudCredentialReadCache } from './credential-port';

export const CLOUD_ACCOUNT_CACHE_TTL_MS = 5_000;
export const CLOUD_ACCOUNT_OPERATION_QUEUE_TIMEOUT_MS = 30_000;

export class CloudAccountOperationQueueTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for another account operation to finish.');
    this.name = 'AccountOperationQueueTimeoutError';
  }
}

type Release = () => void;

interface Waiter {
  resolve: (release: Release) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Serializes account operations. A waiter that cannot start within the
 * timeout rejects; a release hands the queue straight to the next waiter.
 */
export class CloudAccountOperationQueue {
  readonly #timeoutMs: number;
  #locked = false;
  readonly #waiters: Waiter[] = [];

  constructor(timeoutMs = CLOUD_ACCOUNT_OPERATION_QUEUE_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.#acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #release(): Release {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (!next) {
        this.#locked = false;
        return;
      }
      clearTimeout(next.timer);
      next.resolve(this.#release());
    };
  }

  #acquire(): Promise<Release> {
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve(this.#release());
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index < 0) return;
          this.#waiters.splice(index, 1);
          reject(new CloudAccountOperationQueueTimeoutError());
        }, this.#timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }
}

/**
 * The last good read, kept for a short TTL and only for the storage backend
 * it was read under. Every value in or out is a clone.
 */
export class CloudAccountReadCache<
  TRecord,
> implements CloudCredentialReadCache<TRecord> {
  readonly #clone: (record: TRecord) => TRecord;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #entry: TRecord | null | undefined;
  #at = 0;
  #backend: string | undefined;

  constructor(
    clone: (record: TRecord) => TRecord,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.#clone = clone;
    this.#ttlMs = options.ttlMs ?? CLOUD_ACCOUNT_CACHE_TTL_MS;
    this.#now = options.now ?? ((): number => Date.now());
  }

  #copy(record: TRecord | null): TRecord | null {
    return record === null ? null : this.#clone(record);
  }

  get(backendKey: string): TRecord | null | undefined {
    if (
      this.#entry === undefined ||
      this.#now() - this.#at >= this.#ttlMs ||
      this.#backend !== backendKey
    )
      return undefined;
    return this.#copy(this.#entry);
  }

  set(record: TRecord | null, backendKey: string): void {
    this.#entry = this.#copy(record);
    this.#at = this.#now();
    this.#backend = backendKey;
  }

  /** The held snapshot without IO or TTL; `null` when nothing is held. */
  peek(): TRecord | null {
    return this.#entry === undefined ? null : this.#copy(this.#entry);
  }

  /** The held snapshot as-is for a read-only projection; never mutate it. */
  peekHeld(): TRecord | null | undefined {
    return this.#entry;
  }

  invalidate(): void {
    this.#entry = undefined;
    this.#at = 0;
    this.#backend = undefined;
  }
}

/**
 * Account change and confirmation subscribers. A subscriber failure never
 * fails the write that notified it, except through {@link notifyOrThrow}.
 */
export class CloudAccountPublisher<TRecord> {
  readonly #clone: (record: TRecord) => TRecord;
  readonly #changes = new Set<(record: TRecord | null) => void>();
  readonly #confirmations = new Set<() => void>();

  constructor(clone: (record: TRecord) => TRecord) {
    this.#clone = clone;
  }

  #copy(record: TRecord | null): TRecord | null {
    return record === null ? null : this.#clone(record);
  }

  addChangeListener(listener: (record: TRecord | null) => void): () => void {
    this.#changes.add(listener);
    return (): void => {
      this.#changes.delete(listener);
    };
  }

  addConfirmationListener(listener: () => void): () => void {
    this.#confirmations.add(listener);
    return (): void => {
      this.#confirmations.delete(listener);
    };
  }

  notify(record: TRecord | null): void {
    this.#changes.forEach((listener) => {
      try {
        listener(this.#copy(record));
      } catch {
        // Account persistence must never fail because a subscriber failed.
      }
    });
  }

  notifyOrThrow(record: TRecord | null): void {
    let firstError: unknown;
    this.#changes.forEach((listener) => {
      try {
        listener(this.#copy(record));
      } catch (error) {
        firstError ??= error;
      }
    });
    if (firstError) {
      throw firstError instanceof Error
        ? firstError
        : new Error('Cloud account change subscriber failed');
    }
  }

  notifyConfirmation(): void {
    this.#confirmations.forEach((listener) => {
      try {
        listener();
      } catch {
        // Account persistence must never fail because a subscriber failed.
      }
    });
  }
}

/** Process-local probe fence; neither the token nor the credential crosses IPC. */
export interface CloudAccountSessionProbe {
  readonly generation: number;
  readonly sequence: number;
}

/**
 * Tracks the credential generation, the latest probe result and a rejected
 * credential. `identify` returns the comparable credential for a record that
 * can be probed, or `null` for one that cannot (no key, or a guest).
 */
export class CloudAccountSessionStatus<TRecord, TCredential> {
  readonly #identify: (record: TRecord) => TCredential | null;
  readonly #same: (left: TCredential, right: TCredential) => boolean;
  #generation = 0;
  #sequence = 0;
  #lastResult = 0;
  #rejected: TCredential | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(
    identify: (record: TRecord) => TCredential | null,
    same: (left: TCredential, right: TCredential) => boolean,
  ) {
    this.#identify = identify;
    this.#same = same;
  }

  #matches(record: TRecord | null): boolean {
    if (this.#rejected === null || record === null) return false;
    const credential = this.#identify(record);
    return credential !== null && this.#same(this.#rejected, credential);
  }

  #notify(): void {
    this.#listeners.forEach((listener): void => {
      try {
        listener();
      } catch {
        // A window or subscriber failure must not fail a credential write.
      }
    });
  }

  begin(): CloudAccountSessionProbe {
    return { generation: this.#generation, sequence: ++this.#sequence };
  }

  isCurrent(probe: CloudAccountSessionProbe): boolean {
    return (
      probe.generation === this.#generation && probe.sequence > this.#lastResult
    );
  }

  isSuperseded(probe: CloudAccountSessionProbe): boolean {
    return (
      probe.generation !== this.#generation || probe.sequence < this.#lastResult
    );
  }

  /** Called only inside the account operation queue. */
  record(
    probe: CloudAccountSessionProbe,
    record: TRecord,
    outcome: 'accepted' | 'rejected',
  ): void {
    const credential = this.#identify(record);
    if (!this.isCurrent(probe) || credential === null) return;
    this.#lastResult = probe.sequence;
    const wasExpired = this.#matches(record);
    if (outcome === 'rejected') {
      this.#rejected = credential;
    } else if (wasExpired) {
      this.#rejected = null;
    }
    if (wasExpired !== this.#matches(record)) this.#notify();
  }

  /**
   * Orders an outcome that neither accepts nor rejects the credential (403,
   * an unidentifiable snapshot): older probes are superseded, newer ones stay
   * current. Called only inside the account operation queue.
   */
  observe(probe: CloudAccountSessionProbe): void {
    if (this.isCurrent(probe)) this.#lastResult = probe.sequence;
  }

  /** After readable credential state changes, including same-key replacement. */
  resetCredential(): void {
    this.#generation++;
    const changed = this.#rejected !== null;
    this.#rejected = null;
    if (changed) this.#notify();
  }

  /** An uncertain write retires probes, not a known credential rejection. */
  invalidateProbes(): void {
    this.#generation++;
  }

  isExpired(record: TRecord | null): boolean {
    return this.#matches(record);
  }

  addListener(listener: () => void): () => void {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  }
}
