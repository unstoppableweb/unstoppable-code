import { AsyncResource } from 'node:async_hooks';
import { realpath, stat } from 'node:fs/promises';
import {
  isW5CaptureWorkspaceId,
  type W5CaptureFile,
  type W5CaptureRequest,
} from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import type {
  W5CommitLogFileStore,
  W5StoreDecision,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  createW5CommittedReadCache,
  type W5CommittedReadCache,
  type W5ReadCacheInvalidation,
} from '@canopy/core-runtime/node/w5/committed-read-cache';
import { w5ProjectionFileKey } from '@canopy/core-runtime/node/w5/committed-projection';
import { recordW5Work } from '@canopy/desktop-shared/node/work-counters';
import { detachedWorkCallback } from '@canopy/desktop-shared/node/lib/detached-work';
import type { W5CommitRefusedError } from '@canopy/core-runtime/node/w5/commit-log/errors';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getWorkspacesRootDir } from '../lib/paths';
import { isDesktopW5TestStoreInstalled } from '../lib/w5-commit-log-file-store';
import { currentW5CommitScope } from '../lib/w5-commit-scope';
import { isInsideW5ReadView } from '../lib/w5-read-view';
import { hasW5WritableLocksInFlight } from '../lib/w5-repository-locks';
import { getElectronDaemonHealth } from './electron-daemon-health';
import { createW5ReadCacheCoverage } from './w5-read-cache-coverage';
import {
  registerDesktopW5ReadCacheServer,
  type W5ReadCacheServe,
} from './w5-read-cache-server';

export { isDesktopW5ReadCacheSelected } from './w5-cached-workspace-services';

/*
 * TRANSITIONAL (CAN-7155, W5 readers S-9): Electron main's per-workspace read
 * cache, a compatibility path in this process only; W10's core read model
 * (CAN-7153) replaces it. Selected on flip builds outside Windows (CAN-7646),
 * it is fed by the daemon-backed store's own decisions, each W5e plan before its
 * handlers, and broad refills, and warmed once the startup handoff is ready.
 * Seam A (PR 3, serving enabled by CAN-7646): workspace and worktree reads
 * are served from it (`w5-cached-workspace-services.ts`). Seam B (PRs 4a and
 * 4b, CAN-7835): main's direct readers and the Git-read admission check
 * serve through `w5-read-cache-server.ts`.
 */

/** An owed refill's first retry delay, doubling to the ceiling. */
export const W5_READ_CACHE_RETRY_FIRST_MS = 1_000;
/** A served read's misses: one trailing capture of what no refill owes. */
export const W5_READ_CACHE_REFRESH_MS = 250;
const RETRY_CEILING_MS = 60_000;
/**
 * Own decisions and external changes share a trailing refill, pushed back
 * until the first has waited 8 delays, so a burst shares one capture.
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
  /** Lifecycle inputs to the cache-owned serving token. */
  setStreamReady(ready: boolean): void;
  revoke(): void;
  /** Every record-port capture consumer reports typed refusals here. */
  noteCaptureRefused(error: W5CommitRefusedError): void;
  /** The daemon-backed store's `onApplied` binding. */
  noteOwnDecision(root: string, decision: W5StoreDecision): void;
  /** Stops serving external changes synchronously and schedules a targeted refill. */
  markDirty(files: readonly W5CaptureFile[]): void;
  /** The handoff is ready: captures go through `store`; resolves once warmed or owed. */
  activate(store: W5CommitLogFileStore): Promise<void>;
  /** The W5e step; live failures reject for retry, retirement resolves benignly. */
  apply(plan: W5ReadCacheInvalidation): Promise<void>;
  /**
   * The serving token is armed and no test store is installed. Entry freshness
   * inside that token can still leave individual files unserved.
   */
  ready(): boolean;
  /**
   * The capture a query's read view would get, without a capture, or
   * undefined for today's path: not ready, a broad refill running, inside a
   * commit scope or projection-only view, or a file the projection cannot
   * answer yet (whose capture it then schedules when nothing else owes it).
   */
  serve(request: W5CaptureRequest): Promise<W5ReadCacheServe | undefined>;
  dispose(): void;
}

