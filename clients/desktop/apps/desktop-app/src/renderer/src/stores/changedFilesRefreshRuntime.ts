import type { ActivityChangedFilesResponse } from '@canopy/desktop-shared/types';

type RefreshLoadedWorktreeChangedFiles = (
  projectId: string,
  worktreeId: string,
  options: { onlyIfLoaded: boolean },
) => Promise<ActivityChangedFilesResponse | undefined>;

let refreshLoadedWorktreeChangedFiles: RefreshLoadedWorktreeChangedFiles = () =>
  Promise.resolve(undefined);

interface PendingChangedFilesRefresh {
  promise: Promise<ActivityChangedFilesResponse | undefined>;
  queued: boolean;
  onlyIfLoaded: boolean;
}

const pendingChangedFilesRefreshes = new Map<
  string,
  PendingChangedFilesRefresh
>();

/**
 * Registers the activity-store implementation without making projectsStore
 * import activityStore and recreating their existing dependency in reverse.
 */
export function registerLoadedChangedFilesRefresh(
  refresh: RefreshLoadedWorktreeChangedFiles,
): void {
  refreshLoadedWorktreeChangedFiles = refresh;
}

function requestChangedFilesRefreshInternal(
  projectId: string,
  worktreeId: string,
  onlyIfLoaded: boolean,
): Promise<ActivityChangedFilesResponse | undefined> {
  const key = `${projectId}/${worktreeId}`;
  const pending = pendingChangedFilesRefreshes.get(key);
  if (pending) {
    // One slow read may have captured git state before the event that caused
    // this request. Never overlap and race its response; collapse bursts into
    // one trailing read that is guaranteed to start after it settles.
    pending.queued = true;
    pending.onlyIfLoaded &&= onlyIfLoaded;
    return pending.promise;
  }

  const state = {
    promise: Promise.resolve<ActivityChangedFilesResponse | undefined>(
      undefined,
    ),
    queued: false,
    onlyIfLoaded,
  } satisfies PendingChangedFilesRefresh;

  state.promise = (async (): Promise<
    ActivityChangedFilesResponse | undefined
  > => {
    let latest: ActivityChangedFilesResponse | undefined;
    let latestError: unknown;
    do {
      const runOnlyIfLoaded = state.onlyIfLoaded;
      state.queued = false;
      state.onlyIfLoaded = true;
      try {
        latest = await refreshLoadedWorktreeChangedFiles(
          projectId,
          worktreeId,
          { onlyIfLoaded: runOnlyIfLoaded },
        );
        latestError = undefined;
      } catch (error) {
        latestError = error;
      }
    } while (state.queued);

    if (latestError !== undefined) {
      throw latestError instanceof Error
        ? latestError
        : new Error('Changed Files refresh failed');
    }
    return latest;
  })().finally(() => {
    if (pendingChangedFilesRefreshes.get(key) === state) {
      pendingChangedFilesRefreshes.delete(key);
    }
  });
  pendingChangedFilesRefreshes.set(key, state);
  return state.promise;
}

/** Refresh a worktree even before its Changed Files slot has been hydrated. */
export function requestChangedFilesRefresh(
  projectId: string,
  worktreeId: string,
): Promise<ActivityChangedFilesResponse | undefined> {
  return requestChangedFilesRefreshInternal(projectId, worktreeId, false);
}

/** Refresh only when a consumer has already loaded this worktree's list. */
export function requestLoadedChangedFilesRefresh(
  projectId: string,
  worktreeId: string,
): Promise<ActivityChangedFilesResponse | undefined> {
  return requestChangedFilesRefreshInternal(projectId, worktreeId, true);
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
  cleanupWorktreeActivity(projectId, worktreeId);
}
