import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AutomationMutationResponse,
  ScheduledActivity,
  UsageLimitedChatSessionItem,
  UsageLimitedPipelineSessionItem,
  UsageLimitedSessionItem,
} from '@canopy/desktop-shared/types';
import type { PipelineStatusReason } from '@canopy/execution-engine/types/pipeline';
import { computeUsageLimitResumePrompt } from '@canopy/execution-engine/lib/usage-limit-resume-prompt';
import { getModelCatalogProviderLabel } from '@canopy/ui-shared';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useChatStore } from '@/stores/chatStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import {
  selectPipelineUsageLimitResumeAt,
  selectProviderUsageLimitResumeAt,
} from '@/lib/claudeUsageLimitResume';
import { sessionResumeReadiness } from '@/lib/usage-limit/resume-availability';
import { interruptedSessionKey } from '@/components/usage-limit/sessionRowModel';

/**
 * A resume created by one scheduling call. Undo deletes only this activity,
 * and only while it is still a pending resume for `target`.
 */
export interface OwnedInterruptedResume {
  /** The created activity, as returned before any store broadcast. */
  activity: ScheduledActivity;
  /** The resolved target; a pipeline's includes every applicable reason. */
  target: UsageLimitedSessionItem;
}

export type ScheduleInterruptedResumeResult =
  /**
   * `owned` is null when an existing schedule already covered the session,
   * or when the store did not return a newly created matching activity.
   */
  | { kind: 'scheduled'; owned: OwnedInterruptedResume | null }
  /** The limit cleared during the refresh; the session can resume now. */
  | { kind: 'cleared' }
  /** Another schedule or undo for this session is still in flight. */
  | { kind: 'busy' }
  | { kind: 'failed'; error: string };

export type UnscheduleInterruptedResumeResult =
  | { kind: 'removed' }
  /** The owned activity is gone or no longer a pending resume; nothing ran. */
  | { kind: 'missing' }
  | { kind: 'busy' }
  | { kind: 'failed'; error: string };

export type InterruptedResumeOperation = 'schedule' | 'undo';

const NO_RESET_ERROR =
  'The reset time isn’t available yet. Resume this session after usage resets.';
const NO_ACTIVITIES: ScheduledActivity[] = [];
const SCHEDULE_ERROR = 'Couldn’t schedule this resume. Try again.';
const UNDO_ERROR = 'Couldn’t undo this scheduled resume. Try again.';

function isFutureRun(activity: ScheduledActivity, nowMs: number): boolean {
  if (
    !activity.enabled ||
    !activity.nextRunAt ||
    activity.schedule.kind !== 'one_time' ||
    activity.lastResult
  )
    return false;
  const next = Date.parse(activity.nextRunAt);
  return Number.isFinite(next) && next > nowMs;
}

/**
 * An enabled, pending one-time resume for exactly this session: the same
 * chat, or the same pipeline execution, provider, and paused reasons.
 */
export function matchesInterruptedResumeActivity(
  activity: ScheduledActivity,
  session: UsageLimitedSessionItem,
  nowMs: number,
): boolean {
  if (!isFutureRun(activity, nowMs)) return false;
  const action = activity.action;
  if (session.kind === 'chat') {
    return (
      action.type === 'worktree_session_prompt' &&
      action.purpose === 'usage_limit_resume' &&
      action.workspaceId === session.projectId &&
      action.worktreeId === session.worktreeId &&
      action.chatId === session.chatId
    );
  }
  const expectedIds = [...session.statusReasonIds].sort();
  return (
    action.type === 'pipeline_execution_resume' &&
    action.purpose === 'usage_limit_resume' &&
    action.executionId === session.executionId &&
    action.provider === session.provider &&
    action.statusReasonIds.length > 0 &&
    action.statusReasonIds.length === session.statusReasonIds.length &&
    [...action.statusReasonIds]
      .sort()
      .every((id, index) => id === expectedIds[index])
  );
}

/** This session's first matching pending resume activity, if any. */
export function findScheduledInterruptedResumeActivity(
  activities: readonly ScheduledActivity[],
  session: UsageLimitedSessionItem | null,
  nowMs: number,
): ScheduledActivity | null {
  if (!session) return null;
  return (
    activities.find((activity) =>
      matchesInterruptedResumeActivity(activity, session, nowMs),
    ) ?? null
  );
}

