import { AsyncResource } from 'node:async_hooks';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type {
  W5CommitLogFileStore,
  W5StoreDecision,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  createW5CommittedReadCache,
  type W5CommittedReadCache,
  type W5ReadCacheInvalidation,
} from '@canopy/core-runtime/node/w5/committed-read-cache';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isDesktopW5TestStoreInstalled } from '../lib/w5-commit-log-file-store';
import { isW5DaemonFlipCompiled } from '../lib/w5-flip-gate';
import { getElectronDaemonHealth } from './electron-daemon-health';

/*
 * TRANSITIONAL (CAN-7155, W5 readers S-9): Electron main's per-workspace read
 * cache, a compatibility path in this process only; W10's core read model
 * (CAN-7153) replaces it. Selected on flip builds outside Windows, it is fed
 * by the daemon-backed store's own decisions, each W5e plan before its
 * handlers, and broad refills, and warmed once the startup handoff is ready.
 * No reader consults it until CAN-7155 PRs 3-4 switch them.
 */

/** An owed refill's first retry delay, doubling to the ceiling. */
export const W5_READ_CACHE_RETRY_FIRST_MS = 1_000;
const RETRY_CEILING_MS = 60_000;
/**
 * Own decisions' trailing refill: each decision pushes it back, until the
 * first has waited 8 delays, so a burst of commits shares one capture.
 */
export const W5_READ_CACHE_OWN_REFILL_MS = 250;
const OWN_REFILL_MAX_DELAYS = 8;

/** Runs `run` after `ms`; returns its cancel. `run` never rejects. */
export type W5ReadCacheSchedule = (
  run: () => Promise<void>,
  ms: number,
) => () => void;

/** Production timers: unref'd, so a pending refill never holds the process. */
function unrefTimer(run: () => Promise<void>, ms: number): () => void {
  const timer = setTimeout(() => {
    void run();
  }, ms);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
}

export interface DesktopW5ReadCache {
  readonly cache: W5CommittedReadCache;
  /** The daemon-backed store's `onApplied` binding. */
  noteOwnDecision(root: string, decision: W5StoreDecision): void;
  /** The handoff is ready: captures go through `store`; resolves once warmed or owed. */
  activate(store: W5CommitLogFileStore): Promise<void>;
  /** The W5e step; rejects when its capture failed, so the bridge retries. */
  apply(plan: W5ReadCacheInvalidation): Promise<void>;
  /**
   * Readers may consult it: active, warmed (a failed broad refill unwarms it),
   * usable, and no test store installed. Per file, not whole-cache: a failed
   * targeted capture or a file over the capture limits leaves only that file
   * dirty and this true, so a reader also takes today's path for any file
   * whose `image()` is undefined.
   */
  ready(): boolean;
  dispose(): void;
}

export interface DesktopW5ReadCacheOptions {
  /** The daemon still serves this app; production reads the health latch. */
  readonly usable: () => boolean;
  readonly retryFirstMs?: number;
  readonly ownRefillMs?: number;
  /** Goldens fire timers by hand; production uses unref'd timers. */
  readonly schedule?: W5ReadCacheSchedule;
  /** Milliseconds for the own refill's push-back ceiling; production reads `performance`. */
  readonly now?: () => number;
}

