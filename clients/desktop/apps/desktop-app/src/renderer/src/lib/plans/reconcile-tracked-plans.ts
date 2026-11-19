import { useActivityStore } from '@/stores/activityStore';
import { useGitHubStore } from '@/stores/githubStore';

export interface PlanReviewScope {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId?: string;
}

/** Refresh-only recovery never repeats a review mutation or execution. */
export async function reconcileTrackedPlans(
  scope: PlanReviewScope,
): Promise<boolean> {
  try {
    await useActivityStore
      .getState()
      .loadTrackedPlans(scope.projectId, scope.worktreeId);
    return true;
  } catch (error) {
    useGitHubStore.getState().addToast(
      "Couldn't refresh the plan's status. Select to retry.",
      'error',
      (): void => {
        void reconcileTrackedPlans(scope);
      },
      { ...scope, caught: error },
    );
    return false;
  }
}

/** Main already accepted the execution and wrote its implicit approval. */
export async function reconcileExecutedPlan(
  scope: PlanReviewScope,
  planId: string,
): Promise<void> {
  useActivityStore
    .getState()
    .noteTrackedPlanWrite(scope.projectId, scope.worktreeId, planId);
  await reconcileTrackedPlans(scope);
}
