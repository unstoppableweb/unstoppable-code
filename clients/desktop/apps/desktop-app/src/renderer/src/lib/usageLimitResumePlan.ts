import type {
  AgentUsageOverview,
  UsageLimitedChatTarget,
  UsageLimitResumeInterruption,
} from '@canopy/desktop-shared/types';
import {
  classifyUsageLimitResume,
  nextUsageLimitResumeCheckAt,
  USAGE_RESUME_FRESHNESS_MS,
} from '@canopy/desktop-shared/lib/usage-limit-resume-outlook';

/**
 * What the usage-limit notice's Resume click does (CAN-7483). It is decided
 * by the interrupted provider account's usage, never by the prompt:
 *
 * - `explain`: usage for that account can't be checked; nothing is sent or
 *   scheduled.
 * - `check`: usage isn't known to be clear; schedule a usage check at
 *   `runAt` (the next check, not a promised send).
 * - `schedule`: every blocking window has a known future reset; schedule the
 *   ordinary timed resume at the latest one.
 * - `resume`: a fresh read for this interruption shows usage clear; resume
 *   once through the trusted handler, which checks again before it sends.
 */
export type UsageLimitResumePlan =
  | { kind: 'explain' }
  | { kind: 'check'; runAt: string }
  | { kind: 'schedule'; runAt: string }
  | { kind: 'resume' };

export function planUsageLimitResume({
  interruption,
  usage,
  refreshFailed,
  bannerResetAt,
  now,
}: {
  interruption: UsageLimitResumeInterruption | undefined;
  usage: AgentUsageOverview | undefined;
  refreshFailed: boolean;
  /** The notice's reset hint: a check time at most, never leave to send. */
  bannerResetAt: number | undefined;
  /** The decision time, taken after every awaited read. */
  now: number;
}): UsageLimitResumePlan {
  if (!interruption) return { kind: 'explain' };
  const summary = usage?.providers.find(
    (candidate) => candidate.provider === interruption.provider,
  );
  const outlook = classifyUsageLimitResume({
    interruption,
    summary,
    now,
    freshnessMs: USAGE_RESUME_FRESHNESS_MS,
    refreshFailed,
    // The renderer has no separate account identity. A summary without an
    // account can only reach a recheck, and a summary for another account is
    // refused by the classifier, so this never treats a replacement account
    // as the interrupted one.
    currentAccountEmail: summary?.accountEmail ?? interruption.accountEmail,
  });
  switch (outlook.kind) {
    case 'uncheckable':
      return { kind: 'explain' };
    case 'recheck':
      return {
        kind: 'check',
        runAt: nextUsageLimitResumeCheckAt({
          now,
          createdAt: now,
          ...(outlook.retryAt !== undefined
            ? { retryAt: outlook.retryAt }
            : {}),
          ...(bannerResetAt !== undefined ? { bannerResetAt } : {}),
        }),
      };
    case 'reset':
      return { kind: 'schedule', runAt: outlook.runAt };
    case 'clear':
      return { kind: 'resume' };
  }
}

/**
 * The interruption main recorded for this chat: its provider, the account it
 * hit the limit on, and the interrupted turn. `undefined` when main has none
 * it can check against (a legacy entry, a proxy account, or no entry).
 */
export async function readUsageLimitResumeInterruption(
  provider: UsageLimitResumeInterruption['provider'],
  target: UsageLimitedChatTarget,
): Promise<UsageLimitResumeInterruption | undefined> {
  const groups = await window.api.listUsageLimitedIdleChats({
    provider,
    includeUsageResumeInterruption: true,
  });
  for (const group of groups) {
    for (const chat of group.chats) {
      if (
        chat.projectId === target.projectId &&
        chat.worktreeId === target.worktreeId &&
        chat.chatId === target.chatId
      ) {
        return chat.usageResumeInterruption;
      }
    }
  }
  return undefined;
}

export function sameUsageLimitResumeInterruption(
  left: UsageLimitResumeInterruption | undefined,
  right: UsageLimitResumeInterruption | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.provider === right.provider &&
    left.detectedAt === right.detectedAt &&
    left.userMessageId === right.userMessageId &&
    left.accountEmail === right.accountEmail
  );
}
