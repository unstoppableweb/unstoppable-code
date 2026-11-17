import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { ActivityChangedFilesResponse } from '@canopy/desktop-shared/types';

export interface ChangedFilesRefreshOptions {
  kind: 'automatic' | 'explicit' | 'mutation';
}

export interface ChangedFilesObservation extends ChangedFilesRefreshOptions {
  onlyIfLoaded: boolean;
  canPublish: () => boolean;
}

type RefreshResult = ActivityChangedFilesResponse | undefined;
type RefreshLoadedWorktreeChangedFiles = (
  projectId: string,
  worktreeId: string,
  observation: ChangedFilesObservation,
) => Promise<RefreshResult>;

let refreshLoadedWorktreeChangedFiles: RefreshLoadedWorktreeChangedFiles = () =>
  Promise.resolve(undefined);

interface Waiter extends ChangedFilesRefreshOptions {
  onlyIfLoaded: boolean;
  resolve: (value: RefreshResult) => void;
  reject: (error: unknown) => void;
}

interface Batch {
  generation: number;
  waiters: Waiter[];
}

interface RefreshState {
  generation: number;
  pending: Waiter[];
  current?: Batch;
  timer?: ReturnType<typeof setTimeout>;
  deadline: number;
  owners: number;
  reconciliationTimers: Set<ReturnType<typeof setTimeout>>;
}

const refreshes = new Map<string, RefreshState>();
const AUTOMATIC_REFRESH_WINDOW_MS = 100;

function stateFor(key: string): RefreshState {
  const existing = refreshes.get(key);
  if (existing) return existing;
  const state: RefreshState = {
    generation: 0,
    pending: [],
    deadline: 0,
    owners: 0,
    reconciliationTimers: new Set(),
  };
  refreshes.set(key, state);
  return state;
}

function releaseIdle(key: string, state: RefreshState): void {
  if (
    refreshes.get(key) === state &&
    !state.current &&
    state.pending.length === 0 &&
    state.owners === 0
  ) {
    refreshes.delete(key);
  }
}

export function registerLoadedChangedFilesRefresh(
  refresh: RefreshLoadedWorktreeChangedFiles,
): void {
  refreshLoadedWorktreeChangedFiles = refresh;
}

function schedule(
  projectId: string,
  worktreeId: string,
  state: RefreshState,
): void {
  const key = `${projectId}/${worktreeId}`;
  if (refreshes.get(key) !== state || state.current || state.timer) return;
  if (state.pending.length === 0) {
    releaseIdle(key, state);
    return;
  }
  const delay = state.pending.some((waiter) => waiter.kind === 'mutation')
    ? 0
    : Math.max(0, state.deadline - performance.now());
  if (delay === 0) {
    start(projectId, worktreeId, state);
  } else {
    state.timer = setTimeout(() => {
      state.timer = undefined;
      start(projectId, worktreeId, state);
    }, delay);
  }
}

function start(
  projectId: string,
  worktreeId: string,
  state: RefreshState,
): void {
  const key = `${projectId}/${worktreeId}`;
  if (refreshes.get(key) !== state || state.pending.length === 0) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  const batch: Batch = {
    generation: ++state.generation,
    waiters: state.pending.splice(0),
  };
  state.current = batch;
  const kind = batch.waiters.some((waiter) => waiter.kind === 'explicit')
    ? 'explicit'
    : batch.waiters.some((waiter) => waiter.kind === 'mutation')
      ? 'mutation'
      : 'automatic';
  const observation: ChangedFilesObservation = {
    kind,
    onlyIfLoaded: batch.waiters.every((waiter) => waiter.onlyIfLoaded),
    canPublish: () =>
      refreshes.get(key) === state && state.generation === batch.generation,
  };
  void (async (): Promise<void> => {
    try {
      const result = await refreshLoadedWorktreeChangedFiles(
        projectId,
        worktreeId,
        observation,
      );
      for (const waiter of batch.waiters.splice(0)) {
        waiter.resolve(observation.canPublish() ? result : undefined);
      }
    } catch (error) {
      if (batch.waiters.length > 0 && kind !== 'explicit')
        reportClientAppError(error);
      for (const waiter of batch.waiters.splice(0)) {
        if (waiter.kind === 'explicit') waiter.reject(error);
        else waiter.resolve(undefined);
      }
    } finally {
      // An explicit bypass can replace this batch while its IPC is in flight.
      if (state.current === batch) {
        state.current = undefined;
        schedule(projectId, worktreeId, state);
      }
    }
  })();
}

