import {
  GitHubBrokerAttemptSettledError,
  GitHubBrokerError,
  GitHubBrokerTimeoutError,
} from './errors';

export type GitHubRequestPriority = 'interactive' | 'watcher' | 'background';
export type GitHubRequestOperation = 'read' | 'mutation';

const DEFAULT_RESOURCE = 'core';

interface ScheduledEntry {
  id: number;
  priority: GitHubRequestPriority;
  operation: GitHubRequestOperation;
  resource: string;
  admit?: () => number | null;
  task: (signal: AbortSignal) => Promise<void>;
  reject: (error: unknown) => void;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
  deadlineAt: number;
  externalSignal?: AbortSignal;
  onExternalAbort?: () => void;
  settled: boolean;
}

export interface GitHubScheduleOptions {
  priority: GitHubRequestPriority;
  operation: GitHubRequestOperation;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Quota bucket the request spends; defaults to `core`. */
  resource?: string;
  /**
   * Checked before the request is queued and again right before it starts.
   * Returns when the request may be sent again, or null to send it now.
   */
  admit?: () => number | null;
}

const READ_WINDOW_MS = 1000;
const MAX_READ_STARTS_PER_WINDOW = 8;
const MUTATION_GAP_MS = 1000;
const MAX_INTERACTIVE_STREAK = 5;
const MAX_NON_BACKGROUND_STREAK = 5;

function refusalError(
  retryAt: number,
  resource: string,
  reason: 'paused' | 'reserve',
): GitHubBrokerError {
  return new GitHubBrokerError(
    'rate_limited',
    reason === 'paused'
      ? `GitHub requests are paused until ${new Date(retryAt).toISOString()}.`
      : `GitHub ${resource} quota is reserved for higher-priority requests until ${new Date(retryAt).toISOString()}.`,
    { retriable: true, retryAt, resource },
  );
}

/**
 * Serial GitHub request scheduler. Interactive requests wait out a pause;
 * watcher and background requests are refused while their bucket is paused or
 * below its reserve, so they never reach GitHub and their callers learn when
 * to come back.
 */
export class GitHubRequestScheduler {
  private queues: Record<GitHubRequestPriority, ScheduledEntry[]> = {
    interactive: [],
    watcher: [],
    background: [],
  };
  private nextId = 1;
  private running: ScheduledEntry | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private globalPauseUntil = 0;
  private resourcePauseUntil = new Map<string, number>();
  private readStarts: number[] = [];
  private lastMutationStart = 0;
  private interactiveStreak = 0;
  private nonBackgroundStreak = 0;
  private stopped = false;

