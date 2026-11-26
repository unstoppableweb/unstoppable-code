import { useEffect } from 'react';
import { useActivityStore } from '@/stores/activityStore';
import type { DetectedPlansUpdatedEvent } from '@canopy/desktop-shared/types';

/** Feeds detected-plan pushes to the store; returns the unsubscribe. */
export function subscribeDetectedPlans(): () => void {
  return window.api.activity.onDetectedPlansUpdated(
    (event: DetectedPlansUpdatedEvent) => {
      useActivityStore
        .getState()
        .setDetectedPlans(event.projectId, event.worktreeId, event.entries);
    },
  );
}

/**
 * Detected-plan pushes, mounted with the app so none is missed: the store
 * takes a worktree's detected plans from these pushes (CAN-4165 PR 7c).
 */
export function useDetectedPlansSubscription(): void {
  useEffect(subscribeDetectedPlans, []);
}