/** The run time of this session's matching scheduled resume, if any. */
export function findScheduledInterruptedResume(
  activities: readonly ScheduledActivity[],
  session: UsageLimitedSessionItem | null,
  nowMs: number,
): string | null {
  return (
    findScheduledInterruptedResumeActivity(activities, session, nowMs)
      ?.nextRunAt ?? null
  );
}

/**
 * Delete exactly the owned activity, after confirming from the latest store
 * state that it is still a pending resume for its recorded target. A missing
 * or changed activity is never replaced by another match. This cancels a
 * pending schedule; it cannot roll back a resume that already started.
 *
 * `awaitingListing` means the store has not listed the activity since its
 * create response; the response then stands in for it until the store does.
 */
export async function deleteOwnedInterruptedResume(
  owned: OwnedInterruptedResume,
  { awaitingListing = false }: { awaitingListing?: boolean } = {},
): Promise<UnscheduleInterruptedResumeResult> {
  const store = useAutomationsStore.getState();
  const current =
    store.activities.find((activity) => activity.id === owned.activity.id) ??
    (awaitingListing ? owned.activity : undefined);
  if (
    !current ||
    !matchesInterruptedResumeActivity(current, owned.target, Date.now())
  ) {
    return { kind: 'missing' };
  }
  const response = await store.deleteActivity(current.id);
  return response.ok
    ? { kind: 'removed' }
    : { kind: 'failed', error: response.error || UNDO_ERROR };
}

interface PipelineResumeDetails {
  usageReasons: PipelineStatusReason[];
  statusReasonIds: string[];
}

async function loadPipelineUsageReasons(
  session: UsageLimitedPipelineSessionItem,
): Promise<PipelineResumeDetails | null> {
  const result = await window.pipelines.getExecution(session.executionId);
  if (!result.success || !result.data) return null;
  const reasons = result.data.status_reasons ?? [];
  // A stale or incomplete execution must not authorize a partial resume.
  if (
    session.statusReasonIds.some(
      (id) =>
        !reasons.some((reason) => reason.id === id) &&
        result.data?.shutdown_checkpoint?.id !== id,
    )
  )
    return null;
  const applicable = reasons.filter(
    (reason) =>
      reason.provider === session.provider &&
      (reason.kind === 'provider_usage_limit' ||
        reason.kind === 'provider_authentication_required' ||
        reason.kind === 'provider_sign_in' ||
        reason.kind === 'app_shutdown') &&
      // The listing authorizes its own records. Newly discovered native
      // interruptions may expand the target, but another account must not.
      (session.statusReasonIds.includes(reason.id) ||
        reason.account_scope === 'native' ||
        reason.kind === 'provider_sign_in' ||
        reason.kind === 'app_shutdown'),
  );
  const checkpoint = result.data.shutdown_checkpoint;
  const statusReasonIds = Array.from(
    new Set([
      ...applicable.map((reason) => reason.id),
      ...(checkpoint && session.statusReasonIds.includes(checkpoint.id)
        ? [checkpoint.id]
        : []),
    ]),
  ).sort();
  return statusReasonIds.length > 0
    ? {
        statusReasonIds,
        usageReasons: applicable.filter(
          (reason) => reason.kind === 'provider_usage_limit',
        ),
      }
    : null;
}

function pipelineTargetKey(session: UsageLimitedPipelineSessionItem): string {
  return JSON.stringify([
    interruptedSessionKey(session),
    session.provider,
    [...session.statusReasonIds].sort(),
  ]);
}

const PIPELINE_REASONS_ERROR =
  'Couldn’t find this workflow’s paused steps. Open the run to schedule its resume.';

/** Rechecked from the latest store state right before each create. */
function hasScheduledResume(session: UsageLimitedSessionItem): boolean {
  return (
    findScheduledInterruptedResume(
      useAutomationsStore.getState().activities,
      session,
      Date.now(),
    ) !== null
  );
}