export interface DesktopW5ReadCacheOptions {
  /** The daemon still serves this app; production requires ok, unlatched health. */
  readonly usable: () => boolean;
  /** Health loss revokes synchronously; healthy recovery requests a refill. */
  readonly onUnavailable?: (
    revoke: () => void,
    recover: () => void,
  ) => () => void;
  readonly retryFirstMs?: number;
  readonly ownRefillMs?: number;
  readonly refreshMs?: number;
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
  const refreshMs = options.refreshMs ?? W5_READ_CACHE_REFRESH_MS;
  const schedule = options.schedule ?? unrefTimer;
  const clock = options.now ?? ((): number => performance.now());
  let store: W5CommitLogFileStore | undefined;
  let unsubscribe: (() => void) | undefined;
  let streamLive = false;
  let cancelRetry: (() => void) | undefined;
  let delay = retryFirst;
  let cancelOwn: (() => void) | undefined;
  let coverageRefill: Promise<void> | undefined;
  let ownSince = 0;
  const detached = new AsyncResource('W5ReadCacheRefill');
  // A changed or unavailable root stops every serve: unrelated warm files
  // must not mask a capture's fail-closed root refusal.
  let root: string | undefined;
  let rootIdentity:
    | { readonly realpath: string; readonly dev: bigint; readonly ino: bigint }
    | undefined;
  const coverage = createW5ReadCacheCoverage(
    (files) => {
      if (cache.signal.aborted) return;
      cache.markDirty(files);
      if (store && cache.warmed()) scheduleOwnRefill();
    },
    (reason) => {
      // A rebuild certifies its new membership; losses also fence in-flight refills.
      if (reason === 'loss' || cache.serving()) cache.revoke();
    },
    () => {
      // An existing build captures again after enrollment's fences. Otherwise
      // coverage becoming available is a one-shot re-arm, not an idle timer.
      if (
        streamLive &&
        store &&
        !cache.signal.aborted &&
        !cache.serving() &&
        !cache.rebuilding()
      )
        requestCoverageRefill();
    },
  );
  const reconcileCoverage = (prune = false): void => {
    if (!cache.signal.aborted && root !== undefined)
      coverage.reconcile(
        root,
        cache.projection().image({ kind: 'index' }),
        prune,
      );
  };
  const cache = createW5CommittedReadCache({
    capture: async (request, signal) => {
      signal.throwIfAborted();
      if (!store?.capture) throw new Error('The W5 read cache is not active.');
      // Pin before any file read, including discovery and split captures.
      const captureRoot = root ?? getWorkspacesRootDir();
      try {
        const resolved = await realpath(captureRoot);
        signal.throwIfAborted();
        const { dev, ino } = await stat(captureRoot, { bigint: true });
        signal.throwIfAborted();
        if (
          rootIdentity &&
          (rootIdentity.realpath !== resolved ||
            rootIdentity.dev !== dev ||
            rootIdentity.ino !== ino)
        )
          revokeTerminal();
        else rootIdentity ??= { realpath: resolved, dev, ino };
      } catch {
        revokeTerminal();
      }
      // Root probes yield; retirement must be checked before forwarding.
      signal.throwIfAborted();
      reconcileCoverage();
      const captured = await store.capture(request, signal);
      signal.throwIfAborted();
      if (root === undefined) root = captured.root;
      if (captureRoot !== captured.root) {
        revokeTerminal();
        logMainProcessWarn('[w5-read-cache] data root changed; serving stops');
      }
      // Enroll discovery's entire index, before visibility filtering. Newly
      // enrolled files are fenced; this capture cannot bless pre-watch bytes.
      if (!cache.signal.aborted && root === captured.root)
        coverage.reconcile(
          captured.root,
          captured.capture.files.find((file) => file.kind === 'index'),
          false,
        );
      return captured.capture;
    },
    servingCoverage: async (projection) => {
      reconcileCoverage(true);
      if (cache.signal.aborted || !options.usable() || root === undefined)
        return undefined;
      const files = coverage.certify(projection.files());
      if (files === undefined) return undefined;
      try {
        const resolved = await realpath(root);
        if (cache.signal.aborted) return undefined;
        const { dev, ino } = await stat(root, { bigint: true });
        if (
          !rootIdentity ||
          rootIdentity.realpath !== resolved ||
          rootIdentity.dev !== dev ||
          rootIdentity.ino !== ino
        ) {
          revokeTerminal();
          return undefined;
        }
        return cache.signal.aborted || !options.usable()
          ? undefined
          : coverage.certify(projection.files());
      } catch {
        revokeTerminal();
        return undefined;
      }
    },
  });
  const active = (): boolean =>
    store !== undefined && !cache.signal.aborted && options.usable();

