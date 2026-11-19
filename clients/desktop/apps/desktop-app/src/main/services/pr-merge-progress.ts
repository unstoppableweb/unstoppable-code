import type { RemoteControlSessionShellState } from '@canopy/protocol/remote-control/shell';
import type {
  RemoteControlMergePrProgress,
  RemoteControlMergePrStep,
} from '@canopy/protocol/remote-control/shell';
import type { MergePrProgressEvent } from '@canopy/desktop-shared/types/github';
import { scheduleDesktopStructureChanged } from './desktop-structure-signal';

type MergeProjection = Pick<
  RemoteControlSessionShellState['worktrees'][number],
  'mergingPr' | 'mergePrPhase'
>;

// Runtime state survives remote disconnects, but never a desktop restart.
// Merge requests for a worktree are serialized by runCancellableGitAction.
const progress = new Map<string, MergeProjection>();
// The step feed projected to the portal as `pr_status.mergeProgress`. Kept
// separate from `progress` because the worktree projection is a boolean plus
// current phase, while the portal feed is an accumulating checklist whose
// errored state outlives the operation.
const feed = new Map<string, RemoteControlMergePrProgress>();
let lastMergeGeneration = 0;
const key = (workspaceId: string, worktreeId: string): string =>
  JSON.stringify([workspaceId, worktreeId]);

export function beginPrMergeProgress(
  workspaceId: string,
  worktreeId: string,
): void {
  const id = key(workspaceId, worktreeId);
  progress.set(id, {
    mergingPr: true,
    mergePrPhase: 'checking_mergeability',
  });
  lastMergeGeneration = Math.max(Date.now(), lastMergeGeneration + 1);
  feed.set(id, {
    generation: lastMergeGeneration,
    steps: [],
    currentPhase: 'checking_mergeability',
  });
  scheduleDesktopStructureChanged('structural.pr-merge-progress');
}

export function recordPrMergeProgress(event: MergePrProgressEvent): void {
  const id = key(event.projectId, event.worktreeId);
  // Per-repo errors/completion must not finish a multi-repo operation. The
  // request's finally block owns cleanup, including cancellation and no-ops.
  if (!progress.has(id)) return;

  const isTerminal = event.phase === 'done' || event.phase === 'error';
  if (event.phase !== 'done' && event.phase !== 'error') {
    progress.set(id, { mergingPr: true, mergePrPhase: event.phase });
    scheduleDesktopStructureChanged('structural.pr-merge-progress');
  }

  const existing = feed.get(id);
  if (existing !== undefined) {
    const step: RemoteControlMergePrStep = { phase: event.phase };
    if (event.repoId !== undefined) step.repoId = event.repoId;
    if (event.repoName !== undefined) step.repoName = event.repoName;
    if (event.queuePosition !== undefined)
      step.queuePosition = event.queuePosition;
    if (event.queueLength !== undefined) step.queueLength = event.queueLength;
    if (event.retryDelayMs !== undefined)
      step.retryDelayMs = event.retryDelayMs;
    if (event.error !== undefined) step.error = event.error;

    // A per-repo terminal step records without ending the overall merge.
    // Every real emission in `ipc/github.ts` that names a repo carries
    // `repoName` (including in a single-repo workspace); only the outer
    // `refreshing_pr_status` / `done` pair is global.
    const isPerRepoTerminal = isTerminal && event.repoName !== undefined;
    const steps = [...existing.steps, step];
    // Mirrors `recordPrCreationProgress`: a global `done` that follows a
    // per-repo failure settles the whole operation in `error`, so a
    // partially successful multi-repo merge does not read as a clean success.
    const isGlobalDone = event.phase === 'done' && event.repoName === undefined;
    const hasPerRepoError = steps.some(
      (recorded) => recorded.phase === 'error' && recorded.repoName != null,
    );
    const next: RemoteControlMergePrProgress = {
      generation: existing.generation,
      steps,
      currentPhase: isPerRepoTerminal
        ? existing.currentPhase
        : isGlobalDone && hasPerRepoError
          ? 'error'
          : event.phase,
    };
    feed.set(id, next);
  }
}

export function finishPrMergeProgress(
  workspaceId: string,
  worktreeId: string,
): void {
  const id = key(workspaceId, worktreeId);
  const hadProgress = progress.delete(id);
  // A failed merge emits no global terminal event at all: the outer
  // `refreshing_pr_status` / `done` pair only fires when at least one repo
  // merged, and every per-repo `error` is held back by the multi-repo guard
  // above. Resolve the overall failure here, once the operation is over and
  // no further repo can still succeed, rather than at the per-repo `error`
  // step — flipping the card to `Failed` mid-run would be wrong for a
  // multi-repo merge whose remaining repos are still merging.
  const settled = feed.get(id);
  if (
    settled !== undefined &&
    settled.currentPhase !== 'done' &&
    settled.currentPhase !== 'error' &&
    settled.steps.some((step) => step.phase === 'error')
  ) {
    const errored: RemoteControlMergePrProgress = {
      generation: settled.generation,
      steps: settled.steps,
      currentPhase: 'error',
    };
    feed.set(id, errored);
  }
  // Keep terminal feeds so the card can render `Failed` or `Merged` after the
  // operation ends; the next `beginPrMergeProgress` resets either one. Active
  // feeds are dropped on cancellation or an early refusal.
  const finalPhase = feed.get(id)?.currentPhase;
  if (finalPhase !== 'error' && finalPhase !== 'done') {
    feed.delete(id);
  }
  if (hadProgress)
    scheduleDesktopStructureChanged('structural.pr-merge-progress');
}

export function getPrMergeProgress(
  workspaceId: string,
  worktreeId: string,
): MergeProjection {
  return (
    progress.get(key(workspaceId, worktreeId)) ?? {
      mergingPr: false,
      mergePrPhase: null,
    }
  );
}

/** Read the accumulated merge feed for the worktree, if any. */
export function getPrMergeProgressFeed(
  workspaceId: string,
  worktreeId: string,
): RemoteControlMergePrProgress | undefined {
  return feed.get(key(workspaceId, worktreeId));
}

/** Retire a feed from the previous PR lifecycle before creation starts. */
export function clearPrMergeProgressFeed(
  workspaceId: string,
  worktreeId: string,
): void {
  feed.delete(key(workspaceId, worktreeId));
}

/** Drop every merge map entry for a worktree (deletion / cleanup paths). */
export function clearPrMergeTracking(
  workspaceId: string,
  worktreeId: string,
): void {
  const id = key(workspaceId, worktreeId);
  progress.delete(id);
  feed.delete(id);
}