/** Activity ids the store knew before a create, read synchronously. */
function knownActivityIds(): ReadonlySet<string> {
  return new Set(
    useAutomationsStore.getState().activities.map((activity) => activity.id),
  );
}

/**
 * Main can return an existing activity for a duplicate pipeline target even
 * before this renderer sees it. Only main's affirmative creation provenance
 * authorizes pipeline Undo; a missing marker from an older host fails closed.
 * Chat creation always creates a new identity on the existing backend path.
 */
function mutationResult(
  response: AutomationMutationResponse,
  target: UsageLimitedSessionItem,
  knownIds: ReadonlySet<string>,
): ScheduleInterruptedResumeResult {
  if (!response.ok) {
    return { kind: 'failed', error: response.error || SCHEDULE_ERROR };
  }
  const activity = response.activity;
  return {
    kind: 'scheduled',
    owned:
      activity &&
      (target.kind === 'chat' || response.created === true) &&
      !knownIds.has(activity.id) &&
      matchesInterruptedResumeActivity(activity, target, Date.now())
        ? { activity, target }
        : null,
  };
}

async function createChatResume(
  session: UsageLimitedChatSessionItem,
  runAt: string,
  providerName: string,
  workspaceName: string,
): Promise<ScheduleInterruptedResumeResult> {
  const tab = useChatStore
    .getState()
    .worktreeChats[
      `${session.projectId}/${session.worktreeId}`
    ]?.tabs.find((candidate) => candidate.id === session.chatId);
  const prompt = computeUsageLimitResumePrompt(tab?.messages ?? []);
  const knownIds = knownActivityIds();
  const response = await useAutomationsStore.getState().createActivity({
    name: `Resume chat after ${providerName} usage reset`,
    schedule: { kind: 'one_time', runAt, timezone: 'local' },
    action: {
      type: 'worktree_session_prompt',
      workspaceId: session.projectId,
      worktreeId: session.worktreeId,
      chatId: session.chatId,
      prompt: prompt.text,
      ...(prompt.fileReferences?.length
        ? { fileReferences: prompt.fileReferences }
        : {}),
      ...(prompt.attachmentPaths?.length
        ? { attachmentPaths: prompt.attachmentPaths }
        : {}),
      ...(prompt.attachmentPromptContexts?.length
        ? { attachmentPromptContexts: prompt.attachmentPromptContexts }
        : {}),
      inputMode: prompt.inputMode ?? 'typed',
      purpose: 'usage_limit_resume',
      ...(workspaceName ? { workspaceName } : {}),
      ...(session.worktreeName ? { worktreeName: session.worktreeName } : {}),
      ...(session.chatTitle ? { chatTitle: session.chatTitle } : {}),
    },
  });
  return mutationResult(response, session, knownIds);
}

async function createPipelineResume(
  session: UsageLimitedPipelineSessionItem,
  provider: 'claude' | 'codex',
  providerRunAt: string | null,
  workspaceName: string,
): Promise<ScheduleInterruptedResumeResult> {
  const details = await loadPipelineUsageReasons(session);
  if (!details) {
    return { kind: 'failed', error: PIPELINE_REASONS_ERROR };
  }
  const runAt =
    details.usageReasons.length > 0
      ? selectPipelineUsageLimitResumeAt(
          details.usageReasons,
          providerRunAt,
          new Date(),
        )
      : providerRunAt && Date.parse(providerRunAt) > Date.now()
        ? providerRunAt
        : null;
  if (!runAt) return { kind: 'failed', error: NO_RESET_ERROR };
  const target = {
    ...session,
    statusReasonIds: details.statusReasonIds,
  };
  if (hasScheduledResume(target)) return { kind: 'scheduled', owned: null };
  const knownIds = knownActivityIds();
  const response = await useAutomationsStore.getState().createActivity({
    name: `Resume workflow after ${getModelCatalogProviderLabel(provider)} usage reset`,
    schedule: { kind: 'one_time', runAt, timezone: 'local' },
    action: {
      type: 'pipeline_execution_resume',
      executionId: session.executionId,
      statusReasonIds: details.statusReasonIds,
      provider,
      purpose: 'usage_limit_resume',
      pipelineName: session.pipelineName,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
      ...(workspaceName ? { workspaceName } : {}),
      ...(session.worktreeName ? { worktreeName: session.worktreeName } : {}),
    },
  });
  return mutationResult(response, target, knownIds);
}

