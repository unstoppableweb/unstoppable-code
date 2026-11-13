import type {
  AccountChangeResumeReason,
  AgentProviderType,
  AgentUsageOverview,
  ScheduledActivity,
  UsageLimitedChatTarget,
  UsageLimitedSessionGroup,
  UsageLimitedSessionItem,
  UsageLimitedSessionTarget,
} from '@canopy/desktop-shared/types';
import {
  EMPTY_RESUME_READINESS_SUMMARY,
  sessionResumeReadiness,
  summarizeResumeReadiness,
  type ResumeReadinessSummary,
  type SessionResumeReadiness,
} from '@/lib/usage-limit/resume-availability';
import { hasPendingUsageLimitResume } from './scheduledUsageLimitResume';

/**
 * Display and destination details of one interrupted session, so Home can
 * name a single entry instead of only counting it. Readiness is the same
 * value the summary counts.
 */
export type InterruptedSessionEntry =
  | {
      readonly key: string;
      readonly kind: 'chat';
      readonly title: string;
      /** The listing group's workspace, when it has one. */
      readonly workspaceId?: string;
      readonly workspaceName: string;
      readonly target: UsageLimitedChatTarget;
      /** Registry worktree display name; empty for cowork chats. */
      readonly worktreeName: string;
      readonly readiness: SessionResumeReadiness;
    }
  | {
      readonly key: string;
      readonly kind: 'pipeline';
      readonly title: string;
      readonly workspaceId?: string;
      readonly workspaceName: string;
      readonly executionId: string;
      readonly readiness: SessionResumeReadiness;
    };

/**
 * Compact view of every idle interrupted session the app knows about —
 * usage limits, authentication failures, and application stops, across all
 * providers — as returned by `listUsageLimitedIdleSessions({})`.
 */
export interface InterruptedSessionsSummary {
  count: number;
  /** Sessions that can resume now versus those waiting on a usage reset. */
  readiness: ResumeReadinessSummary;
  /**
   * Order-independent identity of the interrupted set and each session's
   * readiness. Two summaries with the same signature describe the same
   * sessions in the same states, which is what a dismissal is keyed to: the
   * Home banner stays hidden while the set is unchanged and returns as soon
   * as a session appears, leaves, or changes between ready and waiting.
   * Reset times are left out so the passing clock never resurrects it.
   */
  signature: string;
  /** Every counted session, in key order. Display only; not in the signature. */
  sessions: readonly InterruptedSessionEntry[];
}

export const EMPTY_INTERRUPTED_SESSIONS: InterruptedSessionsSummary = {
  count: 0,
  readiness: EMPTY_RESUME_READINESS_SUMMARY,
  signature: '',
  sessions: [],
};

/** Full target identity, including a pipeline's provider-scoped reason set. */
export function interruptedSessionKey(
  session: UsageLimitedSessionItem | UsageLimitedSessionTarget,
): string {
  return session.kind === 'chat'
    ? `chat:${session.projectId}/${session.worktreeId}/${session.chatId}`
    : `pipeline:${session.executionId}/${JSON.stringify([...session.statusReasonIds].sort())}`;
}

/**
 * All-provider listings may combine a pipeline's reasons from several
 * providers under its first provider. Resolve those listed reasons before
 * claiming readiness, so each target can be gated and scheduled independently.
 * Single-reason targets are already unambiguous. This runs only on listing,
 * never on usage changes or readiness clock ticks.
 */
export async function resolveInterruptedSessionProviders(
  groups: UsageLimitedSessionGroup[],
): Promise<UsageLimitedSessionGroup[]> {
  const resolved = await Promise.all(
    groups.map(async (group) => ({
      ...group,
      sessions: (
        await Promise.all(
          group.sessions.map(async (session) => {
            if (session.kind === 'chat' || session.statusReasonIds.length < 2)
              return [session];
            try {
              const result = await window.pipelines.getExecution(
                session.executionId,
              );
              if (!result.success || !result.data)
                throw new Error('Pipeline interruption unavailable');
              const reasons = result.data.status_reasons ?? [];
              const byProvider = new Map<
                AgentProviderType | undefined,
                string[]
              >();
              for (const id of session.statusReasonIds) {
                const reason = reasons.find((candidate) => candidate.id === id);
                if (!reason && result.data.shutdown_checkpoint?.id !== id) {
                  throw new Error('Pipeline interruption unavailable');
                }
                const provider = reason?.provider;
                const ids = byProvider.get(provider) ?? [];
                ids.push(id);
                byProvider.set(provider, ids);
              }
              if (byProvider.size < 2) return [session];
              return Array.from(byProvider, ([provider, statusReasonIds]) => {
                const scopedReasons = reasons.filter((reason) =>
                  statusReasonIds.includes(reason.id),
                );
                const resumeReasons = scopedReasons.map(
                  (reason): AccountChangeResumeReason =>
                    reason.kind === 'provider_authentication_required'
                      ? 'authentication'
                      : reason.kind === 'provider_sign_in'
                        ? 'provider_sign_in'
                        : reason.kind === 'app_shutdown'
                          ? 'app_shutdown'
                          : 'usage_limit',
                );
                // A shutdown checkpoint has no provider or reset of its own.
                // Keep it neutral instead of attributing another row's data.
                if (
                  result.data?.shutdown_checkpoint &&
                  statusReasonIds.includes(result.data.shutdown_checkpoint.id)
                ) {
                  resumeReasons.push('app_shutdown');
                }
                const resetTimes = scopedReasons
                  .map((reason) =>
                    reason.resets_at ? Date.parse(reason.resets_at) : NaN,
                  )
                  .filter(Number.isFinite);
                return {
                  ...session,
                  provider,
                  statusReasonIds,
                  resumeReasons: Array.from(new Set(resumeReasons)),
                  resetsAt:
                    resetTimes.length > 0 ? Math.max(...resetTimes) : undefined,
                  pausedStepCount:
                    scopedReasons.length > 0
                      ? new Set(
                          scopedReasons.map((reason) =>
                            reason.source
                              ? `${reason.source.job_id}.${reason.source.step_id}`
                              : reason.id,
                          ),
                        ).size
                      : session.pausedStepCount,
                  modelLabels: Array.from(
                    new Set(
                      scopedReasons.flatMap((reason) =>
                        reason.model ? [reason.model] : [],
                      ),
                    ),
                  ),
                };
              });
            } catch {
              // An execution can disappear or change between the listing and
              // this read. Retry that ambiguous target on the next listing,
              // while keeping every successfully resolved session available.
              return [];
            }
          }),
        )
      ).flat(),
    })),
  );
  return resolved.filter((group) => group.sessions.length > 0);
}

