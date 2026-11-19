import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { planModeTrackedPlans } from '../canopy-runtime/plan-host-writers';

export type PlanModeSessionPlans = Map<
  string,
  { planId: string; revisionNumber: number }
>;

function extractPlanText(input: Record<string, unknown>): string {
  return typeof input.plan === 'string'
    ? input.plan
    : JSON.stringify(input, null, 2);
}

export async function upsertPlanModeTrackedPlan(
  sessions: PlanModeSessionPlans,
  sessionKey: string,
  projectId: string,
  worktreeId: string,
  chatId: string,
  source: 'claude' | 'ollama',
  input: Record<string, unknown>,
): Promise<TrackedPlanData> {
  let existing = sessions.get(sessionKey);
  // A restored pending review still names the plan being revised. Read through
  // the canonical chat boundary; a new/approved/dismissed plan must not inherit
  // that identity or its revision count (CAN-5431).
  if (!existing) {
    const file = await readChatTabsFile(projectId, worktreeId, { chatIds: [] });
    const tab = file.tabs.find((entry) => entry.id === chatId);
    if (
      tab?.planMode === true &&
      tab.trackedPlanSource === source &&
      tab.trackedPlanReviewStatus === 'pending' &&
      tab.trackedPlanId
    ) {
      existing = {
        planId: tab.trackedPlanId,
        revisionNumber: tab.latestRevisionNumber ?? 1,
      };
    }
  }
  const planText = extractPlanText(input);

  if (existing) {
    const updated = await planModeTrackedPlans.updateTrackedPlan({
      projectId,
      worktreeId,
      planId: existing.planId,
      content: planText,
      source,
      reviewStatus: 'pending',
      approvedAt: null,
      dismissedAt: null,
      chatId,
      initiationSource: 'user',
    });
    if (updated) {
      sessions.set(sessionKey, {
        planId: updated.id,
        revisionNumber: updated.latestRevisionNumber,
      });
      return updated;
    }
  }

  const created = await planModeTrackedPlans.createTrackedPlan({
    projectId,
    worktreeId,
    source,
    content: planText,
    reviewStatus: 'pending',
    chatId,
    initiationSource: 'user',
  });
  sessions.set(sessionKey, {
    planId: created.id,
    revisionNumber: created.latestRevisionNumber,
  });
  return created;
}