export function createDesktopW5ReadCache(
  options: DesktopW5ReadCacheOptions,
): DesktopW5ReadCache {
  const retryFirst = options.retryFirstMs ?? W5_READ_CACHE_RETRY_FIRST_MS;
  const ownRefillMs = options.ownRefillMs ?? W5_READ_CACHE_OWN_REFILL_MS;
  const schedule = options.schedule ?? unrefTimer;
  const clock = options.now ?? ((): number => performance.now());
  let store: W5CommitLogFileStore | undefined;
  let disposed = false;
  let cancelRetry: (() => void) | undefined;
  let delay = retryFirst;
  let cancelOwn: (() => void) | undefined;
  let ownSince = 0;
  // Plans skipped while the daemon could not serve, and how many of them a
  // broad refill that applied since covers: only such a refill brings the
  // cache back.
  let skipped = 0;
  let covered = 0;
  const missed = (): boolean => skipped > covered;
  const detached = new AsyncResource('W5ReadCacheRefill');
  const cache = createW5CommittedReadCache({
    capture: async (request) => {
      if (!store?.capture) throw new Error('The W5 read cache is not active.');
      return (await store.capture(request)).capture;
    },
  });
  const active = (): boolean =>
    store !== undefined && !disposed && options.usable();
  const broad = async (): Promise<void> => {
    const through = skipped;
    await cache.refillBroad();
    covered = Math.max(covered, through);
  };

  /** Retries what is still owed with backoff; a latched daemon waits for W5e. */
  const settle = (): void => {
    if (!active()) return;
    if (!missed() && !cache.owed()) {
      delay = retryFirst;
      return;
    }
    if (cancelRetry !== undefined) return;
    cancelRetry = schedule(() => {
      cancelRetry = undefined;
      return refill();
    }, delay);
    delay = Math.min(delay * 2, RETRY_CEILING_MS);
  };
  /** Never rejects. */
  const refill = (): Promise<void> => {
    if (!active()) return Promise.resolve();
    const run = missed() || !cache.warmed() ? broad() : cache.refillMarked();
    return run
      .catch((error: unknown) => {
        logMainProcessWarn('[w5-read-cache] refill failed', { error });
      })
      .finally(settle);
  };
  const ownRefill = detached.bind((): Promise<void> => {
    cancelOwn = undefined;
    return refill();
  });
  /** One trailing refill for a burst of own decisions. */
  const scheduleOwnRefill = (): void => {
    const now = clock();
    if (cancelOwn === undefined) ownSince = now;
    else if (now - ownSince >= ownRefillMs * OWN_REFILL_MAX_DELAYS) return;
    else cancelOwn();
    // Outside the writer's async context: its commit scope, lock leases
    // and work-counter caller never reach the cache's capture.
    cancelOwn = detached.runInAsyncScope(() =>
      schedule(ownRefill, ownRefillMs),
    );
  };

  return {
    cache,
    noteOwnDecision(root, decision): void {
      cache.noteOwnDecision(root, decision);
      // Before the warm, its trailing plan and `settle` cover the decision.
      if (store && !disposed && cache.warmed()) scheduleOwnRefill();
    },
    activate(next): Promise<void> {
      if (disposed || store) return Promise.resolve();
      store = next;
      return refill();
    },
    async apply(plan): Promise<void> {
      if (!store || disposed) return;
      if (!options.usable()) {
        skipped += 1;
        return;
      }
      try {
        await (missed() || plan.broad ? broad() : cache.apply(plan));
      } finally {
        settle();
      }
    },
    ready: () =>
      active() &&
      !missed() &&
      cache.warmed() &&
      !isDesktopW5TestStoreInstalled(),
    dispose(): void {
      disposed = true;
      cancelRetry?.();
      cancelRetry = undefined;
      cancelOwn?.();
      cancelOwn = undefined;
    },
  };
}

/** Flip builds outside Windows; elsewhere every reader keeps today's path. */
export function isDesktopW5ReadCacheSelected(): boolean {
  return hostPlatformOperatingSystem() !== 'win32' && isW5DaemonFlipCompiled();
}

let instance: DesktopW5ReadCache | undefined;

/** The process's cache; created on first use, never captures until activated. */
export function getDesktopW5ReadCache(): DesktopW5ReadCache {
  instance ??= createDesktopW5ReadCache({
    usable: () => !getElectronDaemonHealth().isLatched(),
  });
  return instance;
}

/** The W5e step for main's binding; a no-op until the cache is activated. */
export function applyDesktopW5ReadCachePlan(
  plan: W5ReadCacheInvalidation,
): Promise<void> {
  return instance?.apply(plan) ?? Promise.resolve();
}

/** Quit: stops retries; never creates the cache. */
export function disposeDesktopW5ReadCache(): void {
  instance?.dispose();
}
