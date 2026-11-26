import type { JSX, ReactElement } from 'react';
import { useShallow } from 'zustand/shallow';
import { PullRequestProgressTooltip } from '@canopy/ui-app/pull-requests';
import type { HoverCardTriggerProps } from '@canopy/ui-shared/components';
import { useGitHubStore } from '@/stores/githubStore';
import type { BranchSyncAction } from '@/lib/githubBranchActions';
import {
  buildCommitPushTooltipModel,
  buildCreatePrTooltipModel,
  buildMergePrTooltipModel,
  buildMergeTooltipModel,
  isCommitPushTooltipEnabled,
  isCreatePrTooltipEnabled,
  isMergePrTooltipEnabled,
  type GitActionTooltipModel,
} from '@/lib/git-progress';

export type GitActionKind =
  | { type: 'commit-push'; action: BranchSyncAction }
  | { type: 'merge' }
  | { type: 'merge-pr' }
  | { type: 'create-pr' };

interface GitActionProgressTooltipProps {
  projectId: string;
  worktreeId: string;
  action: GitActionKind;
  children: ReactElement<HoverCardTriggerProps>;
  dataTestId?: string;
  /**
   * Keeps the wrapper mounted but never shows the checklist, for an action
   * whose steps do not describe what the click will do.
   */
  suppressed?: boolean;
}

/**
 * Wraps a worktree status-bar git action button and, while that action is in
 * progress (or after it errors), shows a portaled checklist tooltip of the
 * action's steps. Idle buttons render with the tooltip suppressed. The
 * checklist itself is the shared `PullRequestProgressTooltip`; this desktop
 * wrapper builds its model from the GitHub store.
 */
export function GitActionProgressTooltip({
  projectId,
  worktreeId,
  action,
  children,
  dataTestId,
  suppressed = false,
}: GitActionProgressTooltipProps): JSX.Element {
  const key = `${projectId}/${worktreeId}`;
  const {
    committingAndPushing,
    activeBranchSyncAction,
    commitPushProgress,
    creatingPr,
    creationProgress,
    mergingLocalBranches,
    mergingPr,
    mergePrProgress,
    gitStatsRefreshing,
  } = useGitHubStore(
    useShallow((state) => ({
      committingAndPushing: state.committingAndPushing.has(key),
      activeBranchSyncAction: state.activeBranchSyncAction[key],
      commitPushProgress: state.commitPushProgress[key],
      creatingPr: state.creatingPr.has(key),
      creationProgress: state.creationProgress[key],
      mergingLocalBranches: state.mergingLocalBranches.has(key),
      mergingPr: state.mergingPr.has(key),
      mergePrProgress: state.mergePrProgress[key],
      gitStatsRefreshing: state.gitStatsRefreshing.has(key),
    })),
  );

  let enabled = false;
  let model: GitActionTooltipModel | null = null;

  if (action.type === 'commit-push') {
    // Active only for the specific button whose action is currently in flight.
    const isActive =
      committingAndPushing && activeBranchSyncAction === action.action;
    enabled = isCommitPushTooltipEnabled(commitPushProgress, isActive);
    if (enabled) {
      model = buildCommitPushTooltipModel(
        action.action,
        commitPushProgress,
        isActive,
        gitStatsRefreshing && isActive,
      );
    }
  } else if (action.type === 'create-pr') {
    enabled = isCreatePrTooltipEnabled(creationProgress, creatingPr);
    if (enabled) {
      model = buildCreatePrTooltipModel(
        creationProgress,
        creatingPr,
        gitStatsRefreshing && creatingPr,
      );
    }
  } else if (action.type === 'merge') {
    enabled = mergingLocalBranches;
    if (enabled) {
      model = buildMergeTooltipModel(
        gitStatsRefreshing && mergingLocalBranches,
        mergingLocalBranches,
      );
    }
  } else if (action.type === 'merge-pr') {
    enabled = isMergePrTooltipEnabled(mergePrProgress, mergingPr);
    if (enabled) {
      model = buildMergePrTooltipModel(
        mergePrProgress,
        mergingPr,
        gitStatsRefreshing && mergingPr,
      );
    }
  } else {
    // Exhaustiveness guard: a new GitActionKind variant must be handled above.
    const exhaustive: never = action;
    void exhaustive;
  }

  return (
    <PullRequestProgressTooltip
      model={enabled ? model : null}
      suppressed={suppressed}
      {...(dataTestId === undefined ? {} : { dataTestId })}
    >
      {children}
    </PullRequestProgressTooltip>
  );
}
