/**
 * What one write may change while it runs: the files it or a pending commit
 * it finishes writes, and the resources whose revision it advances. `any`
 * when that is not known up front.
 */
export interface W5WriteScope {
  readonly files: ReadonlySet<string> | 'any';
  readonly advances: ReadonlySet<string> | 'any';
}

/** A read waited longer than its bound for writes to settle (CAN-5589). */
export class W5ReadLaneOverloadedError extends Error {
  constructor() {
    super('The W5 commit log read waited too long for writes to settle');
    this.name = 'W5ReadLaneOverloadedError';
  }
}

/** What the writes that overlapped one read could change. */
export interface W5WriteOverlap {
  /** Whether a write that ran during the read could change one of `files`. */
  touched(files: Iterable<string>): boolean;
  /** Whether a write that ran during the read could advance one of `resources`. */
  advanced(resources: Iterable<string>): boolean;
}

interface Observer {
  readonly files: Set<string>;
  readonly advances: Set<string>;
  anyFile: boolean;
  anyAdvance: boolean;
}

const noop = (): void => undefined;

/**
 * The commit log worker's lanes (CAN-5589). Writes run one at a time in the
 * order they arrive, as every call did before, so the log keeps one writer
 * and commits never interleave. Reads run beside them: every SQLite
 * transaction completes within one turn, so a read sees only committed
 * state, and `observe` tells a read which files the writes it overlapped
 * could have changed. An exclusive call waits for the reads in flight and
 * holds new ones until it ends.
 */
export class W5CommitLogLanes {
  private tail: Promise<void> = Promise.resolve();
  private active: W5WriteScope | undefined;
  private readonly observers = new Set<Observer>();
  private readonly writeIdleWaiters: Array<() => void> = [];
  private reads = 0;
  private readonly drainWaiters: Array<() => void> = [];
  private held: Promise<void> | undefined;

  /** Runs `work` after every write before it, as the only write running. */
  write<T>(scope: () => W5WriteScope, work: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const current = scope();
      this.active = current;
      for (const observer of this.observers) record(observer, current);
      try {
        return await work();
      } finally {
        this.active = undefined;
        for (const resolve of this.writeIdleWaiters.splice(0)) resolve();
      }
    });
  }

  /** A write that also runs with no read in flight. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.write(
      () => ({ files: 'any', advances: 'any' }),
      async () => {
        let release = noop;
        this.held = new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          await this.drained();
          return await work();
        } finally {
          this.held = undefined;
          release();
        }
      },
    );
  }

  /** Runs a read beside the writes, once no exclusive call holds reads. */
  async read<T>(work: () => Promise<T>): Promise<T> {
    while (this.held) await this.held;
    this.reads += 1;
    try {
      return await work();
    } finally {
      this.reads -= 1;
      if (this.reads === 0)
        for (const resolve of this.drainWaiters.splice(0)) resolve();
    }
  }

  /** Runs `work`, reporting what the writes that overlapped it could change. */
  async observe<T>(work: (overlap: W5WriteOverlap) => Promise<T>): Promise<T> {
    const observer: Observer = {
      files: new Set(),
      advances: new Set(),
      anyFile: false,
      anyAdvance: false,
    };
    if (this.active) record(observer, this.active);
    this.observers.add(observer);
    try {
      return await work({
        touched: (files): boolean =>
          observer.anyFile || some(files, (file) => observer.files.has(file)),
        advanced: (resources): boolean =>
          observer.anyAdvance ||
          some(resources, (resource) => observer.advances.has(resource)),
      });
    } finally {
      this.observers.delete(observer);
    }
  }

  /**
   * Runs `work` with no write running, as every read did before: in the
   * writes' order, once those ahead of it finish. Refuses as overloaded if
   * its turn does not come within `waitMs`.
   */
  whileWritesIdle<T>(work: () => Promise<T>, waitMs: number): Promise<T> {
    let state: 'waiting' | 'started' | 'abandoned' = 'waiting';
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<T>((resolve, reject) => {
      timer = setTimeout((): void => {
        if (state !== 'waiting') return;
        state = 'abandoned';
        reject(new W5ReadLaneOverloadedError());
      }, waitMs);
      this.enqueue(async (): Promise<void> => {
        if (state === 'abandoned') return;
        state = 'started';
        clearTimeout(timer);
        await work().then(resolve, reject);
      }).catch(noop);
    });
  }

  /**
   * Resolves once no running write advances `resource`, so a read of it
   * never sees a revision whose files are not written yet. Refuses as
   * overloaded after `waitMs`.
   */
  async settled(resource: string, waitMs: number): Promise<void> {
    const deadline = performance.now() + waitMs;
    while (this.active && advances(this.active, resource)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new W5ReadLaneOverloadedError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<void>((resolve) => {
        this.writeIdleWaiters.push(resolve);
      });
      await Promise.race([
        idle,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
        }),
      ]).finally(() => clearTimeout(timer));
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.then(noop, noop);
    return run;
  }

  private drained(): Promise<void> {
    if (this.reads === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }
}

function record(observer: Observer, scope: W5WriteScope): void {
  if (scope.files === 'any') observer.anyFile = true;
  else for (const file of scope.files) observer.files.add(file);
  if (scope.advances === 'any') observer.anyAdvance = true;
  else for (const resource of scope.advances) observer.advances.add(resource);
}

function some<T>(values: Iterable<T>, test: (value: T) => boolean): boolean {
  for (const value of values) if (test(value)) return true;
  return false;
}

function advances(scope: W5WriteScope, resource: string): boolean {
  return scope.advances === 'any' || scope.advances.has(resource);
}
