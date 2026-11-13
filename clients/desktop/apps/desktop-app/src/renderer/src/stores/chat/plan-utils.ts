// Plan-mode transforms and transient tracked-plan dispatch coordination.
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { ChatState } from './state';
import { restartClaudeTerminalForSettingsChange } from './claudeTerminalPrompt';
import type {
  AgentProviderType,
  ChatSendMessageRequest,
  PersistedChatBlock,
  PlanExitRequestEvent,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import type { TrackedPlanImplementationInput } from '@canopy/protocol/portal';
import { extractCandidatePaths } from '@canopy/desktop-shared/plan-detection-paths';
import { isPlanProposal } from '@canopy/desktop-shared/plan-review';
import { useActivityStore } from '../activityStore';
import { useGitHubStore } from '../githubStore';
import { reconcileTrackedPlans } from '@/lib/plans/reconcile-tracked-plans';
import type {
  ChatMessage,
  ChatTab,
  PendingPlanExit,
  WorktreeChatState,
} from './types';
import { chatBackendFor, reportUnlessUnavailable } from './backend';

type PlanDispatchTarget = Pick<
  TrackedPlanData,
  'projectId' | 'worktreeId' | 'id' | 'latestRevisionNumber'
>;
const pendingPlanDispatches = new Set<string>();
const planDispatchListeners = new Set<() => void>();
export const PLAN_DISPATCH_BUSY_MESSAGE =
  'An implementation is already in progress.';

function planDispatchKey(plan: PlanDispatchTarget): string {
  return `${plan.projectId}/${plan.worktreeId}/${plan.id}/${plan.latestRevisionNumber}`;
}

export function isPlanDispatching(plan: PlanDispatchTarget): boolean {
  return pendingPlanDispatches.has(planDispatchKey(plan));
}

export function subscribePlanDispatch(listener: () => void): () => void {
  planDispatchListeners.add(listener);
  return () => {
    planDispatchListeners.delete(listener);
  };
}

/** Claim both choices for the reviewed revision until admission finishes. */
export function beginPlanDispatch(
  plan: PlanDispatchTarget,
): (() => void) | undefined {
  const key = planDispatchKey(plan);
  if (pendingPlanDispatches.has(key)) return undefined;
  pendingPlanDispatches.add(key);
  for (const listener of planDispatchListeners) listener();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingPlanDispatches.delete(key);
    for (const listener of planDispatchListeners) listener();
  };
}

export function getPendingPlanExitSource(
  toolInput?: Record<string, unknown>,
): AgentProviderType {
  const src = toolInput?.source;
  if (src === 'codex') return 'codex';
  if (src === 'opencode') return 'opencode';
  if (src === 'cursor') return 'cursor';
  if (src === 'ollama') return 'ollama';
  return 'claude';
}

/**
 * A new implementation attempt's identity, snapshotted before dispatch. The
 * same user message id names the sent message and its durable link, so
 * main can register both in one admission and settle the link with that
 * exact turn's end.
 */
export function createTrackedPlanImplementation(
  planId: string,
  revisionNumber: number,
): TrackedPlanImplementationInput {
  return {
    planId,
    revisionNumber,
    userMessageId: `plan-implementation-${crypto.randomUUID()}`,
    startedAt: new Date().toISOString(),
  };
}

export function hasPendingTrackedPlanReview(
  tab: Pick<ChatTab, 'trackedPlanId' | 'trackedPlanReviewStatus'> | undefined,
): boolean {
  return (
    Boolean(tab?.trackedPlanId) && tab?.trackedPlanReviewStatus === 'pending'
  );
}

/**
 * A new turn retires this tab's waiting plan request: the same eligibility
 * main applies when it accepts the turn (CAN-5431). Proposal exits keep their
 * own lifecycle.
 */
export function retiresSupersededPlanExit(
  tab: Pick<ChatTab, 'pendingPlanExit' | 'trackedPlanSource'>,
): boolean {
  return (
    tab.pendingPlanExit !== undefined &&
    !isPlanProposal({
      ...tab.pendingPlanExit,
      source: tab.pendingPlanExit.source ?? tab.trackedPlanSource,
    })
  );
}

