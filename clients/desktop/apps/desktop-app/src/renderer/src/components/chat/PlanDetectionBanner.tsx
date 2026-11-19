import { useMemo, useRef, useState, type JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { DocumentIcon } from '@canopy/ui-shared/icons/AppIcons';
import type {
  DetectedPlanEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { getBaseName } from '@/lib/format';
import { importDetectedPlan } from '@/lib/plans/import-detected-plan';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { createTrackedPlanSourceLookup } from '@/lib/plans/tracked-plan-sources';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';

// Stable empty reference so the Zustand selector below does not return a fresh
// array each render (which would loop useSyncExternalStore — "Maximum update
// depth exceeded") when no detections exist for this worktree yet.
const EMPTY_DETECTED_PLANS: DetectedPlanEntry[] = [];
const EMPTY_TRACKED_PLANS: TrackedPlanData[] = [];

// Finds the tracked plan already made from a detection's file, if any. The
// workspace id stands in for the worktree root so a plan imported from the
// single-repo file root matches a detection stored under a root sentinel.
function trackedPlanLookup(
  projectId: string,
  plans: readonly TrackedPlanData[],
  entries: readonly DetectedPlanEntry[],
): (entry: DetectedPlanEntry) => string | undefined {
  const lookup = createTrackedPlanSourceLookup(plans, entries, projectId);
  return (entry) => lookup(entry.sourceRepoId, entry.sourceFilePath);
}

interface PlanDetectionBannerProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export function PlanDetectionBanner({
  projectId,
  worktreeId,
  chatId,
}: PlanDetectionBannerProps): JSX.Element {
  const readOnly = useWorkspaceIsReadOnly();
  const key = `${projectId}/${worktreeId}`;
  const entries = useActivityStore(
    (state) => state.detectedPlans[key] ?? EMPTY_DETECTED_PLANS,
  );
  const trackedPlans = useActivityStore(
    (state) => state.trackedPlans[key] ?? EMPTY_TRACKED_PLANS,
  );
  const updateDetectedPlan = useActivityStore(
    (state) => state.updateDetectedPlan,
  );
  const addToast = useGitHubStore((state) => state.addToast);
  const [importing, setImporting] = useState(false);
  // Set before the first await, so a second click that lands before the
  // disabled button renders cannot start another import.
  const importingRef = useRef(false);
  // Imported here even when the status update failed, so a second click can
  // never import the same file twice.
  const [importedIds, setImportedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const trackedPlanIdFor = useMemo(
    () => trackedPlanLookup(projectId, trackedPlans, entries),
    [entries, projectId, trackedPlans],
  );

  const pending = entries.filter(
    (e) =>
      e.detectedInChatId === chatId &&
      e.status === 'detected' &&
      !e.bannerSeen &&
      !importedIds.has(e.id) &&
      !trackedPlanIdFor(e),
  );

  if (readOnly || pending.length === 0) {
    return <></>;
  }

  const single = pending.length === 1 ? pending[0] : null;

  const handleTrack = async (entry: DetectedPlanEntry): Promise<void> => {
    if (importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    try {
      // The file may have been imported another way since it was detected;
      // open that plan rather than import a duplicate. The inventory is only
      // loaded once the Plans section has shown this worktree.
      if (!useActivityStore.getState().trackedPlanInventoryLoaded[key]) {
        await useActivityStore
          .getState()
          .loadTrackedPlans(projectId, worktreeId)
          .catch(() => undefined);
      }
      const latest = useActivityStore.getState();
      const existingPlanId = trackedPlanLookup(
        projectId,
        latest.trackedPlans[key] ?? EMPTY_TRACKED_PLANS,
        latest.detectedPlans[key] ?? EMPTY_DETECTED_PLANS,
      )(entry);
      if (existingPlanId) {
        setImportedIds((current) => new Set(current).add(entry.id));
        void updateDetectedPlan(projectId, worktreeId, entry.id, {
          status: 'imported',
          importedPlanId: existingPlanId,
        }).catch((): void => undefined);
        // Same outcome as a fresh import: this chat learns the plan is tracked.
        useChatStore
          .getState()
          .queuePlanImportInstruction(chatId, entry.sourceFilePath);
        void openTrackedPlan(
          { projectId, worktreeId, planId: existingPlanId },
          { navigate: false, origin: { chatTabId: chatId } },
        );
        return;
      }
      const plan = await importDetectedPlan({
        projectId,
        worktreeId,
        entry,
        originChatId: chatId,
      });
      if (plan) {
        setImportedIds((current) => new Set(current).add(entry.id));
        void openTrackedPlan(
          { projectId, worktreeId, planId: plan.id },
          { navigate: false, origin: { chatTabId: chatId } },
        );
      }
    } catch (err: unknown) {
      addToast(
        err instanceof Error ? err.message : 'Failed to import plan',
        'error',
        undefined,
        { projectId, worktreeId, caught: err },
      );
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  const handleReview = (): void => {
    useActivityStore.getState().openImportModal({
      projectId,
      worktreeId,
      originChatId: chatId,
    });
  };

  const handleDismiss = (): void => {
    for (const entry of pending) {
      void updateDetectedPlan(projectId, worktreeId, entry.id, {
        bannerSeen: true,
      });
    }
  };

  return (
    <Notice
      intent="neutral"
      icon={<DocumentIcon size={16} aria-hidden="true" />}
      title={
        single
          ? `Track ${getBaseName(single.sourceFilePath)} as a plan?`
          : `${String(pending.length)} plan files found`
      }
      data-testid="plan-detection-banner"
      onDismiss={handleDismiss}
      dismissLabel="Dismiss plan detection notice"
      dismissTestId="plan-detection-banner-dismiss"
      actions={
        <NoticeButton
          variant="primary"
          data-testid="plan-detection-banner-import"
          disabled={importing}
          onClick={(): void => {
            if (single) {
              void handleTrack(single);
            } else {
              handleReview();
            }
          }}
        >
          {single ? 'Track plan' : `Review ${String(pending.length)} files…`}
        </NoticeButton>
      }
    >
      {single
        ? 'Review and comment on it in Plans, then implement it from there.'
        : 'Track them as plans to review and comment on them, then implement them from there.'}
    </Notice>
  );
}
