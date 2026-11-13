import { isWorktreeReadAvailable } from '../lib/worktree-read-availability';
import { portalSnapshotWorkBudget } from '../portal/portal-snapshot-work-budget';
import {
  getWorktreeDiffStatsOnly,
  type WorktreeRepoDiffStatsReader,
} from '../lib/worktree-service';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { emitWorktreeDiffStatsDelta } from '../portal/portal-event-bus';
import { mapWithConcurrency } from '../lib/concurrency';
import { getRemoteTrackingCommitSha } from '../lib/git';
import { listSharedContainerLocalRepositories } from '../shared-containers/local-repositories';

export interface CachedWorktreeDiffStats {
  insertions: number;
  deletions: number;
  refreshedAt: number;
  generation: number;
}

interface RefreshFlight {
  generation: number;
  promise: Promise<CachedWorktreeDiffStats | undefined>;
}

interface DeferredSweep {
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
}

interface SweepState {
  active: boolean;
  inFlight: Promise<void> | null;
  lastStartedAt: number | null;
  requestedAgain: boolean;
  deferred: DeferredSweep | null;
}

const entries = new Map<string, CachedWorktreeDiffStats>();
const generations = new Map<string, number>();
const flights = new Map<string, RefreshFlight>();
const lastRefreshAttemptAt = new Map<string, number>();
const pushedBaseFingerprints = new Map<string, string>();
const REFRESH_CONCURRENCY = 4;
const MIN_REFRESH_INTERVAL_MS = 5_000;
const SWEEP_MIN_INTERVAL_MS = 30_000;
const ALL_WORKTREES_SWEEP_KEY = 'all';
const sweepStates = new Map<string, SweepState>();
let warmingEpoch = 0;