export function applyPlanExitToTab(
  tab: ChatTab,
  event: PlanExitRequestEvent,
): ChatTab {
  const nextTab: ChatTab = {
    ...tab,
    pendingPlanExit: event.toolInput,
    pendingPlanExitRequestId: event.requestId,
    pendingSystemInstructions: event.pendingSystemInstructions?.length
      ? event.pendingSystemInstructions
      : undefined,
    trackedPlanReviewStatus: 'pending',
    attentionDismissedAt: undefined,
  };

  if (event.planId) {
    nextTab.trackedPlanId = event.planId;
  }
  if (event.source) {
    nextTab.trackedPlanSource = event.source;
  }
  if (event.revisionNumber !== undefined) {
    nextTab.latestRevisionNumber = event.revisionNumber;
  }

  return nextTab;
}

export function applyProposalTrackedPlanToTab(
  tab: ChatTab,
  source: 'codex' | 'cursor',
  trackedPlanId: string,
  latestRevisionNumber: number,
  pendingSystemInstructions?: ChatSendMessageRequest['pendingSystemInstructions'],
): ChatTab {
  return {
    ...tab,
    trackedPlanId,
    trackedPlanSource: source,
    trackedPlanReviewStatus: 'pending',
    hasOutstandingProposal: true,
    latestRevisionNumber,
    pendingSystemInstructions: pendingSystemInstructions?.length
      ? pendingSystemInstructions
      : undefined,
    attentionDismissedAt: undefined,
  };
}

export function applyApprovedTrackedPlanToTab(tab: ChatTab): ChatTab {
  return {
    ...tab,
    planMode: false,
    proposalMode: 'optional',
    pendingPlanExit: undefined,
    pendingPlanExitRequestId: undefined,
    trackedPlanReviewStatus: 'approved',
    hasOutstandingProposal: false,
  };
}

export function applyExecutedTrackedPlanToTab(tab: ChatTab): ChatTab {
  return applyApprovedTrackedPlanToTab(tab);
}

export function applyDismissedTrackedPlanToTab(tab: ChatTab): ChatTab {
  return {
    ...tab,
    pendingPlanExit: undefined,
    pendingPlanExitRequestId: undefined,
    planMode: false,
    proposalMode: 'optional',
    trackedPlanReviewStatus: tab.trackedPlanId
      ? 'dismissed'
      : tab.trackedPlanReviewStatus,
    hasOutstandingProposal: false,
  };
}

export function clearPendingPlanExitForChat(
  pendingPlanExits: Record<string, PendingPlanExit>,
  projectId: string,
  worktreeId: string,
  chatId: string,
): Record<string, PendingPlanExit> {
  let changed = false;
  const nextPending = { ...pendingPlanExits };

  for (const [id, entry] of Object.entries(nextPending)) {
    if (
      entry.projectId === projectId &&
      entry.worktreeId === worktreeId &&
      entry.chatId === chatId
    ) {
      delete nextPending[id];
      changed = true;
    }
  }

  return changed ? nextPending : pendingPlanExits;
}

export function clearPendingSystemInstructionsFromTab(tab: ChatTab): ChatTab {
  if (!tab.pendingSystemInstructions?.length) {
    return tab;
  }
  const next = { ...tab };
  delete next.pendingSystemInstructions;
  return next;
}

export function consumePendingSystemInstructionsFromTab(
  tab: ChatTab,
  instructionIds: readonly string[],
): ChatTab {
  if (!tab.pendingSystemInstructions?.length || instructionIds.length === 0) {
    return tab;
  }
  const consumedIds = new Set(instructionIds);
  const remaining = tab.pendingSystemInstructions.filter(
    (instruction) => !consumedIds.has(instruction.id),
  );
  if (remaining.length === tab.pendingSystemInstructions.length) {
    return tab;
  }
  const next = { ...tab };
  if (remaining.length > 0) {
    next.pendingSystemInstructions = remaining;
  } else {
    delete next.pendingSystemInstructions;
  }
  return next;
}