  /** Retries what is still owed with backoff; a latched daemon waits for W5e. */
  const settle = (): void => {
    if (!active()) return;
    reconcileCoverage(true);
    if (!cache.owed()) {
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
    // Known-file refills update an in-flight broad build without waiting on it.
    const run =
      !cache.serving() && !cache.rebuilding()
        ? cache.refillBroad()
        : cache.refillMarked();
    return run
      .catch((error: unknown) => {
        logMainProcessWarn('[w5-read-cache] refill failed', { error });
      })
      .finally(settle);
  };
  const requestCoverageRefill = detachedWorkCallback(() => {
    const pending = detached.runInAsyncScope(refill).finally(() => {
      if (coverageRefill === pending) coverageRefill = undefined;
    });
    coverageRefill = pending;
    return pending;
  });
  const ownRefill = detached.bind((): Promise<void> => {
    cancelOwn = undefined;
    // Enrollment already started the broad re-arm; its older debounce joins it.
    return coverageRefill ?? refill();
  });
  /** One trailing refill for a burst of own decisions or external changes. */
  const scheduleOwnRefill = (): void => {
    if (!active()) return;
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

  const isReady = (): boolean =>
    cache.serving() && !isDesktopW5TestStoreInstalled();

  // Files a serve could not answer that nothing else owes: one trailing
  // capture for a burst of misses, never one per read.
  const refreshing = new Map<string, W5CaptureFile>();
  const refreshInFlight = new Set<string>();
  let cancelRefresh: (() => void) | undefined;
  const runRefresh = detached.bind((): Promise<void> => {
    cancelRefresh = undefined;
    const files = Array.from(refreshing.values());
    refreshing.clear();
    if (!active() || !files.length) return Promise.resolve();
    for (const file of files) refreshInFlight.add(w5ProjectionFileKey(file));
    const workspaceIds = (kind: 'manifest' | 'worktrees'): string[] =>
      files.flatMap((file) =>
        file.kind === kind && 'workspaceId' in file ? [file.workspaceId] : [],
      );
    return cache
      .apply({
        broad: false,
        index: files.some((file) => file.kind === 'index'),
        workspaces: [],
        manifests: workspaceIds('manifest'),
        worktreeLists: workspaceIds('worktrees'),
      })
      .catch((error: unknown) => {
        logMainProcessWarn('[w5-read-cache] refresh failed', { error });
      })
      .finally(() => {
        for (const file of files)
          refreshInFlight.delete(w5ProjectionFileKey(file));
        settle();
      });
  });
  const scheduleRefresh = (files: readonly W5CaptureFile[]): void => {
    if (!active()) return;
    for (const file of files) {
      const key = w5ProjectionFileKey(file);
      if (!refreshInFlight.has(key)) refreshing.set(key, file);
    }
    if (cancelRefresh !== undefined || !refreshing.size) return;
    cancelRefresh = detached.runInAsyncScope(() =>
      schedule(runRefresh, refreshMs),
    );
  };

  const retire = (): void => {
    // Retire only this cache: W5e handlers and fallback reads keep their store.
    cancelRetry?.();
    cancelRetry = undefined;
    cancelOwn?.();
    cancelOwn = undefined;
    cancelRefresh?.();
    cancelRefresh = undefined;
    refreshing.clear();
    unsubscribe?.();
    unsubscribe = undefined;
    coverage.dispose();
  };
  cache.signal.addEventListener('abort', retire, { once: true });
  const revokeTerminal = (): void => cache.revoke(true);

  unsubscribe = options.onUnavailable?.(
    () => cache.revoke(),
    () => {
      // Retry-detail changes can report ok without any loss of serving.
      if (active() && streamLive && !cache.serving()) scheduleOwnRefill();
    },
  );

  return {
    cache,
    setStreamReady(ready): void {
      if (cache.signal.aborted) return;
      streamLive = ready;
      cache.setStreamReady(ready);
    },
    revoke: () => cache.revoke(),
    noteCaptureRefused(error): void {
      if (
        error.reason === 'invalid-state' &&
        (error.details.capture === 'root-unavailable' ||
          error.details.capture === 'root-changed')
      )
        revokeTerminal();
    },
    markDirty(files): void {
      if (cache.signal.aborted || !files.length) return;
      cache.markDirty(files);
      if (store) scheduleOwnRefill();
    },
    noteOwnDecision(root, decision): void {
      if (cache.signal.aborted) return;
      cache.noteOwnDecision(root, decision);
      reconcileCoverage(true);
      // Before the warm, its trailing plan and `settle` cover the decision.
      if (store && !cache.signal.aborted && cache.warmed()) scheduleOwnRefill();
    },
    activate(next): Promise<void> {
      if (cache.signal.aborted || store) return Promise.resolve();
      store = next;
      return refill();
    },
    async apply(plan): Promise<void> {
      if (!store || cache.signal.aborted) return;
      if (!options.usable()) {
        cache.revoke();
        return;
      }
      try {
        await cache.apply(plan);
      } finally {
        settle();
      }
    },
    ready: isReady,
    async serve(request): Promise<W5ReadCacheServe | undefined> {
      // Staged, already-captured and GB4 reads keep their own paths.
      if (currentW5CommitScope() || isInsideW5ReadView()) return undefined;
      if (isDesktopW5TestStoreInstalled()) return undefined;
      // Descendant watches can follow an inode after an unwatched ancestor
      // moves. One stat per serve binds the token to the armed root identity.
      if (cache.serving()) {
        try {
          const identity =
            root === undefined ? undefined : await stat(root, { bigint: true });
          if (
            !identity ||
            !rootIdentity ||
            identity.dev !== rootIdentity.dev ||
            identity.ino !== rootIdentity.ino
          )
            revokeTerminal();
        } catch {
          revokeTerminal();
        }
      }
      reconcileCoverage();
      // A view opens before its reader takes the list lock, so a cached serve
      // would miss an in-process writer whose commit is in flight, which
      // today's capture may be ordered after. Locks taken inside open read
      // views are readers' and never step aside.
      if (hasW5WritableLocksInFlight()) {
        recordW5Work('readView.cacheMiss.writing');
        return undefined;
      }
      // Today's path reads such a query live (`unsupported-id`).
      if (
        !request.files.every(
          (file) =>
            file.kind !== 'index-backup' &&
            (!('workspaceId' in file) ||
              isW5CaptureWorkspaceId(file.workspaceId)),
        )
      )
        return undefined;
      // Consult the sole serving token after the root I/O yields: a loss
      // or broad refill during that wait must not serve the earlier token.
      const result = cache.serve(request);
      if (!result) return undefined;
      if (result.status === 'served') {
        if (root === undefined)
          throw new Error('An armed W5 cache has no root.');
        return { capture: result.capture, root };
      }
      recordW5Work(`readView.cacheMiss.${result.reason}`);
      if (result.refresh.length) scheduleRefresh(result.refresh);
      return undefined;
    },
    dispose(): void {
      revokeTerminal();
    },
  };
}

let instance: DesktopW5ReadCache | undefined;
let streamReady = false;

/** W5e continuity may change before the handoff creates the process cache. */
export function setDesktopW5ReadCacheStreamReady(ready: boolean): void {
  streamReady = ready;
  instance?.setStreamReady(ready);
}

/** Broad W5e invalidation or recovery: never creates a cache just to revoke it. */
export function revokeDesktopW5ReadCache(): void {
  instance?.revoke();
}

/**
 * The process's cache; created on first use, never captures until activated.
 * Creating it makes it the dispatcher reads' server.
 */
export function getDesktopW5ReadCache(): DesktopW5ReadCache {
  if (!instance) {
    instance = createDesktopW5ReadCache({
      usable: () =>
        !getElectronDaemonHealth().isLatched() &&
        getElectronDaemonHealth().getStatus().state === 'ok',
      onUnavailable: (revoke, recover) =>
        getElectronDaemonHealth().onStatusChanged((status) => {
          if (status.state !== 'ok' || getElectronDaemonHealth().isLatched())
            revoke();
          else recover();
        }),
    });
    instance.setStreamReady(streamReady);
    registerDesktopW5ReadCacheServer(instance);
  }
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
