import {
  isRemoteControlPlanReviewSource,
  type RemoteControlChatPlanReview,
} from '@canopy/protocol/remote-control/shell';

/** The tab fields the plan-review projection reads. */
export interface PlanReviewProjectionTab {
  readonly planMode?: boolean;
  readonly pendingPlanExit?: Readonly<Record<string, unknown>> | null;
  readonly pendingPlanExitRequestId?: string | null;
  readonly trackedPlanId?: string | null;
  readonly trackedPlanSource?: string | null;
  readonly trackedPlanReviewStatus?: string | null;
  readonly latestRevisionNumber?: number | null;
}

/**
 * The pending plan review a Remote Control controller may answer, or `null`.
 *
 * Projected only for a worktree chat in plan mode whose pending plan exit
 * names an accepted source equal to its tracked plan's source, with a pending
 * review and every id the approval must echo. Fails closed: a missing source
 * is never read as Claude (unlike the renderer's fallback), a Codex proposal
 * the renderer hasn't linked to a tracked plan stays hidden until it does,
 * and Cursor and Antigravity stay unprojected.
 */
export function projectRemoteControlPlanReview(
  surface: string,
  tab: PlanReviewProjectionTab,
): RemoteControlChatPlanReview | null {
  if (surface !== 'worktree' || tab.planMode !== true) return null;
  const source = tab.pendingPlanExit?.source;
  if (!isRemoteControlPlanReviewSource(source)) return null;
  if (tab.trackedPlanSource !== source) return null;
  if (tab.trackedPlanReviewStatus !== 'pending') return null;
  const requestId = tab.pendingPlanExitRequestId;
  const planId = tab.trackedPlanId;
  const revisionNumber = tab.latestRevisionNumber;
  if (!requestId || !planId) return null;
  if (revisionNumber === undefined || revisionNumber === null) return null;
  return { source, requestId, planId, revisionNumber };
}