/**
 * Collect all blocks from the most recent assistant turn. Finds the last
 * `role === 'user'` message and returns the blocks of every message after it.
 * Returns an empty array when there are no messages or no messages after the
 * last user message.
 */
export function collectLastTurnBlocks(
  messages: ChatMessage[],
): PersistedChatBlock[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0 || lastUserIndex >= messages.length - 1) {
    return [];
  }
  const blocks: PersistedChatBlock[] = [];
  for (let i = lastUserIndex + 1; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg) {
      blocks.push(...msg.blocks);
    }
  }
  return blocks;
}

/**
 * Fire-and-forget plan-detection scan after a completed assistant turn.
 * Extracts candidate paths from the last turn's blocks and notifies the
 * activity store. Best-effort: errors are swallowed so a scan failure
 * never interrupts turn handling.
 */
export function triggerPlanDetectionScan(
  tab: ChatTab,
  projectId: string,
  worktreeId: string,
): void {
  const blocks = collectLastTurnBlocks(tab.messages);
  const candidatePaths = extractCandidatePaths(blocks);
  if (candidatePaths.length === 0) {
    return;
  }
  void useActivityStore
    .getState()
    .scanDetectedPlans(projectId, worktreeId, tab.id, candidatePaths)
    .catch(() => {
      // best-effort — a scan failure must not interrupt turn handling
    });
}

export function findPendingPlanExitRequestIdForChat(
  pendingPlanExits: Record<string, PendingPlanExit>,
  projectId: string,
  worktreeId: string,
  chatId: string,
): string | undefined {
  for (const entry of Object.values(pendingPlanExits)) {
    if (
      entry.projectId === projectId &&
      entry.worktreeId === worktreeId &&
      entry.chatId === chatId
    ) {
      return entry.requestId;
    }
  }

  return undefined;
}

export interface PlanExitTarget {
  pending: PendingPlanExit | undefined;
  projectId: string;
  worktreeId: string;
  key: string;
  wc: WorktreeChatState;
  targetChatId: string;
  tab: ChatTab;
}

/**
 * Outcome of synchronizing a chat's review decision into its tracked plan.
 * `reconcile-failed` still means the update committed: the returned record is
 * in the activity store and only the follow-up list refresh failed.
 */
export type TrackedPlanReviewSyncResult =
  | 'skipped'
  | 'updated'
  | 'update-failed'
  | 'reconcile-failed';

function notifyTrackedPlanReviewSyncFailed(
  target: Pick<PlanExitTarget, 'projectId' | 'worktreeId' | 'targetChatId'>,
  reviewStatus: 'approved' | 'dismissed',
  retry: () => void,
): void {
  useGitHubStore
    .getState()
    .addToast(
      reviewStatus === 'approved'
        ? "Couldn't save the plan's approval. Select to refresh status."
        : "Couldn't save the plan's dismissal. Select to refresh status.",
      'error',
      retry,
      {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.targetChatId,
      },
    );
}

/**
 * Persist a chat's review decision on its tracked plan, then reconcile the
 * worktree's plan list. The returned record is applied before the list read
 * starts, and list requests already in flight cannot restore the earlier
 * status. Never rejects; failures resolve as a result and surface a notice.
 */