  schedule<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options: GitHubScheduleOptions,
  ): Promise<T> {
    if (this.stopped) {
      return Promise.reject(
        new GitHubBrokerError('shutdown', 'GitHub broker is shut down.'),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new GitHubBrokerError('cancelled', 'GitHub request was cancelled.'),
      );
    }
    const resource = options.resource ?? DEFAULT_RESOURCE;
    const now = Date.now();
    const refusal = this.refusal(
      { priority: options.priority, resource, admit: options.admit },
      now,
    );
    if (refusal) return Promise.reject(refusal);

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const entry: ScheduledEntry = {
        id: this.nextId++,
        priority: options.priority,
        operation: options.operation,
        resource,
        ...(options.admit ? { admit: options.admit } : {}),
        task: async (signal): Promise<void> => {
          resolve(await task(signal));
        },
        reject,
        controller,
        timeout: setTimeout(() => undefined, 0),
        deadlineAt:
          now +
          Math.max(1, options.timeoutMs) +
          Math.max(0, this.pauseEndFor(resource) - now),
        externalSignal: options.signal,
        settled: false,
      };
      clearTimeout(entry.timeout);
      this.armEntryTimeout(entry);

      if (options.signal) {
        entry.onExternalAbort = (): void => {
          this.cancelEntry(
            entry,
            new GitHubBrokerError('cancelled', 'GitHub request was cancelled.'),
          );
        };
        options.signal.addEventListener('abort', entry.onExternalAbort, {
          once: true,
        });
      }

      this.queues[entry.priority].push(entry);
      this.drain();
    });
  }

  /**
   * Pause starts until `timestampMs`: one bucket when `resource` is given (a
   * primary limit), every bucket otherwise (secondary throttling).
   */
  pauseUntil(timestampMs: number, resource?: string): void {
    if (this.stopped || !Number.isFinite(timestampMs)) return;
    const now = Date.now();
    const queued = Object.values(this.queues).flat();
    const before = new Map(
      queued.map((entry) => [entry.id, this.effectivePauseEnd(entry, now)]),
    );
    if (resource === undefined) {
      this.globalPauseUntil = Math.max(this.globalPauseUntil, timestampMs);
    } else {
      this.resourcePauseUntil.set(
        resource,
        Math.max(this.resourcePauseUntil.get(resource) ?? 0, timestampMs),
      );
    }
    for (const entry of queued) {
      const extensionMs =
        this.effectivePauseEnd(entry, now) - (before.get(entry.id) ?? now);
      if (extensionMs <= 0) continue;
      if (entry.priority !== 'interactive') {
        this.removeEntry(entry);
        this.settleEntry(
          entry,
          refusalError(
            this.pauseEndFor(entry.resource),
            entry.resource,
            'paused',
          ),
        );
        continue;
      }
      entry.deadlineAt += extensionMs;
      this.armEntryTimeout(entry);
    }
    this.drain();
  }

  /** When starts for `resource` may resume; 0 when it is not paused. */
  getPauseUntil(resource: string = DEFAULT_RESOURCE): number {
    return this.pauseEndFor(resource);
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    const error = new GitHubBrokerError(
      'shutdown',
      'GitHub broker is shut down.',
    );
    for (const queue of Object.values(this.queues)) {
      for (const entry of queue.splice(0)) {
        this.settleEntry(entry, error);
      }
    }
    if (this.running) {
      this.running.controller.abort(error);
      this.settleEntry(this.running, error);
      this.running = null;
    }
  }

  private pauseEndFor(resource: string): number {
    return Math.max(
      this.globalPauseUntil,
      this.resourcePauseUntil.get(resource) ?? 0,
    );
  }

  private effectivePauseEnd(entry: ScheduledEntry, now: number): number {
    return Math.max(now, this.pauseEndFor(entry.resource));
  }

  private refusal(
    entry: Pick<ScheduledEntry, 'priority' | 'resource' | 'admit'>,
    now: number,
  ): GitHubBrokerError | null {
    const pauseEnd = this.pauseEndFor(entry.resource);
    if (pauseEnd > now) {
      return entry.priority === 'interactive'
        ? null
        : refusalError(pauseEnd, entry.resource, 'paused');
    }
    const retryAt = entry.admit?.() ?? null;
    return retryAt === null
      ? null
      : refusalError(Math.max(retryAt, now), entry.resource, 'reserve');
  }

  private cancelEntry(entry: ScheduledEntry, error: GitHubBrokerError): void {
    if (entry.settled) return;
    this.removeEntry(entry);
    if (this.running?.id === entry.id) {
      entry.controller.abort(error);
    }
    this.settleEntry(entry, error);
    this.drain();
  }

  private drain(): void {
    if (this.stopped || this.running) return;
    const now = Date.now();
    const candidate = this.peekNext(now);
    if (!candidate) {
      const pausedUntil = this.earliestResourcePauseEnd(now);
      if (pausedUntil !== null) this.armWake(pausedUntil);
      return;
    }

    const earliest = this.earliestStart(candidate, now);
    if (earliest > now) {
      this.armWake(earliest);
      return;
    }

    this.removeEntry(candidate);
    if (candidate.settled) {
      this.drain();
      return;
    }
    const refusal = this.refusal(candidate, now);
    if (refusal) {
      this.settleEntry(candidate, refusal);
      this.drain();
      return;
    }
    this.running = candidate;
    const startedAt = Date.now();
    if (candidate.operation === 'read') {
      this.readStarts = this.readStarts.filter(
        (timestamp) => startedAt - timestamp < READ_WINDOW_MS,
      );
      this.readStarts.push(startedAt);
    } else {
      this.lastMutationStart = startedAt;
    }
    if (candidate.priority === 'background') {
      this.interactiveStreak = 0;
      this.nonBackgroundStreak = 0;
    } else {
      this.interactiveStreak =
        candidate.priority === 'interactive' ? this.interactiveStreak + 1 : 0;
      this.nonBackgroundStreak += 1;
    }

    void candidate
      .task(candidate.controller.signal)
      .then(
        () => this.settleEntry(candidate),
        (error) => this.settleEntry(candidate, error),
      )
      .finally(() => {
        if (this.running?.id === candidate.id) {
          this.running = null;
        }
        this.drain();
      });
  }

  /** First entry of a queue whose own bucket is not paused. */
  private headOf(
    queue: readonly ScheduledEntry[],
    now: number,
  ): ScheduledEntry | undefined {
    return queue.find(
      (entry) => (this.resourcePauseUntil.get(entry.resource) ?? 0) <= now,
    );
  }

  private earliestResourcePauseEnd(now: number): number | null {
    let earliest: number | null = null;
    for (const entry of Object.values(this.queues).flat()) {
      const pauseEnd = this.effectivePauseEnd(entry, now);
      if (earliest === null || pauseEnd < earliest) earliest = pauseEnd;
    }
    return earliest;
  }

  private peekNext(now: number): ScheduledEntry | null {
    const interactive = this.headOf(this.queues.interactive, now);
    const watcher = this.headOf(this.queues.watcher, now);
    const background = this.headOf(this.queues.background, now);
    if (this.interactiveStreak >= MAX_INTERACTIVE_STREAK) {
      const oldestDueLowerPriority = [watcher, background]
        .filter(
          (entry): entry is ScheduledEntry =>
            entry !== undefined && this.earliestStart(entry, now) <= now,
        )
        .sort((left, right) => left.id - right.id)[0];
      if (oldestDueLowerPriority) return oldestDueLowerPriority;
    }
    if (
      this.nonBackgroundStreak >= MAX_NON_BACKGROUND_STREAK &&
      background !== undefined &&
      this.earliestStart(background, now) <= now
    ) {
      return background;
    }
    return interactive ?? watcher ?? background ?? null;
  }

  private removeEntry(entry: ScheduledEntry): void {
    const queue = this.queues[entry.priority];
    const index = queue.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) queue.splice(index, 1);
  }

  private armEntryTimeout(entry: ScheduledEntry): void {
    clearTimeout(entry.timeout);
    entry.timeout = setTimeout(
      () => {
        this.cancelEntry(entry, new GitHubBrokerTimeoutError());
      },
      Math.max(1, entry.deadlineAt - Date.now()),
    );
    entry.timeout.unref?.();
  }

  private earliestStart(entry: ScheduledEntry, now: number): number {
    let earliest = this.effectivePauseEnd(entry, now);
    if (entry.operation === 'mutation' && this.lastMutationStart > 0) {
      earliest = Math.max(earliest, this.lastMutationStart + MUTATION_GAP_MS);
    }
    if (entry.operation === 'read') {
      this.readStarts = this.readStarts.filter(
        (timestamp) => now - timestamp < READ_WINDOW_MS,
      );
      if (this.readStarts.length >= MAX_READ_STARTS_PER_WINDOW) {
        earliest = Math.max(earliest, this.readStarts[0] + READ_WINDOW_MS);
      }
    }
    return earliest;
  }

  private armWake(timestampMs: number): void {
    if (this.stopped) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.drain();
      },
      Math.max(0, timestampMs - Date.now()),
    );
    this.wakeTimer.unref?.();
  }

  private settleEntry(entry: ScheduledEntry, error?: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timeout);
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(new GitHubBrokerAttemptSettledError());
    }
    if (entry.externalSignal && entry.onExternalAbort) {
      entry.externalSignal.removeEventListener('abort', entry.onExternalAbort);
    }
    if (error !== undefined) entry.reject(error);
  }
}
