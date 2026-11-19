import { randomUUID } from 'node:crypto';
import type { PlanExitRequestEvent } from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from '../lib/main-process-logging';

/**
 * Commit a provider plan proposal before its renderer notification. The local
 * dynamic import intentionally breaks the session-manager/chat-state-service
 * cycle: provider sessions call this seam, while chat-state reconciliation
 * lazily consults the session manager for live-host state.
 */
export async function commitPendingPlanExit(
  event: PlanExitRequestEvent,
): Promise<void> {
  try {
    const { getChatStateService } = await import('./chat-state-service');
    await getChatStateService().commitPlanExit(event);
  } catch (error) {
    logMainProcessWarn(
      `[chat-state] Failed to persist plan exit ${event.requestId}`,
      error,
    );
    throw error;
  }
}

interface OpenCodePlanProposalRequest {
  projectId: string;
  worktreeId: string;
  chatId: string;
  plan: string;
  userMessageId?: string;
  isCurrent: () => boolean;
  /** Shows the committed plan-exit request; the session's interface port. */
  presentPlanExit: (event: PlanExitRequestEvent) => void;
}

/** Publish only after transcript drain and a checked canonical review commit. */
export async function publishOpenCodePlanProposal(
  request: OpenCodePlanProposalRequest,
): Promise<void> {
  if (!request.isCurrent()) return;
  const { isCoworkWorkspace } = await import('../lib/workspace-registry');
  if (isCoworkWorkspace(request.projectId)) return;
  const { planModeTrackedPlans } =
    await import('../canopy-runtime/plan-host-writers');
  const { buildPlanFileSystemInstruction } =
    await import('../lib/plan-system-instructions');
  const { getAttentionTracker } = await import('./attention-tracker');
  const { getChatStateService } = await import('./chat-state-service');
  const service = getChatStateService();
  const scope = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  };
  const state = await service.getState(scope);
  const tab = state.tabsFile.tabs.find((entry) => entry.id === request.chatId);
  if (!tab || !tab.planMode || !request.isCurrent()) return;
  const existingPlanId =
    tab.trackedPlanSource === 'opencode' &&
    tab.trackedPlanReviewStatus !== 'dismissed'
      ? tab.trackedPlanId
      : undefined;
  const planRequest = {
    ...scope,
    chatId: request.chatId,
    source: 'opencode' as const,
    content: request.plan,
    reviewStatus: 'pending' as const,
    initiationSource: 'user' as const,
  };
  // The plan and chat stores do not share a transaction. Remove the old
  // approval before changing its file, so cancellation cannot approve content
  // that was never published for review. A failed save stays read-only.
  if (
    existingPlanId &&
    !(await service.retirePlanReview({
      ...scope,
      chatId: request.chatId,
      planId: existingPlanId,
      expectedUserMessageId: request.userMessageId,
      isCurrent: request.isCurrent,
    }))
  )
    return;
  const updated = existingPlanId
    ? await planModeTrackedPlans.updateTrackedPlan({
        ...planRequest,
        planId: existingPlanId,
        approvedAt: null,
        dismissedAt: null,
      })
    : null;
  const plan =
    updated ?? (await planModeTrackedPlans.createTrackedPlan(planRequest));
  const instruction = await buildPlanFileSystemInstruction({
    ...scope,
    planId: plan.id,
  });
  if (!request.isCurrent()) return;
  const event: PlanExitRequestEvent = {
    ...scope,
    chatId: request.chatId,
    requestId: randomUUID(),
    source: 'opencode',
    reviewMode: 'proposal',
    planId: plan.id,
    revisionNumber: plan.latestRevisionNumber,
    toolInput: { plan: request.plan, source: 'opencode' },
    ...(instruction ? { pendingSystemInstructions: [instruction] } : {}),
  };
  const applied = await service.commitPlanExit(event, {
    requirePlanMode: true,
    expectedUserMessageId: request.userMessageId,
    isCurrent: request.isCurrent,
  });
  if (!applied) return;
  request.presentPlanExit(event);
  getAttentionTracker().mark({
    ...scope,
    chatId: request.chatId,
    state: 'needs_input',
    reason: 'plan_review',
    sourceId: 'plan-review',
  });
}