/**
 * Refresh the provider snapshot, then create the matching one-time resume
 * unless the limit cleared, a matching schedule exists, or no future reset is
 * known.
 */
async function scheduleAtReset(
  session: UsageLimitedSessionItem,
  workspaceName: string,
): Promise<ScheduleInterruptedResumeResult> {
  const provider = session.provider;
  if (!provider) return { kind: 'failed', error: NO_RESET_ERROR };
  const usage = await useObservabilityStore
    .getState()
    .refreshProviderUsageSnapshot(provider);
  const now = new Date();
  const readiness = sessionResumeReadiness(session, usage, now.getTime());
  if (readiness.state === 'ready') {
    return { kind: 'cleared' };
  }
  // The selector skips windows without a reset; when any blocking window has
  // none, readiness carries no `resetMs` and no single time clears the block.
  const providerRunAt =
    readiness.resetMs === undefined
      ? null
      : selectProviderUsageLimitResumeAt(usage, provider, now);
  await useAutomationsStore
    .getState()
    .hydrate()
    .catch(() => undefined);
  if (session.kind === 'chat') {
    if (hasScheduledResume(session)) return { kind: 'scheduled', owned: null };
    return providerRunAt && Date.parse(providerRunAt) > Date.now()
      ? createChatResume(
          session,
          providerRunAt,
          getModelCatalogProviderLabel(provider),
          workspaceName,
        )
      : { kind: 'failed', error: NO_RESET_ERROR };
  }
  if (provider !== 'claude' && provider !== 'codex') {
    return { kind: 'failed', error: NO_RESET_ERROR };
  }
  return createPipelineResume(session, provider, providerRunAt, workspaceName);
}

/**
 * Schedules a one-time "resume at reset" for an interrupted session through
 * the same automations the chat banner and pipeline notice create, and undoes
 * exactly the schedule a call created. The provider snapshot is refreshed
 * first; the run time always comes from that snapshot (or the pipeline's own
 * reasons), never from display fallback. One schedule or undo per session is
 * in flight at a time, guarded in this renderer only; the store deduplicates
 * pipeline execution/provider/reason sets in main. Chat deduplication remains
 * local to this renderer.
 *
 * `generation` identifies the host's current opening. Changing it clears row
 * errors, and an operation started under an earlier generation never reports
 * its error into the new one.
 */