function key(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}\0${worktreeId}`;
}

function nextGeneration(cacheKey: string): number {
  const generation = (generations.get(cacheKey) ?? 0) + 1;
  generations.set(cacheKey, generation);
  return generation;
}

function getSweepState(sweepKey: string): SweepState {
  const existing = sweepStates.get(sweepKey);
  if (existing) return existing;
  const state: SweepState = {
    active: true,
    inFlight: null,
    lastStartedAt: null,
    requestedAgain: false,
    deferred: null,
  };
  sweepStates.set(sweepKey, state);
  return state;
}

function scheduleSweep(
  state: SweepState,
  refresh: () => Promise<void>,
): Promise<void> {
  if (state.deferred) return state.deferred.promise;
  const delay = Math.max(
    0,
    (state.lastStartedAt ?? Date.now()) + SWEEP_MIN_INTERVAL_MS - Date.now(),
  );
  let resolveDeferred!: () => void;
  let rejectDeferred!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  const timer = setTimeout(() => {
    if (!state.active) {
      resolveDeferred();
      return;
    }
    state.deferred = null;
    startSweep(state, refresh).then(resolveDeferred, rejectDeferred);
  }, delay);
  timer.unref?.();
  state.deferred = {
    timer,
    promise,
    resolve: resolveDeferred,
  };
  return promise;
}

function startSweep(
  state: SweepState,
  refresh: () => Promise<void>,
): Promise<void> {
  state.lastStartedAt = Date.now();
  state.requestedAgain = false;
  const promise = Promise.resolve().then(refresh);
  state.inFlight = promise;
  const settle = (): void => {
    if (!state.active || state.inFlight !== promise) return;
    state.inFlight = null;
    if (state.requestedAgain) {
      state.requestedAgain = false;
      void scheduleSweep(state, refresh);
    }
  };
  void promise.then(settle, settle);
  return promise;
}

function requestSweep(
  sweepKey: string,
  refresh: () => Promise<void>,
): Promise<void> {
  const state = getSweepState(sweepKey);
  if (state.inFlight) {
    state.requestedAgain = true;
    return state.inFlight;
  }
  if (state.deferred) return state.deferred.promise;
  if (
    state.lastStartedAt !== null &&
    Date.now() - state.lastStartedAt < SWEEP_MIN_INTERVAL_MS
  ) {
    return scheduleSweep(state, refresh);
  }
  return startSweep(state, refresh);
}

function scheduleSharedContainerPublish(
  workspaceId: string,
  worktreeId: string,
): void {
  // Keep the publisher off this cache module's eager startup path. The
  // scheduler checks durable publication records and its idle debounce
  // collapses edit-grade refreshes into one revision.
  void import('../shared-containers/publish/scheduler')
    .then(({ getSharedContainerPublishScheduler }) =>
      getSharedContainerPublishScheduler().scheduleKnown(
        workspaceId,
        worktreeId,
      ),
    )
    // Diff-stat tracking must never surface as an unhandled main-process
    // rejection when the publication-state read fails.
    .catch(() => undefined);
}

async function didPushedBaseChange(
  workspaceId: string,
  worktreeId: string,
): Promise<boolean> {
  try {
    const repositories = await listSharedContainerLocalRepositories(
      workspaceId,
      worktreeId,
    );
    const bases = await Promise.all(
      repositories.map(async (repository) => ({
        repoId: repository.repoId,
        sha: await getRemoteTrackingCommitSha(repository.repoPath),
      })),
    );
    const fingerprint = bases
      .map(({ repoId, sha }) => `${repoId}:${sha ?? 'snapshot'}`)
      .sort()
      .join('\n');
    const cacheKey = key(workspaceId, worktreeId);
    const previous = pushedBaseFingerprints.get(cacheKey);
    pushedBaseFingerprints.set(cacheKey, fingerprint);
    return previous !== undefined && previous !== fingerprint;
  } catch {
    return false;
  }
}

export function getCachedWorktreeDiffStats(
  workspaceId: string,
  worktreeId: string,
): CachedWorktreeDiffStats | undefined {
  return entries.get(key(workspaceId, worktreeId));
}

export function invalidateWorktreeDiffStats(
  workspaceId: string,
  worktreeId: string,
): number {
  const generation = nextGeneration(key(workspaceId, worktreeId));
  scheduleSharedContainerPublish(workspaceId, worktreeId);
  return generation;
}

export function primeWorktreeDiffStats(
  workspaceId: string,
  worktreeId: string,
  stats: { insertions: number; deletions: number },
): void {
  const cacheKey = key(workspaceId, worktreeId);
  const generation = nextGeneration(cacheKey);
  entries.set(cacheKey, {
    ...stats,
    refreshedAt: Date.now(),
    generation,
  });
  void emitWorktreeDiffStatsDelta(workspaceId, worktreeId, generation);
}

export function removeCachedWorktreeDiffStats(
  workspaceId: string,
  worktreeId: string,
): void {
  const cacheKey = key(workspaceId, worktreeId);
  nextGeneration(cacheKey);
  entries.delete(cacheKey);
  lastRefreshAttemptAt.delete(cacheKey);
  pushedBaseFingerprints.delete(cacheKey);
}

export function removeCachedWorkspaceDiffStats(workspaceId: string): void {
  const prefix = `${workspaceId}\0`;
  // Include flight-only keys: a cold refresh (generation 0) tracked solely in
  // `flights` must still be invalidated, or its late commit would repopulate
  // the cache and emit a delta after the workspace was deleted.
  const cacheKeys = new Set<string>();
  entries.forEach((_entry, cacheKey): void => {
    cacheKeys.add(cacheKey);
  });
  generations.forEach((_generation, cacheKey): void => {
    cacheKeys.add(cacheKey);
  });
  flights.forEach((_flight, cacheKey): void => {
    cacheKeys.add(cacheKey);
  });
  lastRefreshAttemptAt.forEach((_attemptedAt, cacheKey): void => {
    cacheKeys.add(cacheKey);
  });
  cacheKeys.forEach((cacheKey): void => {
    if (cacheKey.startsWith(prefix)) {
      nextGeneration(cacheKey);
      entries.delete(cacheKey);
      lastRefreshAttemptAt.delete(cacheKey);
      pushedBaseFingerprints.delete(cacheKey);
    }
  });
}

/**
 * `readDiffStats` reads a refresh this call starts; a refresh in flight or a
 * recent entry serves the call with the stats it read.
 */
export function refreshWorktreeDiffStats(
  workspaceId: string,
  worktreeId: string,
  readDiffStats?: WorktreeRepoDiffStatsReader,
): Promise<CachedWorktreeDiffStats | undefined> {
  const cacheKey = key(workspaceId, worktreeId);
  const generation = generations.get(cacheKey) ?? 0;
  const flight = flights.get(cacheKey);
  if (flight?.generation === generation) {
    return flight.promise;
  }
  const cached = entries.get(cacheKey);
  if (
    cached?.generation === generation &&
    Date.now() - cached.refreshedAt < MIN_REFRESH_INTERVAL_MS
  ) {
    return Promise.resolve(cached);
  }

  lastRefreshAttemptAt.set(cacheKey, Date.now());
  const promise = getWorktreeDiffStatsOnly(
    workspaceId,
    worktreeId,
    readDiffStats,
  )
    .then(async (stats) => {
      if (!(await isWorktreeReadAvailable(workspaceId, worktreeId)))
        return entries.get(cacheKey);
      if ((generations.get(cacheKey) ?? 0) !== generation) {
        return entries.get(cacheKey);
      }
      const refreshed: CachedWorktreeDiffStats = {
        ...stats,
        refreshedAt: Date.now(),
        generation,
      };
      entries.set(cacheKey, refreshed);
      // Publication state, rather than cache history, decides whether the
      // browser needs a delta. This also retries values whose earlier delta was
      // rejected after the cache commit.
      void emitWorktreeDiffStatsDelta(workspaceId, worktreeId, generation);
      return didPushedBaseChange(workspaceId, worktreeId).then(() => {
        // Periodic refreshes are the file-activity signal for edits made
        // outside the app. The scheduler fingerprints content and suppresses
        // unchanged revisions after its idle debounce.
        scheduleSharedContainerPublish(workspaceId, worktreeId);
        return refreshed;
      });
    })
    .catch((): CachedWorktreeDiffStats | undefined => {
      if ((generations.get(cacheKey) ?? 0) === generation) {
        scheduleSharedContainerPublish(workspaceId, worktreeId);
      }
      return entries.get(cacheKey);
    })
    .finally((): void => {
      if (flights.get(cacheKey)?.promise === promise) {
        flights.delete(cacheKey);
      }
    });
  flights.set(cacheKey, { generation, promise });
  return promise;
}

/** Defer optional work without reviving removed or cancelled cache generations. */
export function warmWorktreeDiffStats(
  workspaceId: string,
  worktreeId: string,
): Promise<CachedWorktreeDiffStats | undefined> {
  return warmRegisteredWorktreeDiffStats(
    workspaceId,
    worktreeId,
    registerWarmTarget(workspaceId, worktreeId, warmingEpoch),
  );
}

interface WarmTarget {
  workspaceId: string;
  worktreeId: string;
  generation: number;
  epoch: number;
}

function registerWarmTarget(
  workspaceId: string,
  worktreeId: string,
  epoch: number,
): WarmTarget {
  const cacheKey = key(workspaceId, worktreeId);
  const generation = generations.get(cacheKey) ?? 0;
  // Register cold queued keys so workspace removal can invalidate them too.
  generations.set(cacheKey, generation);
  return { workspaceId, worktreeId, generation, epoch };
}

function registerWarmSweep(
  targets: Array<{ workspaceId: string; worktreeId: string }>,
): WarmTarget[] {
  const epoch = warmingEpoch;
  return targets.map(({ workspaceId, worktreeId }) =>
    registerWarmTarget(workspaceId, worktreeId, epoch),
  );
}

function warmRegisteredWorktreeDiffStats(
  workspaceId: string,
  worktreeId: string,
  { generation, epoch }: WarmTarget,
): Promise<CachedWorktreeDiffStats | undefined> {
  const cacheKey = key(workspaceId, worktreeId);
  return portalSnapshotWorkBudget.warm(() =>
    epoch === warmingEpoch && generations.get(cacheKey) === generation
      ? refreshWorktreeDiffStats(workspaceId, worktreeId)
      : Promise.resolve(undefined),
  );
}

export async function refreshAllWorktreeDiffStats(): Promise<void> {
  const sidebar = await readAllSidebarItems().catch(() => null);
  if (!sidebar) return;
  const worktrees: Array<{ workspaceId: string; worktreeId: string }> = [];
  for (const item of sidebar.items) {
    if (item.type !== 'single-repo' && item.type !== 'multi-repo') continue;
    for (const worktree of item.worktrees) {
      worktrees.push({ workspaceId: item.id, worktreeId: worktree.id });
    }
  }
  await mapWithConcurrency(
    registerWarmSweep(worktrees),
    REFRESH_CONCURRENCY,
    (worktree): Promise<CachedWorktreeDiffStats | undefined> =>
      warmRegisteredWorktreeDiffStats(
        worktree.workspaceId,
        worktree.worktreeId,
        worktree,
      ),
  );
}

export function requestAllWorktreeDiffStatsRefresh(): Promise<void> {
  return requestSweep(ALL_WORKTREES_SWEEP_KEY, refreshAllWorktreeDiffStats);
}

export async function refreshMissingWorktreeDiffStats(): Promise<void> {
  const sidebar = await readAllSidebarItems().catch(() => null);
  if (!sidebar) return;
  const now = Date.now();
  const missing: Array<{ workspaceId: string; worktreeId: string }> = [];
  for (const item of sidebar.items) {
    if (item.type !== 'single-repo' && item.type !== 'multi-repo') continue;
    for (const worktree of item.worktrees) {
      const cacheKey = key(item.id, worktree.id);
      const attemptedAt = lastRefreshAttemptAt.get(cacheKey);
      if (
        !entries.has(cacheKey) &&
        (attemptedAt === undefined ||
          now - attemptedAt >= SWEEP_MIN_INTERVAL_MS)
      ) {
        missing.push({ workspaceId: item.id, worktreeId: worktree.id });
      }
    }
  }
  await mapWithConcurrency(
    registerWarmSweep(missing),
    REFRESH_CONCURRENCY,
    (worktree): Promise<CachedWorktreeDiffStats | undefined> =>
      warmRegisteredWorktreeDiffStats(
        worktree.workspaceId,
        worktree.worktreeId,
        worktree,
      ),
  );
}

export async function refreshWorkspaceWorktreeDiffStats(
  workspaceId: string,
): Promise<void> {
  const sidebar = await readAllSidebarItems().catch(() => null);
  if (!sidebar) return;
  for (const item of sidebar.items) {
    if (
      item.id !== workspaceId ||
      (item.type !== 'single-repo' && item.type !== 'multi-repo')
    ) {
      continue;
    }
    await mapWithConcurrency(
      registerWarmSweep(
        item.worktrees.map((worktree) => ({
          workspaceId,
          worktreeId: worktree.id,
        })),
      ),
      REFRESH_CONCURRENCY,
      (worktree): Promise<CachedWorktreeDiffStats | undefined> =>
        warmRegisteredWorktreeDiffStats(
          worktree.workspaceId,
          worktree.worktreeId,
          worktree,
        ),
    );
    return;
  }
}

export function requestWorkspaceWorktreeDiffStatsRefresh(
  workspaceId: string,
): Promise<void> {
  return requestSweep(`workspace\0${workspaceId}`, () =>
    refreshWorkspaceWorktreeDiffStats(workspaceId),
  );
}

export function cancelPendingWorktreeDiffStatsRefreshes(): void {
  warmingEpoch += 1;
  sweepStates.forEach((state): void => {
    state.active = false;
    state.requestedAgain = false;
    if (state.deferred) {
      clearTimeout(state.deferred.timer);
      state.deferred.resolve();
      state.deferred = null;
    }
  });
  sweepStates.clear();
}

export function resetWorktreeDiffStatsCacheForTests(): void {
  cancelPendingWorktreeDiffStatsRefreshes();
  entries.clear();
  generations.clear();
  flights.clear();
  lastRefreshAttemptAt.clear();
  pushedBaseFingerprints.clear();
}
