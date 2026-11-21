import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  USAGE_RESUME_EXPIRED,
  USAGE_RESUME_UNCHECKABLE,
} from '@canopy/desktop-shared/lib/usage-limit-resume-outlook';

/**
 * Exact chat identity a usage-limit resume automation targets. `workspaceId`
 * is the automation action's workspace, which is the chat's project id.
 */
export interface ScheduledResumeChatKey {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/**
 * Whether `activity` is an enabled usage-limit resume for exactly this chat
 * that has not fired yet: its `nextRunAt` parses to a finite time strictly
 * after `now`. Missing, invalid, past, and exactly-current times do not
 * count, so a still-listed chat becomes resumable again once its scheduled
 * time passes or the schedule is cleared. Ordinary scheduled sends never
 * match.
 */
export function isPendingUsageLimitResume(
  activity: ScheduledActivity,
  target: ScheduledResumeChatKey,
  now: number,
): boolean {
  if (!activity.enabled) return false;
  const action = activity.action;
  if (action.type !== 'worktree_session_prompt') return false;
  if (action.purpose !== 'usage_limit_resume') return false;
  if (
    action.workspaceId !== target.workspaceId ||
    action.worktreeId !== target.worktreeId ||
    action.chatId !== target.chatId
  ) {
    return false;
  }
  // A usage check stays pending while enabled, even once its check time
  // passes: the scheduler re-arms or stops it, and it never fires as an
  // ordinary timed resume (CAN-7483).
  if (action.resumeWhen === 'provider_usage_clear') return true;
  if (!activity.nextRunAt) return false;
  const next = new Date(activity.nextRunAt).getTime();
  return Number.isFinite(next) && next > now;
}

/** Whether `activity` waits for provider usage to clear (CAN-7483). */
export function isUsageLimitResumeCheck(activity: ScheduledActivity): boolean {
  return (
    activity.action.type === 'worktree_session_prompt' &&
    activity.action.resumeWhen === 'provider_usage_clear'
  );
}

/** Why a usage check for this chat stopped without resuming it. */
export type StoppedUsageLimitCheckReason = 'expired' | 'unreadable';

/**
 * The newest usage check for exactly this chat and interruption that the
 * scheduler stopped with a failure, and why. A check bound to an earlier
 * interruption never matches, so an old failure can't reappear on a later
 * limit. Ineligible stops (the interruption moved on) are not reported.
 */
export function findStoppedUsageLimitCheck(
  activities: readonly ScheduledActivity[],
  target: ScheduledResumeChatKey,
  interruption: { detectedAt: number; userMessageId: string },
): StoppedUsageLimitCheckReason | null {
  let newest: { at: number; reason: StoppedUsageLimitCheckReason } | null =
    null;
  for (const activity of activities) {
    const action = activity.action;
    if (
      activity.enabled ||
      action.type !== 'worktree_session_prompt' ||
      action.resumeWhen !== 'provider_usage_clear' ||
      action.workspaceId !== target.workspaceId ||
      action.worktreeId !== target.worktreeId ||
      action.chatId !== target.chatId ||
      action.usageResumeInterruption?.detectedAt !== interruption.detectedAt ||
      action.usageResumeInterruption.userMessageId !==
        interruption.userMessageId ||
      activity.lastResult?.status !== 'failure'
    ) {
      continue;
    }
    const message = activity.lastResult.message;
    const reason: StoppedUsageLimitCheckReason | null =
      message === USAGE_RESUME_EXPIRED
        ? 'expired'
        : message === USAGE_RESUME_UNCHECKABLE
          ? 'unreadable'
          : null;
    if (reason === null) continue;
    const at = Date.parse(activity.lastResult.completedAt);
    if (newest === null || (Number.isFinite(at) && at > newest.at)) {
      newest = { at: Number.isFinite(at) ? at : 0, reason };
    }
  }
  return newest?.reason ?? null;
}

/** The first pending usage-limit resume for the chat, in list order. */
export function findPendingUsageLimitResume(
  activities: readonly ScheduledActivity[],
  target: ScheduledResumeChatKey,
  now: number,
): ScheduledActivity | undefined {
  return activities.find((activity) =>
    isPendingUsageLimitResume(activity, target, now),
  );
}

export function hasPendingUsageLimitResume(
  activities: readonly ScheduledActivity[],
  target: ScheduledResumeChatKey,
  now: number,
): boolean {
  return findPendingUsageLimitResume(activities, target, now) !== undefined;
}
