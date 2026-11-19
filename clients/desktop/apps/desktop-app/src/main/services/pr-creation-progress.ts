import type {
  PortalPrCreationProgress,
  PortalPrCreationStep,
  PortalPullRequestState,
  PrCreationProgressEvent,
} from '@canopy/desktop-shared/types';
import { clearPrMergeProgressFeed } from './pr-merge-progress';

/**
 * Main-process aggregator for the PR-creation feed (CAN-1528 L2).
 *
 * The desktop renderer accumulates `PrCreationProgressEvent`s into the
 * githubStore's `creationProgress` map; the portal has no renderer, so this
 * registry mirrors that reducer main-side and exposes the accumulated feed to
 * `refreshPullRequestState`, which projects it as
 * `PortalPullRequestState.creationProgress`.
 *
 * State is per-window-of-work runtime state on the Electron main process —
 * intentionally not persisted (a restart mid-creation also drops the
 * renderer's copy).
 */

const progressByKey = new Map<string, PortalPrCreationProgress>();

function progressKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Reset the feed when a PR creation starts. Mirrors the renderer's
 * unconditional reset in `githubStore.createPr`.
 */
export function beginPrCreationProgress(
  projectId: string,
  worktreeId: string,
): void {
  clearPrMergeProgressFeed(projectId, worktreeId);
  progressByKey.set(progressKey(projectId, worktreeId), {
    steps: [],
    currentPhase: 'gathering_changes',
  });
}

/** Clear an in-flight feed on cancellation. */
export function cancelPrCreationProgress(
  projectId: string,
  worktreeId: string,
): void {
  progressByKey.delete(progressKey(projectId, worktreeId));
}

/**
 * Append one progress event. The phase transition rules mirror the renderer
 * reducer in `githubStore` exactly: per-repo terminal (`done`/`error` with a
 * repoName) and `skipped` events do not override the overall phase, and a
 * global `done` after any per-repo error keeps the feed in `error`.
 */
export function recordPrCreationProgress(event: PrCreationProgressEvent): void {
  const key = progressKey(event.projectId, event.worktreeId);
  const existing = progressByKey.get(key);
  const step: PortalPrCreationStep = { phase: event.phase };
  if (event.repoName !== undefined) step.repoName = event.repoName;
  if (event.error !== undefined) step.error = event.error;
  const steps = [...(existing?.steps ?? []), step];
  const isPerRepoTerminal =
    (event.phase === 'done' || event.phase === 'error') && !!event.repoName;
  const isSkipped = event.phase === 'skipped';
  const hasPerRepoError = steps.some(
    (s) => s.phase === 'error' && s.repoName != null,
  );
  const isGlobalDone =
    event.phase === 'done' && !event.repoName && hasPerRepoError;
  const currentPhase =
    isPerRepoTerminal || isSkipped
      ? (existing?.currentPhase ?? event.phase)
      : isGlobalDone
        ? 'error'
        : event.phase;
  progressByKey.set(key, { steps, currentPhase });
}

/** Read the accumulated feed for the worktree, if any. */
export function getPrCreationProgress(
  projectId: string,
  worktreeId: string,
): PortalPrCreationProgress | undefined {
  return progressByKey.get(progressKey(projectId, worktreeId));
}

/**
 * Drop a settled successful feed, or a stale error feed once a refresh proves
 * every repo has a PR. Returns whether the refreshed payload must carry an
 * explicit null tombstone so remote clients remove their remembered feed.
 */
export function clearStalePrCreationProgress(
  projectId: string,
  worktreeId: string,
  state: Pick<PortalPullRequestState, 'repos'>,
): boolean {
  const key = progressKey(projectId, worktreeId);
  const progress = progressByKey.get(key);
  if (progress === undefined) return false;
  if (progress.currentPhase === 'done') {
    const completedRepoNames = progress.steps.flatMap((step) =>
      step.phase === 'done' && step.repoName != null ? [step.repoName] : [],
    );
    if (completedRepoNames.length > 0) {
      const repos = state.repos;
      const matchingPrsArrived =
        repos != null &&
        completedRepoNames.every((repoName) =>
          repos.some(
            (repo) =>
              repo.repoName === repoName &&
              (repo.status?.state === 'open' || repo.status?.state === 'draft'),
          ),
        );
      if (!matchingPrsArrived) return false;
    }
    progressByKey.delete(key);
    return true;
  }
  if (progress.currentPhase !== 'error') return false;
  const repos = state.repos;
  if (!repos || repos.length === 0) return false;
  const everyRepoHasPr = repos.every((repo) => repo.status != null);
  if (everyRepoHasPr) {
    progressByKey.delete(key);
    return true;
  }
  return false;
}

/**
 * Drop every map entry for a worktree. Called from the worktree-data cleanup
 * path so deleted worktrees do not pin a leftover feed in this module map for
 * the process lifetime.
 */
export function clearPortalPrTracking(
  projectId: string,
  worktreeId: string,
): void {
  progressByKey.delete(progressKey(projectId, worktreeId));
}