/**
 * Drop chats that already have a pending usage-limit resume automation, so
 * Home offers an immediate resume only for sessions nothing will resume on
 * its own. Pipelines are never excluded. Preserves group and session order,
 * never mutates `groups`, and removes groups left empty. The registry entry
 * itself stays listed; this only narrows what Home advertises.
 *
 * `retainKeys` keeps the named sessions listed even while scheduled; the
 * resume dialog passes the chats it scheduled in its current opening so their
 * confirmation stays visible. Home's count and banner never pass it.
 */
export function excludeScheduledResumeSessions(
  groups: UsageLimitedSessionGroup[],
  activities: readonly ScheduledActivity[],
  now: number,
  retainKeys?: ReadonlySet<string>,
): UsageLimitedSessionGroup[] {
  return groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter(
        (session) =>
          session.kind !== 'chat' ||
          retainKeys?.has(interruptedSessionKey(session)) === true ||
          !hasPendingUsageLimitResume(
            activities,
            {
              workspaceId: session.projectId,
              worktreeId: session.worktreeId,
              chatId: session.chatId,
            },
            now,
          ),
      ),
    }))
    .filter((group) => group.sessions.length > 0);
}

/**
 * Summarize the listed sessions against the provider usage snapshot at
 * `nowMs`. Without a snapshot every session counts as ready, matching the
 * Usage card's rule for missing data.
 */
export function summarizeInterruptedSessions(
  groups: UsageLimitedSessionGroup[],
  usage?: AgentUsageOverview,
  nowMs: number = Date.now(),
): InterruptedSessionsSummary {
  const entries = new Map<string, InterruptedSessionEntry>();
  for (const group of groups) {
    for (const session of group.sessions) {
      const key = interruptedSessionKey(session);
      entries.set(
        key,
        interruptedSessionEntry(
          key,
          session,
          group,
          sessionResumeReadiness(session, usage, nowMs),
        ),
      );
    }
  }
  if (entries.size === 0) {
    return EMPTY_INTERRUPTED_SESSIONS;
  }
  const sessions = Array.from(entries.values()).sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  const signature = sessions
    .map(({ key, readiness }) =>
      readiness.state === 'waiting' ? `${key}\twaiting` : key,
    )
    .sort()
    .join('\n');
  return {
    count: entries.size,
    readiness: summarizeResumeReadiness(
      sessions.map(({ key, kind, readiness }) => ({ key, kind, readiness })),
    ),
    signature,
    sessions,
  };
}

function interruptedSessionEntry(
  key: string,
  session: UsageLimitedSessionItem,
  group: UsageLimitedSessionGroup,
  readiness: SessionResumeReadiness,
): InterruptedSessionEntry {
  const workspace = {
    ...(group.workspaceId !== undefined
      ? { workspaceId: group.workspaceId }
      : {}),
    workspaceName: group.workspaceName,
  };
  return session.kind === 'chat'
    ? {
        key,
        kind: 'chat',
        title: session.chatTitle,
        ...workspace,
        target: {
          projectId: session.projectId,
          worktreeId: session.worktreeId,
          chatId: session.chatId,
        },
        worktreeName: session.worktreeName,
        readiness,
      }
    : {
        key,
        kind: 'pipeline',
        title: session.pipelineName,
        ...workspace,
        executionId: session.executionId,
        readiness,
      };
}

/**
 * The banner shows whenever something is interrupted, unless the user
 * dismissed exactly this interrupted set. An all-waiting set still shows so
 * the user can review it and schedule resumes.
 */
export function shouldShowInterruptedSessionsBanner(
  summary: InterruptedSessionsSummary,
  dismissedSignature: string | null,
): boolean {
  return summary.count > 0 && summary.signature !== dismissedSignature;
}