function requestChangedFilesRefreshInternal(
  projectId: string,
  worktreeId: string,
  onlyIfLoaded: boolean,
  options: ChangedFilesRefreshOptions,
): Promise<RefreshResult> {
  const state = stateFor(`${projectId}/${worktreeId}`);
  return new Promise((resolve, reject) => {
    if (state.pending.length === 0)
      state.deadline = performance.now() + AUTOMATIC_REFRESH_WINDOW_MS;
    state.pending.push({ ...options, onlyIfLoaded, resolve, reject });
    if (options.kind === 'explicit') {
      // The new sample covers these older requests too. Transfer ownership so
      // they need not wait for a superseded read, and keep hydration requirements.
      if (state.current) state.pending.push(...state.current.waiters.splice(0));
      start(projectId, worktreeId, state);
    } else {
      // Even without a mutation event, a request during a read may follow an
      // external edit. Keep it pending for a read that starts after the request.
      if (options.kind === 'mutation') {
        ++state.generation;
        if (state.current)
          state.pending.push(...state.current.waiters.splice(0));
      }
      if (options.kind === 'mutation' && state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      schedule(projectId, worktreeId, state);
    }
  });
}

/** Refresh a worktree even before its Changed Files slot has been hydrated. */
export function requestChangedFilesRefresh(
  projectId: string,
  worktreeId: string,
  options: ChangedFilesRefreshOptions,
): Promise<RefreshResult> {
  return requestChangedFilesRefreshInternal(
    projectId,
    worktreeId,
    false,
    options,
  );
}

/** Refresh only when a consumer has already loaded this worktree's list. */
export function requestLoadedChangedFilesRefresh(
  projectId: string,
  worktreeId: string,
  options: ChangedFilesRefreshOptions,
): Promise<RefreshResult> {
  return requestChangedFilesRefreshInternal(
    projectId,
    worktreeId,
    true,
    options,
  );
}

/** Retire an observation identity, including when these IDs will be reused. */
export function invalidateChangedFilesRefresh(
  projectId: string,
  worktreeId: string,
): void {
  const key = `${projectId}/${worktreeId}`;
  const state = refreshes.get(key);
  if (!state) return;
  refreshes.delete(key);
  if (state.timer) clearTimeout(state.timer);
  for (const timer of state.reconciliationTimers) clearTimeout(timer);
  for (const waiter of state.pending.splice(0)) waiter.resolve(undefined);
  for (const waiter of state.current?.waiters.splice(0) ?? [])
    waiter.resolve(undefined);
  state.current = undefined;
}

/** One owner for targeted stats and its dependent list reconciliation. */
export async function reconcileChangedFilesAfterStats<T>(
  targets: ReadonlyArray<{ projectId: string; worktreeId: string }>,
  refreshStats: () => Promise<T>,
): Promise<T> {
  const observations = targets.map(({ projectId, worktreeId }) => {
    const key = `${projectId}/${worktreeId}`;
    const state = stateFor(key);
    ++state.owners;
    const refresh = (): Promise<RefreshResult> =>
      refreshes.get(key) === state
        ? requestLoadedChangedFilesRefresh(projectId, worktreeId, {
            kind: 'mutation',
          })
        : Promise.resolve(undefined);
    // Match the activity handler's existing three-second network head start.
    let early: Promise<RefreshResult> | undefined;
    const timer = setTimeout(() => {
      state.reconciliationTimers.delete(timer);
      early = refresh();
    }, 3_000);
    state.reconciliationTimers.add(timer);
    return async (): Promise<void> => {
      clearTimeout(timer);
      state.reconciliationTimers.delete(timer);
      try {
        await early;
        await refresh();
      } finally {
        --state.owners;
        releaseIdle(key, state);
      }
    };
  });
  try {
    return await refreshStats();
  } finally {
    await Promise.all(observations.map((finish) => finish()));
  }
}

let cleanupWorktreeActivity: (
  projectId: string,
  worktreeId: string,
) => void = () => undefined;

/** Activity owns its state; the project store must not import it in reverse. */
export function registerWorktreeActivityCleanup(
  cleanup: typeof cleanupWorktreeActivity,
): void {
  cleanupWorktreeActivity = cleanup;
}

export function clearWorktreeActivity(
  projectId: string,
  worktreeId: string,
): void {
  invalidateChangedFilesRefresh(projectId, worktreeId);
  cleanupWorktreeActivity(projectId, worktreeId);
}