export async function updateTrackedPlanReview(
  target: Pick<PlanExitTarget, 'projectId' | 'worktreeId' | 'targetChatId'> & {
    tab: Pick<PlanExitTarget['tab'], 'trackedPlanId'>;
  },
  reviewStatus: 'approved' | 'dismissed',
): Promise<TrackedPlanReviewSyncResult> {
  const planId = target.tab.trackedPlanId;
  if (!planId) {
    return 'skipped';
  }

  const now = new Date().toISOString();
  let plan: TrackedPlanData | null = null;
  try {
    plan = await window.api.activity.plans.update({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      planId,
      chatId: target.targetChatId,
      initiationSource: 'user',
      reviewStatus,
      approvedAt: reviewStatus === 'approved' ? now : null,
      dismissedAt: reviewStatus === 'dismissed' ? now : null,
    });
  } catch {
    plan = null;
  }
  if (
    !plan ||
    plan.id !== planId ||
    plan.projectId !== target.projectId ||
    plan.worktreeId !== target.worktreeId ||
    plan.reviewStatus !== reviewStatus
  ) {
    notifyTrackedPlanReviewSyncFailed(target, reviewStatus, () => {
      // A newer revision may exist by the time this notice is selected.
      // Recovery reads current authority instead of replaying an old decision.
      void reconcileTrackedPlans({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.targetChatId,
      });
    });
    return 'update-failed';
  }

  const activity = useActivityStore.getState();
  activity.commitTrackedPlanUpdate(plan);
  const reconciled = await reconcileTrackedPlans({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.targetChatId,
  });
  return reconciled ? 'updated' : 'reconcile-failed';
}

export function getPlanExitTarget(
  requestId: string,
  state: ChatState,
): PlanExitTarget | null {
  const pending = state.pendingPlanExits[requestId];
  let fallbackSelection = state.selectedWorktree;
  let restoredChatId: string | undefined;
  if (!pending && requestId) {
    const matches = Object.entries(state.worktreeChats).flatMap(
      ([key, chats]) =>
        chats.tabs
          .filter((tab) => tab.pendingPlanExitRequestId === requestId)
          .map((tab) => ({ key, chatId: tab.id })),
    );
    const [match] = matches;
    if (matches.length !== 1 || !match) return null;
    const [projectId, worktreeId] = match.key.split('/');
    if (!projectId || !worktreeId) return null;
    fallbackSelection = { projectId, worktreeId };
    restoredChatId = match.chatId;
  }
  const projectId = pending?.projectId ?? fallbackSelection?.projectId;
  const worktreeId = pending?.worktreeId ?? fallbackSelection?.worktreeId;
  if (!projectId || !worktreeId) {
    return null;
  }

  const key = `${projectId}/${worktreeId}`;
  const wc = state.worktreeChats[key];
  if (!wc) {
    return null;
  }

  const targetChatId = pending?.chatId ?? restoredChatId ?? wc.activeTabId;
  const tab = wc.tabs.find((entry) => entry.id === targetChatId);
  if (!tab) {
    return null;
  }
  if (
    pending &&
    tab.pendingPlanExitRequestId !== undefined &&
    tab.pendingPlanExitRequestId !== pending.requestId
  ) {
    return null;
  }

  return { pending, projectId, worktreeId, key, wc, targetChatId, tab };
}

export function notifyPlanModeDisabled(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  if (projectId === STANDALONE_CHAT_PROJECT_ID) {
    return;
  }

  void chatBackendFor({ projectId })
    .chat.togglePlanMode({
      projectId,
      worktreeId,
      chatId,
      enabled: false,
    })
    .catch(reportUnlessUnavailable);
  // A live managed terminal only honors the new permission mode after a
  // relaunch with fresh CLI args.
  void restartClaudeTerminalForSettingsChange(
    { projectId, worktreeId },
    chatId,
  ).catch(() => undefined);
}

export function applyPlanExitTabReviewState(
  state: ChatState,
  target: PlanExitTarget,
  applyTab: (tab: ChatTab) => ChatTab,
): Partial<ChatState> {
  const currentWc = state.worktreeChats[target.key];
  if (!currentWc) return state;

  const nextPending = clearPendingPlanExitForChat(
    state.pendingPlanExits,
    target.projectId,
    target.worktreeId,
    target.targetChatId,
  );

  const updatedTabs = currentWc.tabs.map((entry) =>
    entry.id === target.targetChatId ? applyTab(entry) : entry,
  );
  const updated = { ...currentWc, tabs: updatedTabs };
  return {
    pendingPlanExits: nextPending,
    worktreeChats: { ...state.worktreeChats, [target.key]: updated },
  };
}