export function useScheduleInterruptedResume(
  active: boolean,
  generation: number,
  workspaceNameForSession: (session: UsageLimitedSessionItem) => string,
  sessions: readonly UsageLimitedSessionItem[],
): {
  activities: ScheduledActivity[];
  schedulingTarget: (
    session: UsageLimitedSessionItem,
  ) => UsageLimitedSessionItem | null;
  operations: ReadonlyMap<string, InterruptedResumeOperation>;
  isBusy: (session: UsageLimitedSessionItem) => boolean;
  errors: Readonly<Record<string, string>>;
  schedule: (
    session: UsageLimitedSessionItem,
  ) => Promise<ScheduleInterruptedResumeResult>;
  unschedule: (
    session: UsageLimitedSessionItem,
    owned: OwnedInterruptedResume,
    options?: { awaitingListing?: boolean },
  ) => Promise<UnscheduleInterruptedResumeResult>;
} {
  // Inactive hosts (the always-mounted closed dialog) don't re-render on
  // automation changes.
  const activities = useAutomationsStore((state) =>
    active ? state.activities : NO_ACTIVITIES,
  );
  const [operations, setOperations] = useState<
    ReadonlyMap<string, InterruptedResumeOperation>
  >(() => new Map());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const inFlight = useRef(new Map<string, InterruptedResumeOperation>());
  const generationRef = useRef(generation);

  useEffect(() => {
    generationRef.current = generation;
    setErrors((current) => (Object.keys(current).length > 0 ? {} : current));
  }, [generation]);

  useEffect(() => {
    if (!active) return;
    const store = useAutomationsStore.getState();
    const unsubscribe = store.subscribeBridge();
    void store.hydrate({ joinInFlight: true }).catch(() => undefined);
    return unsubscribe;
  }, [active]);

  // Resolve every applicable interruption before claiming an existing
  // automation covers the row; usage reasons select time, not target identity.
  const [pipelineTargets, setPipelineTargets] = useState<
    ReadonlyMap<string, UsageLimitedPipelineSessionItem>
  >(() => new Map());
  useEffect(() => {
    if (!active) {
      setPipelineTargets((current) => (current.size > 0 ? new Map() : current));
      return;
    }
    let cancelled = false;
    void Promise.all(
      sessions
        .filter((session) => session.kind === 'pipeline')
        .map(async (session) => {
          try {
            const details = await loadPipelineUsageReasons(session);
            return details ? { session, details } : null;
          } catch {
            return null;
          }
        }),
    ).then((results) => {
      if (cancelled) return;
      const targets = new Map<string, UsageLimitedPipelineSessionItem>();
      for (const result of results) {
        if (!result) continue;
        targets.set(pipelineTargetKey(result.session), {
          ...result.session,
          statusReasonIds: result.details.statusReasonIds,
        });
      }
      setPipelineTargets((current) =>
        targets.size === 0 && current.size === 0 ? current : targets,
      );
    });
    return (): void => {
      cancelled = true;
    };
  }, [active, sessions, activities]);
  const schedulingTarget = useCallback(
    (session: UsageLimitedSessionItem): UsageLimitedSessionItem | null =>
      session.kind === 'chat'
        ? session
        : (pipelineTargets.get(pipelineTargetKey(session)) ?? null),
    [pipelineTargets],
  );

  const setError = useCallback((key: string, error: string | null): void => {
    setErrors((current) => {
      if (error === null) {
        if (!(key in current)) return current;
        const rest = { ...current };
        delete rest[key];
        return rest;
      }
      return { ...current, [key]: error };
    });
  }, []);

  const isBusy = useCallback(
    (session: UsageLimitedSessionItem): boolean =>
      inFlight.current.has(interruptedSessionKey(session)),
    [],
  );

  /**
   * Runs one operation under the shared per-session guard. A duplicate call
   * returns `busy` without touching the active operation's pending or error
   * state; a failure is reported only into the opening that started it.
   */
  const runExclusive = useCallback(
    async <Result extends { kind: string; error?: string }>(
      session: UsageLimitedSessionItem,
      operation: InterruptedResumeOperation,
      run: () => Promise<Result>,
      fallbackError: string,
    ): Promise<
      Result | { kind: 'busy' } | { kind: 'failed'; error: string }
    > => {
      const key = interruptedSessionKey(session);
      if (inFlight.current.has(key)) return { kind: 'busy' };
      const startedGeneration = generationRef.current;
      inFlight.current.set(key, operation);
      setOperations(new Map(inFlight.current));
      setError(key, null);
      let result: Result | { kind: 'failed'; error: string };
      try {
        result = await run();
      } catch {
        result = { kind: 'failed', error: fallbackError };
      } finally {
        inFlight.current.delete(key);
        setOperations(new Map(inFlight.current));
      }
      if (
        result.kind === 'failed' &&
        result.error &&
        generationRef.current === startedGeneration
      ) {
        setError(key, result.error);
      }
      return result;
    },
    [setError],
  );

  const schedule = useCallback(
    (
      session: UsageLimitedSessionItem,
    ): Promise<ScheduleInterruptedResumeResult> =>
      runExclusive(
        session,
        'schedule',
        () => scheduleAtReset(session, workspaceNameForSession(session)),
        SCHEDULE_ERROR,
      ),
    [runExclusive, workspaceNameForSession],
  );

  const unschedule = useCallback(
    (
      session: UsageLimitedSessionItem,
      owned: OwnedInterruptedResume,
      options?: { awaitingListing?: boolean },
    ): Promise<UnscheduleInterruptedResumeResult> =>
      runExclusive(
        session,
        'undo',
        () => deleteOwnedInterruptedResume(owned, options),
        UNDO_ERROR,
      ),
    [runExclusive],
  );

  return {
    activities,
    schedulingTarget,
    operations,
    isBusy,
    errors,
    schedule,
    unschedule,
  };
}
