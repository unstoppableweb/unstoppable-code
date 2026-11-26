import { useEffect } from 'react';
import { useActivityStore } from '@/stores/activityStore';
import type {
  ActivityBgProcessOutputEvent,
  TrackedPlansUpdatedEvent,
  WorktreeSummaryGeneratingEvent,
  WorktreeSummaryUpdatedEvent,
} from '@canopy/desktop-shared/types';

export function useActivityEventSubscriptions(): void {
  const appendBgProcessOutput = useActivityStore(
    (state) => state.appendBgProcessOutput,
  );
  const setWorktreeSummary = useActivityStore(
    (state) => state.setWorktreeSummary,
  );
  const setSummaryGenerating = useActivityStore(
    (state) => state.setSummaryGenerating,
  );
  const upsertTrackedPlan = useActivityStore(
    (state) => state.upsertTrackedPlan,
  );
  const removeTrackedPlan = useActivityStore(
    (state) => state.removeTrackedPlan,
  );

  useEffect(() => {
    const unsubscribeBgOutput = window.api.activity.onBgProcessOutput(
      (event: ActivityBgProcessOutputEvent) => {
        appendBgProcessOutput(event);
      },
    );
    const unsubscribeSummaryUpdated =
      window.api.activity.onWorktreeSummaryUpdated(
        (event: WorktreeSummaryUpdatedEvent) => {
          setWorktreeSummary(
            `${event.projectId}/${event.worktreeId}`,
            event.summary,
          );
        },
      );
    const unsubscribeSummaryGenerating =
      window.api.activity.onWorktreeSummaryGenerating(
        (event: WorktreeSummaryGeneratingEvent) => {
          setSummaryGenerating(
            `${event.projectId}/${event.worktreeId}`,
            event.generating,
          );
        },
      );
    const unsubscribeTrackedPlansUpdated =
      window.api.activity.onTrackedPlansUpdated(
        (event: TrackedPlansUpdatedEvent) => {
          // CAN-1305: deletions (including portal-initiated ones) arrive on
          // this same channel with `change: 'remove'`. Legacy senders omit
          // `change` entirely and always mean an upsert.
          if (event.change === 'remove') {
            removeTrackedPlan(event.projectId, event.worktreeId, event.planId);
            return;
          }
          upsertTrackedPlan(event.plan);
        },
      );

    return (): void => {
      unsubscribeBgOutput();
      unsubscribeSummaryUpdated();
      unsubscribeSummaryGenerating();
      unsubscribeTrackedPlansUpdated();
    };
  }, [
    appendBgProcessOutput,
    setSummaryGenerating,
    setWorktreeSummary,
    upsertTrackedPlan,
    removeTrackedPlan,
  ]);
}
