import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/shallow';
import {
  Button,
  DialogModal,
  getModelCatalogProviderLabel,
  InterruptedSessionRow,
} from '@canopy/ui-shared';
import type {
  AgentProviderType,
  ListUsageLimitedIdleSessionsRequest,
  ScheduledActivity,
  UsageLimitedSessionGroup,
  UsageLimitedSessionItem,
  UsageLimitedSessionTarget,
} from '@canopy/desktop-shared/types';
import {
  isProviderlessResumePromptOrigin,
  useUsageLimitResumePromptStore,
} from '@/stores/usageLimitResumePromptStore';
import { clearResumedChatUsageLimitBanner } from '@/stores/chatStore';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useScheduledResumeAutomations } from '@/hooks/useScheduledResumeAutomations';
import { excludeScheduledResumeSessions } from '@/lib/interruptedSessions';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  getSidebarScopingContext,
  useSidebarScopingContext,
} from '@/components/sidebar/useSidebarScopingContext';
import {
  isWorkspaceIdInContext,
  isWorkspaceIdInScopingContext,
} from '@/lib/contextScope';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  linkedPersonalWorkspaceIdsForContext,
  useLinkedPersonalWorkspacesStore,
} from '@/stores/linkedPersonalWorkspacesStore';
import { installUsageLimitResumeTestApi } from '@/lib/usage-limit/test-api';
import {
  directResumeEntry,
  openResumeQueueEntry,
} from '@/lib/usage-limit/open-resumed-session';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { useProjectsStore } from '@/stores/projectsStore';
import { createDiffStatsKey } from '@/stores/projectsStore.diffStats';
import { ProjectIcon } from '../shared/ProjectIcon';
import { filterSessionGroupsByWorkspace } from './usageLimitResumeScope';
import { BranchIcon as AppCatalogBranchIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useObservabilityStore } from '@/stores/observabilityStore';
import {
  sessionResumeReadiness,
  summarizeResumeReadiness,
  type SessionResumeReadiness,
} from '@/lib/usage-limit/resume-availability';
import { resolveInterruptedSessionProviders } from '@/lib/interruptedSessions';
import { resumeReadinessSummaryText } from '@/lib/usage-limit/resume-readiness-copy';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import {
  countInterruptedWork,
  interruptedWorkReasonSummary,
  resumeConfirmLabel,
  resumeDialogTitle,
  resumeEffectDisclosure,
  shouldShowEveryChatResumeEffect,
} from '@/lib/usage-limit/interrupted-work-copy';
import {
  findScheduledInterruptedResumeActivity,
  matchesInterruptedResumeActivity,
  useScheduleInterruptedResume,
  type InterruptedResumeOperation,
  type OwnedInterruptedResume,
} from '@/hooks/useScheduleInterruptedResume';
import {
  interruptedSessionCheckboxTestId,
  interruptedSessionDomId,
  interruptedSessionKey,
  interruptedSessionMetadata,
  interruptedSessionSecondaryMetadata,
  interruptedSessionTitle,
} from './sessionRowModel';
import { Stack, ChoiceField, ErrorBanner } from '@canopy/ui-shared/components';

const REFRESH_INTERVAL_MS = 30_000;
/** Readiness is recomputed in memory on this clock; it never fetches. */
const READINESS_CLOCK_MS = 30_000;
const LOAD_ERROR = 'Couldn’t load interrupted work.';
const RESUME_ERROR = 'Some work couldn’t be resumed. Try again.';
const targetKey = interruptedSessionKey;

type ResumePromptOrigin = ReturnType<
  typeof useUsageLimitResumePromptStore.getState
>['origin'];

/**
 * Origins whose provider snapshot describes the account the sessions resume
 * on. Account-change and authentication prompts may still hold the previous
 * account's snapshot, so they keep their selection and make no readiness
 * claims.
 */
function isReadinessGatedOrigin(origin: ResumePromptOrigin): boolean {
  return (
    origin === 'home' || origin === 'usage-review' || origin === 'app-restart'
  );
}

/** One modal opening's usage refreshes; stale completions check `cancelled`. */
interface ReadinessOpening {
  requestedProviders: Set<AgentProviderType>;
  initialRequestStarted: boolean;
  initialSessionKeys: Set<string> | null;
  selectionInitialized: boolean;
  cancelled: boolean;
}

/** A schedule created through the current opening's "Resume at reset". */
interface OwnedSchedule extends OwnedInterruptedResume {
  /** Set once the store lists the activity, before or after its response. */
  seen: boolean;
}

/**
 * Schedules this opening created, keyed by session. Closing, reopening, or a
 * scope change starts a new generation with no records; async completions
 * from an earlier generation change nothing.
 */
interface ScheduleOwnership {
  generation: number;
  /** Rows scheduling now, so an early store broadcast can't remove them. */
  provisional: ReadonlySet<string>;
  owned: ReadonlyMap<string, OwnedSchedule>;
  /** Activities this opening deleted, hidden until the store drops them. */
  removedIds: ReadonlySet<string>;
}

function emptyOwnership(generation: number): ScheduleOwnership {
  return {
    generation,
    provisional: new Set(),
    owned: new Map(),
    removedIds: new Set(),
  };
}

/**
 * The owned activity while it is still a pending resume for its target. Before
 * the store first lists it, the create response stands in for it.
 */
function currentOwnedActivity(
  record: OwnedSchedule,
  activities: readonly ScheduledActivity[],
  nowMs: number,
): ScheduledActivity | null {
  const listed = activities.find(
    (activity) => activity.id === record.activity.id,
  );
  const candidate = listed ?? (record.seen ? null : record.activity);
  return candidate &&
    matchesInterruptedResumeActivity(candidate, record.target, nowMs)
    ? candidate
    : null;
}

/**
 * A focused row control whose operation may replace it. Focus moves to the
 * replacement only if the user hasn't focused or pressed anything else.
 */
interface FocusHandoff {
  key: string;
  generation: number;
  control: HTMLButtonElement;
  /** The control to focus once the operation settles; null clears intent. */
  replacement: InterruptedResumeOperation | null;
  settled: boolean;
}

/** Stable ready-first order; relative order holds within each partition. */
function readyFirst(
  sessions: UsageLimitedSessionItem[],
  isEligible: (session: UsageLimitedSessionItem) => boolean,
): UsageLimitedSessionItem[] {
  return [
    ...sessions.filter(isEligible),
    ...sessions.filter((session) => !isEligible(session)),
  ];
}

interface WorktreeSubgroup {
  worktreeId: string;
  worktreeName: string;
  sessions: UsageLimitedSessionItem[];
}

/** Group a code workspace's chats by worktree, preserving encounter order. */
function groupSessionsByWorktree(
  sessions: UsageLimitedSessionItem[],
): WorktreeSubgroup[] {
  const byWorktree = new Map<string, WorktreeSubgroup>();
  for (const session of sessions) {
    const worktreeId = session.worktreeId ?? 'workspace';
    const existing = byWorktree.get(worktreeId);
    if (existing) {
      existing.sessions.push(session);
    } else {
      byWorktree.set(worktreeId, {
        worktreeId,
        worktreeName: session.worktreeName || worktreeId,
        sessions: [session],
      });
    }
  }
  return Array.from(byWorktree.values());
}

/** Subscribe only to the icon's repository path, not live worktree status. */
function ResumeWorkspaceIcon({
  group,
}: {
  group: UsageLimitedSessionGroup;
}): JSX.Element | null {
  const repoPath = useProjectsStore((state) => {
    const project = state.projects.find(
      (candidate) => candidate.id === group.workspaceId,
    );
    return project?.type === 'single-repo' ? project.repoPath : undefined;
  });
  return group.workspaceType ? (
    <ProjectIcon
      kind={group.workspaceType}
      color={group.workspaceColor}
      repoPath={repoPath}
      size="sm"
    />
  ) : null;
}

/**
 * A chat row's secondary line. Subscribes only to its own worktree's
 * uncommitted flag; cowork and standalone chats have no worktree to read.
 */
function ChatSecondaryMetadata({
  session,
  hasWorktree,
  now,
  showEveryResumeEffect,
}: {
  session: UsageLimitedSessionItem;
  hasWorktree: boolean;
  now: Date;
  showEveryResumeEffect: boolean;
}): JSX.Element {
  const uncommittedChanges = useProjectsStore((state) =>
    hasWorktree && session.kind === 'chat'
      ? state.uncommittedChanges[
          createDiffStatsKey(session.projectId, session.worktreeId)
        ]
      : undefined,
  );
  return (
    <>
      {interruptedSessionSecondaryMetadata(session, {
        now,
        uncommittedChanges,
        showEveryResumeEffect,
      })}
    </>
  );
}

/**
 * Mounted once in App.tsx. Initial loading selects every interrupted session;
 * focus and periodic refreshes keep the loaded list in place, retain valid
 * choices, and leave newly discovered sessions unchecked. Confirmation queues
 * the selected targets. An empty scoped result closes the prompt.
 *
 * For readiness-gated origins (Home, usage review, app restart) the opening
 * first refreshes each listed provider's usage once, then selects only the
 * sessions the Usage card rule says can resume now. Sessions waiting on a
 * provider reset stay unchecked and disabled, and offer "Resume at reset".
 *
 * The `home` origin matches the Home row: it omits chats with a pending
 * usage-limit resume automation (CAN-4970) and stays loading until the
 * automations snapshot is loaded. A chat scheduled elsewhere while the prompt
 * is open leaves the list and the selection. A chat scheduled through this
 * opening stays listed, disabled, with its confirmation and an Undo that
 * deletes exactly the created schedule (CAN-5015); reopening omits it.
 * Confirmation re-checks the latest schedules so a stale selection never
 * resumes a scheduled chat.
 */
function UsageLimitResumeModalContent(): JSX.Element | null {
  const isOpen = useUsageLimitResumePromptStore((s) => s.isOpen);
  const provider = useUsageLimitResumePromptStore((s) => s.provider);
  const origin = useUsageLimitResumePromptStore((s) => s.origin);
  const authentication = useUsageLimitResumePromptStore(
    (s) => s.authentication,
  );
  const close = useUsageLimitResumePromptStore((s) => s.close);
  const context = useSidebarScopingContext();
  const generation = useWorkspaceContextStore(
    (state) => state.appliedGeneration,
  );
  const contextKey =
    origin === 'home' && context
      ? `${serializeWorkspaceContext(context)}:${generation}`
      : 'all';
  const linkedIds = useLinkedPersonalWorkspacesStore((state) =>
    linkedPersonalWorkspaceIdsForContext(state, context),
  );

  const [loadedListing, setListing] = useState<{
    contextKey: string;
    groups: UsageLimitedSessionGroup[];
  } | null>(null);
  const loadedGroups = loadedListing?.groups ?? null;
  // Status polling replaces project objects frequently. Only publish a change
  // here when a loaded session actually enters or leaves the Home scope.
  const visibleSessionKeys = useProjectsStore(
    useShallow((state) => {
      const scoped =
        origin === 'home'
          ? filterSessionGroupsByWorkspace(loadedGroups ?? [], (workspaceId) =>
              isWorkspaceIdInContext(
                workspaceId,
                state.projects,
                context,
                linkedIds,
              ),
            )
          : (loadedGroups ?? []);
      return scoped.flatMap((group) => group.sessions.map(targetKey));
    }),
  );
  const excludesScheduledResumes = isOpen && origin === 'home';
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [ownership, setOwnership] = useState<ScheduleOwnership>(() =>
    emptyOwnership(0),
  );
  const generationRef = useRef(0);
  const focusHandoffRef = useRef<FocusHandoff | null>(null);
  const [, setFocusHandoffTick] = useState(0);
  // Ownership of schedules made in this opening follows the store directly.
  const storeActivities = useAutomationsStore((s) => s.activities);
  const {
    settled: automationsReady,
    error: automationsError,
    retry: retryAutomations,
  } = useScheduledResumeAutomations(excludesScheduledResumes);
  const automationActivities = useMemo(
    () =>
      ownership.removedIds.size === 0
        ? storeActivities
        : storeActivities.filter(
            (activity) => !ownership.removedIds.has(activity.id),
          ),
    [storeActivities, ownership.removedIds],
  );
  const retainedKeys = useMemo(() => {
    const keys = new Set(ownership.provisional);
    for (const [key, record] of Array.from(ownership.owned)) {
      if (currentOwnedActivity(record, automationActivities, nowMs)) {
        keys.add(key);
      }
    }
    return keys;
  }, [ownership, automationActivities, nowMs]);
  // `automationsReady` ignores background loads: a hydrate (including
  // scheduling's recheck) must not unmount the live region or its focused
  // control. Context changes clear hydrated; confirmation separately waits
  // for any current load to finish.
  const contextGroups = useMemo(() => {
    if (origin === 'home' && loadedListing?.contextKey !== contextKey)
      return null;
    if (loadedGroups === null || origin !== 'home') return loadedGroups;
    const visible = new Set(visibleSessionKeys);
    return loadedGroups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) =>
          visible.has(targetKey(session)),
        ),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [loadedGroups, origin, visibleSessionKeys, loadedListing, contextKey]);
  const groups = useMemo(() => {
    if (contextGroups === null || !excludesScheduledResumes) {
      return contextGroups;
    }
    if (!automationsReady) return null;
    return excludeScheduledResumeSessions(
      contextGroups,
      automationActivities,
      Date.now(),
      retainedKeys,
    );
  }, [
    contextGroups,
    excludesScheduledResumes,
    automationsReady,
    automationActivities,
    retainedKeys,
  ]);
  const automationsLoadFailed =
    excludesScheduledResumes && automationsError !== null;
  const [listingSucceeded, setListingSucceeded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  // Guards a second confirmation before `submitting` re-renders the button.
  const confirmingRef = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const gated = isReadinessGatedOrigin(origin);
  const readinessActive = isOpen && gated;
  // Only an open gated dialog follows usage; a closed one never re-renders.
  const usage = useObservabilityStore((state) =>
    readinessActive ? state.usage : undefined,
  );
  const [readinessReady, setReadinessReady] = useState(false);
  const openingRef = useRef<ReadinessOpening | null>(null);

  const closePrompt = useCallback((): void => {
    if (
      origin === 'authentication' &&
      authentication?.phase === 'verification-failed'
    ) {
      void window.api.codexLogin
        .cancel()
        .then(close)
        .catch(() =>
          setError("Couldn't finish cancelling sign-in. Try again."),
        );
      return;
    }
    close();
  }, [authentication?.phase, close, origin]);

  const isSubmitting = useEffectEvent((): boolean => submitting);
  const closeLoadedPrompt = useEffectEvent((): void => closePrompt());

  // E2E hook: lets a Playwright spec open this modal through the same store
  // the real account-change trigger uses, without needing a real provider
  // CLI login. Hard-gated on __CANOPY_E2E__; inert (installer returns
  // undefined) outside E2E builds.
  useEffect(() => installUsageLimitResumeTestApi(), []);

  // Removed schedules and context visibility changes never restore a stale
  // checkmark. A newly eligible session requires a deliberate choice.
  useEffect(() => {
    if (!excludesScheduledResumes || groups === null) return;
    const eligible = new Set(
      groups.flatMap((group) => group.sessions.map(targetKey)),
    );
    setSelected((current) => {
      const next = new Set(
        Array.from(current).filter((key) => eligible.has(key)),
      );
      return next.size === current.size ? current : next;
    });
  }, [excludesScheduledResumes, groups]);

  useEffect(() => {
    if (!isOpen || (!provider && !isProviderlessResumePromptOrigin(origin))) {
      setListing(null);
      setSelected(new Set());
      setError(null);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let snapshot: string | undefined;
    setListing(null);
    setListingSucceeded(false);
    setSelected(new Set());
    setError(null);
    const refresh = async (): Promise<void> => {
      if (inFlight || isSubmitting()) return;
      inFlight = true;
      let result: UsageLimitedSessionGroup[];
      try {
        if (typeof window.api.listUsageLimitedIdleSessions === 'function') {
          const filter: ListUsageLimitedIdleSessionsRequest =
            origin === 'authentication' && authentication?.attemptId
              ? { authenticationAttemptId: authentication.attemptId }
              : origin === 'app-restart'
                ? { resumeReason: 'app_shutdown' }
                : origin === 'home'
                  ? {}
                  : { provider: provider ?? 'claude' };
          // The dialog shows each chat's resume message and last step.
          result = await window.api.listUsageLimitedIdleSessions({
            ...filter,
            includeResumePreview: true,
          });
        } else {
          const legacyGroups = await window.api.listUsageLimitedIdleChats({
            provider: provider ?? 'claude',
            includeResumePreview: true,
          });
          result = legacyGroups.map((group) => ({
            groupId: group.workspaceId,
            groupKind: 'workspace',
            workspaceId: group.workspaceId,
            workspaceName: group.workspaceName,
            workspaceType: group.workspaceType,
            workspaceColor: group.workspaceColor,
            sessions: group.chats.map((chat) => ({
              ...chat,
              kind: 'chat' as const,
            })),
          }));
        }
        if (isReadinessGatedOrigin(origin) && provider === null) {
          result = await resolveInterruptedSessionProviders(result);
        }
        if (cancelled || isSubmitting()) return;
        // Even an unchanged listing is an opportunity to expire a schedule.
        const nextSnapshot = JSON.stringify(result);
        if (origin === 'home' || snapshot !== nextSnapshot) {
          setListing({ groups: result, contextKey });
        }
        if (snapshot !== nextSnapshot) {
          const keys = new Set(
            result.flatMap((group) => group.sessions.map(targetKey)),
          );
          const initialLoad = snapshot === undefined;
          if (initialLoad && openingRef.current) {
            openingRef.current.initialSessionKeys = keys;
          }
          setSelected((current) => {
            // Select everything on initial load; gated origins wait for the
            // usage refresh and select eligible sessions only. Subsequent
            // discoveries require a deliberate choice; preserve both checks
            // and unchecks by identity.
            if (initialLoad) {
              return isReadinessGatedOrigin(origin) ? new Set<string>() : keys;
            }
            const next = new Set(
              Array.from(current).filter((key) => keys.has(key)),
            );
            return next.size === current.size ? current : next;
          });
          snapshot = nextSnapshot;
        }
        setListingSucceeded(true);
        setError((current) => (current === LOAD_ERROR ? null : current));
      } catch {
        if (cancelled) return;
        if (snapshot === undefined) {
          setError((current) => current ?? LOAD_ERROR);
          setListing({ groups: [], contextKey });
        }
      } finally {
        inFlight = false;
      }
    };
    const requestRefresh = (): void => {
      if (origin === 'home') retryAutomations();
      void refresh();
    };
    requestRefresh();
    const interval = window.setInterval(requestRefresh, REFRESH_INTERVAL_MS);
    window.addEventListener('focus', requestRefresh);

    return (): void => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', requestRefresh);
    };
    // Submission state is read through an Effect Event so starting a resume
    // does not restart the request or replace the pending selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOpen,
    provider,
    origin,
    loadAttempt,
    authentication?.attemptId,
    contextKey,
  ]);

  useEffect(() => {
    if (isOpen && groups !== null && groups.length === 0 && !error) {
      closeLoadedPrompt();
    }
    // Effect Events read the latest dismissal policy without retriggering the
    // effect when authentication verification changes for the same attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, groups, error]);

  const allSessions = useMemo<UsageLimitedSessionItem[]>(
    () => (groups ?? []).flatMap((group) => group.sessions),
    [groups],
  );

  // Each opening refreshes usage for its own providers; reopening starts over.
  // A Home context switch reloads the listing, so it starts a new opening too.
  useEffect(() => {
    if (!isOpen) return;
    const opening: ReadinessOpening = {
      requestedProviders: new Set(),
      initialRequestStarted: false,
      initialSessionKeys: null,
      selectionInitialized: false,
      cancelled: false,
    };
    openingRef.current = opening;
    setReadinessReady(false);
    setNowMs(Date.now());
    const startOwnership = (): void => {
      generationRef.current += 1;
      focusHandoffRef.current = null;
      setOwnership(emptyOwnership(generationRef.current));
    };
    startOwnership();
    return (): void => {
      opening.cancelled = true;
      if (openingRef.current === opening) openingRef.current = null;
      // Closing keeps any created schedule; it only ends local ownership.
      startOwnership();
    };
  }, [isOpen, origin, provider, contextKey]);

  // Release ownership once the owned activity fires, is removed, or stops
  // being a pending resume, so a later schedule never inherits its Undo.
  useEffect(() => {
    if (ownership.owned.size === 0) return;
    setOwnership((current) => {
      let owned: Map<string, OwnedSchedule> | null = null;
      for (const [key, record] of Array.from(current.owned)) {
        const listed = automationActivities.some(
          (activity) => activity.id === record.activity.id,
        );
        if (!currentOwnedActivity(record, automationActivities, nowMs)) {
          owned ??= new Map(current.owned);
          owned.delete(key);
        } else if (listed && !record.seen) {
          owned ??= new Map(current.owned);
          owned.set(key, { ...record, seen: true });
        }
      }
      return owned ? { ...current, owned } : current;
    });
  }, [ownership.owned, automationActivities, nowMs]);

  // Another focus or press during an operation cancels its focus handoff.
  useEffect(() => {
    if (!isOpen) return;
    const cancelHandoff = (event: Event): void => {
      const handoff = focusHandoffRef.current;
      if (
        handoff &&
        !(
          event.target instanceof Node && handoff.control.contains(event.target)
        )
      ) {
        focusHandoffRef.current = null;
      }
    };
    document.addEventListener('focusin', cancelHandoff, true);
    document.addEventListener('pointerdown', cancelHandoff, true);
    return (): void => {
      document.removeEventListener('focusin', cancelHandoff, true);
      document.removeEventListener('pointerdown', cancelHandoff, true);
      focusHandoffRef.current = null;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!readinessActive) return;
    const interval = window.setInterval(
      () => setNowMs(Date.now()),
      READINESS_CLOCK_MS,
    );
    return (): void => window.clearInterval(interval);
  }, [readinessActive]);

  const groupsLoaded = loadedGroups !== null && listingSucceeded;
  const listedProviders = useMemo(
    () =>
      Array.from(
        new Set(
          (loadedGroups ?? []).flatMap((group) =>
            group.sessions.flatMap((session) =>
              session.provider ? [session.provider] : [],
            ),
          ),
        ),
      ).sort(),
    [loadedGroups],
  );

  // After the first successful listing, refresh each distinct provider once
  // per opening. Selection waits for that first round to settle (success or
  // failure); providers discovered later refresh without blocking.
  useEffect(() => {
    const opening = openingRef.current;
    if (!readinessActive || !groupsLoaded || !opening) return;
    const refreshSnapshot =
      useObservabilityStore.getState().refreshProviderUsageSnapshot;
    // Deduplicated per opening, so a changed listing only refreshes newly
    // listed providers.
    const settled = Promise.allSettled(
      listedProviders
        .filter((candidate) => !opening.requestedProviders.has(candidate))
        .map((candidate) => {
          opening.requestedProviders.add(candidate);
          return Promise.resolve().then(() => refreshSnapshot(candidate));
        }),
    );
    if (opening.initialRequestStarted) return;
    opening.initialRequestStarted = true;
    void settled.then(() => {
      if (opening.cancelled || openingRef.current !== opening) return;
      setNowMs(Date.now());
      setReadinessReady(true);
    });
  }, [readinessActive, groupsLoaded, listedProviders, origin, provider]);

  const readinessByKey = useMemo(() => {
    const readiness = new Map<string, SessionResumeReadiness>();
    if (!gated) return readiness;
    for (const session of allSessions) {
      readiness.set(
        targetKey(session),
        sessionResumeReadiness(session, usage, nowMs),
      );
    }
    return readiness;
  }, [gated, allSessions, usage, nowMs]);
  // Home's retained scheduled chats stay unselectable even if the limit clears.
  const isEligible = useCallback(
    (session: UsageLimitedSessionItem): boolean => {
      const key = targetKey(session);
      if (excludesScheduledResumes && retainedKeys.has(key)) return false;
      return readinessByKey.get(key)?.state !== 'waiting';
    },
    [readinessByKey, excludesScheduledResumes, retainedKeys],
  );
  const eligibleSessions = useMemo(
    () => allSessions.filter(isEligible),
    [allSessions, isEligible],
  );
  const eligibleKeys = useMemo(
    () => new Set(eligibleSessions.map(targetKey)),
    [eligibleSessions],
  );
  // What the dialog shows and submits: never a missing or blocked session,
  // even before the pruning effect below commits.
  const effectiveSelected = useMemo(
    () => new Set(Array.from(selected).filter((key) => eligibleKeys.has(key))),
    [selected, eligibleKeys],
  );
  const readinessPending = gated && !readinessReady && error !== LOAD_ERROR;

  useEffect(() => {
    if (groups === null) return;
    setSelected((current) => {
      const next = new Set(
        Array.from(current).filter((key) => eligibleKeys.has(key)),
      );
      return next.size === current.size ? current : next;
    });
  }, [groups, eligibleKeys]);

  useEffect(() => {
    const opening = openingRef.current;
    if (
      !gated ||
      !readinessReady ||
      !listingSucceeded ||
      groups === null ||
      !opening
    )
      return;
    if (opening.selectionInitialized) return;
    opening.selectionInitialized = true;
    setSelected(
      new Set(
        Array.from(eligibleKeys).filter((key) =>
          opening.initialSessionKeys?.has(key),
        ),
      ),
    );
  }, [gated, readinessReady, listingSucceeded, groups, eligibleKeys]);

  const readinessSummary = useMemo(
    () =>
      summarizeResumeReadiness(
        allSessions.flatMap((session) => {
          const key = targetKey(session);
          const readiness = readinessByKey.get(key);
          return readiness ? [{ key, kind: session.kind, readiness }] : [];
        }),
      ),
    [allSessions, readinessByKey],
  );

  const workspaceTypes = useMemo(
    () =>
      new Map(
        (groups ?? []).flatMap((group) =>
          group.sessions.map(
            (session): [string, UsageLimitedSessionGroup['workspaceType']] => [
              targetKey(session),
              group.workspaceType,
            ],
          ),
        ),
      ),
    [groups],
  );
  // The effect disclosure and confirmation describe only what would resume.
  const selectedSessions = useMemo(
    () =>
      allSessions.filter((session) =>
        effectiveSelected.has(targetKey(session)),
      ),
    [allSessions, effectiveSelected],
  );
  const effectDisclosure = useMemo(
    () =>
      resumeEffectDisclosure(
        selectedSessions.map((session) => ({
          session,
          workspaceType: workspaceTypes.get(targetKey(session)),
        })),
      ),
    [selectedSessions, workspaceTypes],
  );
  const showEveryResumeEffect = useMemo(
    () => shouldShowEveryChatResumeEffect(allSessions),
    [allSessions],
  );
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  const workspaceNames = useMemo(
    () =>
      new Map(
        (groups ?? []).flatMap((group) =>
          group.sessions.map((session): [string, string] => [
            targetKey(session),
            group.workspaceName,
          ]),
        ),
      ),
    [groups],
  );
  const workspaceNameForSession = useCallback(
    (session: UsageLimitedSessionItem): string =>
      workspaceNames.get(targetKey(session)) ?? '',
    [workspaceNames],
  );
  const scheduling = useScheduleInterruptedResume(
    readinessActive,
    ownership.generation,
    workspaceNameForSession,
    allSessions,
  );
  const scheduleActivities = useMemo(
    () =>
      ownership.removedIds.size === 0
        ? scheduling.activities
        : scheduling.activities.filter(
            (activity) => !ownership.removedIds.has(activity.id),
          ),
    [scheduling.activities, ownership.removedIds],
  );
  const controlRefs = useRef(new Map<string, HTMLButtonElement>());

  // Runs after each commit: once an operation settles and its row re-renders,
  // move focus from the initiating control to its replacement, unless the
  // user focused elsewhere. Bumping the handoff tick guarantees that commit.
  useLayoutEffect(() => {
    const handoff = focusHandoffRef.current;
    if (!handoff?.settled || scheduling.operations.has(handoff.key)) return;
    focusHandoffRef.current = null;
    if (handoff.generation !== generationRef.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== handoff.control) {
      return;
    }
    const replacement =
      handoff.replacement === null
        ? undefined
        : controlRefs.current.get(`${handoff.key}:${handoff.replacement}`);
    if (replacement && !replacement.disabled) {
      if (active !== replacement) replacement.focus();
    } else if (handoff.control.isConnected && !handoff.control.disabled) {
      if (active !== handoff.control) handoff.control.focus();
    }
  });

  const selectedCount = effectiveSelected.size;
  const allSelected =
    selectedCount > 0 && selectedCount === eligibleSessions.length;

  useCurrentUiStateReporter('usageLimit.resumeModal', {
    open: isOpen,
    origin,
    ...(provider ? { provider } : {}),
    loading:
      isOpen && (groups === null || readinessPending) && !automationsLoadFailed,
    submitting,
    groupCount: groups?.length ?? 0,
    chatCount: allSessions.filter((session) => session.kind === 'chat').length,
    pipelineCount: allSessions.filter((session) => session.kind === 'pipeline')
      .length,
    selectedCount,
    ...(gated
      ? {
          readinessPending,
          readyCount: readinessSummary.readyCount,
          waitingCount: readinessSummary.waitingCount,
        }
      : {}),
    error: error ?? (automationsLoadFailed ? LOAD_ERROR : null),
  });

  if (!isOpen || (!provider && !isProviderlessResumePromptOrigin(origin))) {
    return null;
  }

  const providerLabel = getModelCatalogProviderLabel(provider ?? 'claude');
  const listed = groups === null ? null : allSessions;
  const title = resumeDialogTitle(
    listed === null ? null : countInterruptedWork(listed),
  );
  // Authentication and account-change prompts keep their guidance; the effect
  // disclosure below still describes the selection.
  const subtitle =
    origin === 'authentication'
      ? authentication?.account?.authenticated
        ? `Resume work paused while signing in with ${authentication.account.accountLabel ?? 'your current Codex account'}.`
        : 'Work paused for Codex sign-in. Verify an account before resuming.'
      : origin === 'account-change'
        ? `You switched ${providerLabel} accounts. Resume work that was interrupted on the previous account.`
        : listed !== null && listed.length > 0
          ? interruptedWorkReasonSummary(listed)
          : undefined;
  if (automationsLoadFailed) {
    return (
      <DialogModal
        onClose={closePrompt}
        maxWidth="lg"
        title={title}
        subtitle={subtitle}
      >
        <Stack gap="group">
          <ErrorBanner className="" error={LOAD_ERROR} />
          <div className="flex justify-end gap-3">
            <Button size="compact" onClick={closePrompt}>
              Cancel
            </Button>
            <Button variant="primary" size="compact" onClick={retryAutomations}>
              Try again
            </Button>
          </div>
        </Stack>
      </DialogModal>
    );
  }
  if (groups === null || readinessPending) {
    return (
      <DialogModal
        onClose={closePrompt}
        maxWidth="lg"
        title={title}
        subtitle={subtitle}
      >
        <div className="text-s fg-secondary">Loading interrupted work…</div>
      </DialogModal>
    );
  }
  if (error && groups.length === 0) {
    return (
      <DialogModal
        onClose={closePrompt}
        maxWidth="lg"
        title={title}
        subtitle={subtitle}
      >
        <Stack gap="group">
          <ErrorBanner className="" error={error} />
          <div className="flex justify-end gap-3">
            <Button size="compact" onClick={closePrompt}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="compact"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          </div>
        </Stack>
      </DialogModal>
    );
  }

  const toggleSession = (session: UsageLimitedSessionItem): void => {
    if (!isEligible(session)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const key = targetKey(session);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSessions = (sessions: UsageLimitedSessionItem[]): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      const keys = sessions.filter(isEligible).map(targetKey);
      if (keys.length === 0) return prev;
      const allSelectedNow = keys.every((key) => effectiveSelected.has(key));
      for (const key of keys) {
        if (allSelectedNow) next.delete(key);
        else next.add(key);
      }
      return next;
    });

  const toggleWorkspace = (group: UsageLimitedSessionGroup): void =>
    toggleSessions(group.sessions);

  const triState = (
    sessions: UsageLimitedSessionItem[],
  ): { checked: boolean; indeterminate: boolean; disabled: boolean } => {
    const keys = sessions.filter(isEligible).map(targetKey);
    const count = keys.filter((key) => effectiveSelected.has(key)).length;
    return {
      checked: keys.length > 0 && count === keys.length,
      indeterminate: count > 0,
      disabled: keys.length === 0,
    };
  };

  const toggleAll = (): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      const keys = eligibleSessions.map(targetKey);
      const allSelectedNow = keys.every((key) => effectiveSelected.has(key));
      for (const key of keys) {
        if (allSelectedNow) next.delete(key);
        else next.add(key);
      }
      return next;
    });

  const confirm = async (): Promise<void> => {
    if (confirmingRef.current) return;
    let confirmable = allSessions;
    if (excludesScheduledResumes) {
      // A workspace can be visible in both contexts (a linked checkout).
      // Even then, the old context's selection must not survive its switch.
      const currentContext = getSidebarScopingContext();
      const currentContextKey = currentContext
        ? `${serializeWorkspaceContext(currentContext)}:${useWorkspaceContextStore.getState().appliedGeneration}`
        : 'all';
      if (currentContextKey !== contextKey) return;
      // Re-check the latest schedules; one may have been created since the
      // list last rendered.
      const automations = useAutomationsStore.getState();
      if (
        !automations.hydrated ||
        automations.loading ||
        automations.error !== null
      )
        return;
      confirmable = excludeScheduledResumeSessions(
        filterSessionGroupsByWorkspace(
          groups ?? [],
          isWorkspaceIdInScopingContext,
        ),
        automations.activities,
        Date.now(),
      ).flatMap((group) => group.sessions);
    }
    // Recheck against the newest snapshot and clock, not the last render.
    const latestUsage = useObservabilityStore.getState().usage;
    const confirmNowMs = Date.now();
    const selectedSessions = confirmable.filter(
      (session) =>
        effectiveSelected.has(targetKey(session)) &&
        (!gated ||
          sessionResumeReadiness(session, latestUsage, confirmNowMs).state ===
            'ready'),
    );
    if (selectedSessions.length === 0) {
      setSelected(new Set());
      return;
    }
    const targets: UsageLimitedSessionTarget[] = [];
    const pipelineTargets = new Map<
      string,
      Extract<UsageLimitedSessionTarget, { kind: 'pipeline' }>
    >();
    for (const session of selectedSessions) {
      if (session.kind === 'chat') {
        targets.push({
          kind: 'chat',
          projectId: session.projectId,
          worktreeId: session.worktreeId,
          chatId: session.chatId,
        });
        continue;
      }
      // Queue requests identify a pipeline by execution, while the dialog
      // selects provider targets independently. Submit every selected reason
      // in one target so the queue cannot overwrite a provider's selection.
      const existing = pipelineTargets.get(session.executionId);
      if (existing) {
        existing.statusReasonIds = Array.from(
          new Set([...existing.statusReasonIds, ...session.statusReasonIds]),
        ).sort();
      } else {
        const target = {
          kind: 'pipeline' as const,
          executionId: session.executionId,
          statusReasonIds: session.statusReasonIds,
        };
        pipelineTargets.set(session.executionId, target);
        targets.push(target);
      }
    }
    // Set after the synchronous eligibility checks, so an early return never
    // leaves confirmation locked.
    confirmingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (typeof window.api.enqueueResumeQueue === 'function') {
        const snapshot = await window.api.enqueueResumeQueue({
          targets,
          ...(authentication?.attemptId
            ? { authenticationAttemptId: authentication.attemptId }
            : {}),
        });
        const queue = useResumeQueueStore.getState();
        queue.apply(snapshot);
        queue.clearNavigationError();
        // One chat opens directly, so its reply is visible as it streams or
        // after it has finished. Anything else needs the queue's overview.
        const entry = directResumeEntry(snapshot, targets);
        if (!entry) {
          queue.open();
          close();
          return;
        }
        close();
        // A failed navigation never enqueues again; the queue is the retry route.
        const opened = await openResumeQueueEntry(entry);
        if (!opened.ok) {
          useResumeQueueStore.getState().openWithNavigationError(opened.error);
        }
        return;
      }
      let failedKeys: Set<string>;
      if (typeof window.api.resumeUsageLimitedSessions === 'function') {
        const response = await window.api.resumeUsageLimitedSessions({
          targets,
          ...(authentication?.attemptId
            ? { authenticationAttemptId: authentication.attemptId }
            : {}),
        });
        failedKeys = new Set(
          response.failedTargets.flatMap(({ target }) =>
            target.kind === 'chat'
              ? [targetKey(target)]
              : selectedSessions
                  .filter(
                    (session) =>
                      session.kind === 'pipeline' &&
                      session.executionId === target.executionId &&
                      session.statusReasonIds.some((id) =>
                        target.statusReasonIds.includes(id),
                      ),
                  )
                  .map(targetKey),
          ),
        );
      } else {
        const chatTargets = targets
          .filter((target) => target.kind === 'chat')
          .map(({ projectId, worktreeId, chatId }) => ({
            projectId,
            worktreeId,
            chatId,
          }));
        const response = await window.api.resumeUsageLimitedChats({
          targets: chatTargets,
        });
        failedKeys = new Set(
          response.failedTargets.map(
            (target) =>
              `chat:${target.projectId}/${target.worktreeId}/${target.chatId}`,
          ),
        );
      }
      for (const target of targets) {
        if (!failedKeys.has(targetKey(target)) && target.kind === 'chat') {
          clearResumedChatUsageLimitBanner({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            chatId: target.chatId,
          });
        }
      }
      if (failedKeys.size === 0) {
        close();
        return;
      }
      setListing((current) =>
        current === null
          ? null
          : {
              ...current,
              groups: current.groups
                .map((group) => ({
                  ...group,
                  sessions: group.sessions.filter((session) =>
                    failedKeys.has(targetKey(session)),
                  ),
                }))
                .filter((group) => group.sessions.length > 0),
            },
      );
      setSelected(failedKeys);
      setError(RESUME_ERROR);
    } catch (error: unknown) {
      reportRendererConsoleError('Failed to resume interrupted sessions', {
        error,
      });
      setError(RESUME_ERROR);
    } finally {
      confirmingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  /** Track a focused control whose operation may replace it. */
  const beginFocusHandoff = (
    key: string,
    control: HTMLButtonElement,
  ): FocusHandoff | null => {
    if (document.activeElement !== control) {
      focusHandoffRef.current = null;
      return null;
    }
    const handoff: FocusHandoff = {
      key,
      generation: generationRef.current,
      control,
      replacement: null,
      settled: false,
    };
    focusHandoffRef.current = handoff;
    return handoff;
  };

  const settleFocusHandoff = (
    handoff: FocusHandoff | null,
    replacement: InterruptedResumeOperation | null,
  ): void => {
    if (!handoff || focusHandoffRef.current !== handoff) return;
    handoff.replacement = replacement;
    handoff.settled = true;
    setFocusHandoffTick((tick) => tick + 1);
  };

  const scheduleFromRow = async (
    session: UsageLimitedSessionItem,
    control: HTMLButtonElement,
  ): Promise<void> => {
    if (scheduling.isBusy(session)) return;
    const key = targetKey(session);
    const generation = generationRef.current;
    const handoff = beginFocusHandoff(key, control);
    setOwnership((current) =>
      current.generation === generation
        ? { ...current, provisional: new Set(current.provisional).add(key) }
        : current,
    );
    // Remember create broadcasts even if a later deletion/firing broadcast
    // arrives before the response. That authoritative absence must win over
    // the response snapshot instead of reviving stale confirmation and Undo.
    const observedIds = new Set<string>();
    const stopObserving = useAutomationsStore.subscribe((state) => {
      for (const activity of state.activities) observedIds.add(activity.id);
    });
    const result = await scheduling.schedule(session).finally(stopObserving);
    if (result.kind === 'busy') return;
    setOwnership((current) => {
      if (current.generation !== generation) return current;
      const provisional = new Set(current.provisional);
      provisional.delete(key);
      if (result.kind !== 'scheduled' || !result.owned) {
        return { ...current, provisional };
      }
      const owned = new Map(current.owned);
      owned.set(key, {
        ...result.owned,
        seen: observedIds.has(result.owned.activity.id),
      });
      return { ...current, provisional, owned };
    });
    settleFocusHandoff(
      handoff,
      result.kind === 'scheduled' && result.owned
        ? 'undo'
        : result.kind === 'failed'
          ? 'schedule'
          : null,
    );
  };

  const undoSchedule = async (
    session: UsageLimitedSessionItem,
    control: HTMLButtonElement,
  ): Promise<void> => {
    const key = targetKey(session);
    const record = ownership.owned.get(key);
    if (!record || scheduling.isBusy(session)) return;
    const generation = generationRef.current;
    const handoff = beginFocusHandoff(key, control);
    const result = await scheduling.unschedule(session, record, {
      awaitingListing: !record.seen,
    });
    if (result.kind === 'busy') return;
    if (result.kind === 'removed' || result.kind === 'missing') {
      setOwnership((current) => {
        if (
          current.generation !== generation ||
          current.owned.get(key)?.activity.id !== record.activity.id
        ) {
          return current;
        }
        const owned = new Map(current.owned);
        owned.delete(key);
        return {
          ...current,
          owned,
          removedIds:
            result.kind === 'removed'
              ? new Set(current.removedIds).add(record.activity.id)
              : current.removedIds,
        };
      });
    }
    settleFocusHandoff(handoff, result.kind === 'failed' ? 'undo' : 'schedule');
  };

  const controlRef =
    (key: string, control: InterruptedResumeOperation) =>
    (element: HTMLButtonElement | null): void => {
      const refKey = `${key}:${control}`;
      if (element) controlRefs.current.set(refKey, element);
      else controlRefs.current.delete(refKey);
    };

  const renderScheduleControl = (
    session: UsageLimitedSessionItem,
    readiness: SessionResumeReadiness,
    describedBy: string,
  ): JSX.Element | null => {
    const key = targetKey(session);
    const operation = scheduling.operations.get(key);
    const owned = ownership.owned.get(key);
    const ownedActivity = owned
      ? currentOwnedActivity(owned, scheduleActivities, nowMs)
      : null;
    // A schedule this opening owns stays confirmable and undoable even if the
    // limit clears before it runs.
    if (readiness.state !== 'waiting' && !ownedActivity) return null;
    const suffix =
      session.kind === 'chat'
        ? `chat-${session.chatId}`
        : `pipeline-${session.executionId}`;
    // While scheduling, an early broadcast doesn't replace the pending state.
    const scheduledAt =
      operation === 'schedule'
        ? null
        : (ownedActivity?.nextRunAt ??
          findScheduledInterruptedResumeActivity(
            scheduleActivities,
            scheduling.schedulingTarget(session),
            nowMs,
          )?.nextRunAt ??
          null);
    const beforeReset =
      scheduledAt !== null &&
      readiness.state === 'waiting' &&
      readiness.resetMs !== undefined &&
      Date.parse(scheduledAt) < readiness.resetMs;
    const busy = operation !== undefined || submitting;
    return (
      <span className="shrink-0">
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid={`usage-limit-resume-schedule-status-${suffix}`}
          className={scheduledAt ? 'text-xs fg-secondary' : 'sr-only'}
        >
          {scheduledAt ? (
            <span data-testid={`usage-limit-resume-scheduled-${suffix}`}>
              Scheduled for {formatUsageLimitTimeLabel(scheduledAt)}
              {beforeReset ? ', before the reset' : ''}
            </span>
          ) : operation === 'schedule' ? (
            'Scheduling…'
          ) : null}
        </span>
        {!scheduledAt ? (
          <Button
            ref={controlRef(key, 'schedule')}
            variant="ghost-quiet"
            size="compact"
            data-testid={`usage-limit-resume-schedule-${suffix}`}
            aria-describedby={describedBy}
            aria-busy={operation === 'schedule'}
            disabled={busy}
            onClick={(event): void => {
              void scheduleFromRow(session, event.currentTarget);
            }}
          >
            {operation === 'schedule' ? 'Scheduling…' : 'Resume at reset'}
          </Button>
        ) : ownedActivity ? (
          <>
            <span aria-hidden="true" className="text-xs fg-secondary">
              {' · '}
            </span>
            <Button
              ref={controlRef(key, 'undo')}
              variant="ghost-quiet"
              size="compact"
              data-testid={`usage-limit-resume-undo-schedule-${suffix}`}
              aria-describedby={describedBy}
              aria-busy={operation === 'undo'}
              disabled={busy}
              onClick={(event): void => {
                void undoSchedule(session, event.currentTarget);
              }}
            >
              {operation === 'undo' ? 'Undoing…' : 'Undo'}
            </Button>
          </>
        ) : null}
      </span>
    );
  };

  const renderSessionRow = (
    session: UsageLimitedSessionItem,
    indent: 'group' | 'worktree',
  ): JSX.Element => {
    const key = targetKey(session);
    const readiness = readinessByKey.get(key);
    const selectable = isEligible(session);
    const workspaceType = workspaceTypes.get(key);
    const hasWorktree =
      workspaceType === 'single-repo' || workspaceType === 'multi-repo';
    const checkboxId = interruptedSessionDomId(
      'usage-limit-resume-session',
      key,
    );
    const metadataId = `${checkboxId}-metadata`;
    const scheduleError = scheduling.errors[key];
    return (
      <InterruptedSessionRow
        childrenGap="tight"
        key={key}
        indent={indent}
        title={interruptedSessionTitle(session)}
        selection={{
          id: checkboxId,
          testId: interruptedSessionCheckboxTestId(session),
          describedBy: metadataId,
          checked: effectiveSelected.has(key),
          disabled: !selectable,
          onChange: (): void => toggleSession(session),
        }}
        replayMaskTitle
        disabled={!selectable}
        metadataId={metadataId}
        metadataTestId={`${interruptedSessionCheckboxTestId(session)}-metadata`}
        metadata={interruptedSessionMetadata(session, readiness)}
        secondaryMetadata={
          session.kind === 'chat' ? (
            <ChatSecondaryMetadata
              session={session}
              hasWorktree={hasWorktree}
              now={now}
              showEveryResumeEffect={showEveryResumeEffect}
            />
          ) : (
            interruptedSessionSecondaryMetadata(session)
          )
        }
        replayMaskSecondaryMetadata
        trailing={
          gated && readiness
            ? renderScheduleControl(session, readiness, metadataId)
            : null
        }
      >
        <ErrorBanner error={scheduleError} className="" />
      </InterruptedSessionRow>
    );
  };

  return (
    <DialogModal
      inset="flush"
      onClose={closePrompt}
      maxWidth="lg"
      title={title}
      subtitle={subtitle}
    >
      <div data-testid="usage-limit-resume-modal" className="flex flex-col">
        {origin === 'authentication' &&
          authentication?.phase === 'verification-failed' && (
            <div className="px-6 pt-4">
              <ErrorBanner
                className=""
                error={
                  authentication.error || "Couldn't verify your Codex sign-in."
                }
                onRetry={(): void => {
                  void window.api.codexLogin
                    .retryVerification()
                    .then((state) =>
                      useUsageLimitResumePromptStore
                        .getState()
                        .updateAuthentication(state),
                    );
                }}
              />
            </div>
          )}
        {origin === 'authentication' &&
          authentication?.phase === 'complete' &&
          !authentication.account?.authenticated && (
            <p className="px-6 py-4 text-s fg-secondary">
              Codex is signed out. Sign in before resuming this work.
            </p>
          )}
        {effectDisclosure ? (
          <p
            data-testid="usage-limit-resume-effect"
            className="px-6 pt-3 pb-2 text-s fg-secondary"
          >
            {effectDisclosure}
          </p>
        ) : null}
        <div className="flex items-center justify-between border-b px-6 py-2">
          {/* Pulled out by its own inset so the label stays on the rows'
              left edge. */}
          <Button
            variant="ghost"
            size="compact"
            data-testid="usage-limit-resume-select-all"
            onClick={toggleAll}
            disabled={eligibleSessions.length === 0}
            className="-ml-3"
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </Button>
          {gated ? (
            <span
              role="status"
              data-testid="usage-limit-resume-readiness-summary"
              className="text-xs fg-secondary"
            >
              {resumeReadinessSummaryText(readinessSummary)}
            </span>
          ) : null}
        </div>
        <div
          className={`flex max-h-[50vh] flex-col gap-2 overflow-y-auto px-6 pt-2 [&>*]:shrink-0 ${groups.length > 0 ? 'pb-5' : error ? 'pb-4' : 'pb-2'}`}
        >
          <ErrorBanner error={error} className="" />
          {groups.length > 0 && (
            <div className="flex flex-col gap-3">
              {groups.map((group) => {
                const workspaceState = triState(group.sessions);
                const groupLabelId = interruptedSessionDomId(
                  'usage-limit-resume-group',
                  group.groupId,
                );
                return (
                  <div
                    key={group.groupId}
                    role="group"
                    aria-labelledby={groupLabelId}
                    className=""
                  >
                    {/* One label: the icon and name toggle the checkbox too. */}
                    <div className="py-1">
                      <ChoiceField
                        data-testid={`usage-limit-resume-workspace-${group.groupId}`}
                        checked={workspaceState.checked}
                        indeterminate={
                          workspaceState.indeterminate &&
                          !workspaceState.checked
                        }
                        disabled={workspaceState.disabled}
                        onChange={(): void => toggleWorkspace(group)}
                        label={
                          <span className="flex min-w-0 items-center gap-2 font-medium">
                            <ResumeWorkspaceIcon group={group} />
                            <span id={groupLabelId} className="truncate">
                              {group.workspaceName}
                            </span>
                          </span>
                        }
                      />
                    </div>
                    {group.workspaceType === 'cowork'
                      ? readyFirst(group.sessions, isEligible).map((session) =>
                          renderSessionRow(session, 'group'),
                        )
                      : groupSessionsByWorktree(group.sessions).map(
                          (worktree) => {
                            const worktreeState = triState(worktree.sessions);
                            const worktreeLabelId = `${groupLabelId}-${interruptedSessionDomId('worktree', worktree.worktreeId)}`;
                            return (
                              <div
                                key={worktree.worktreeId}
                                role="group"
                                aria-labelledby={worktreeLabelId}
                                className="pl-6"
                              >
                                <div className="py-1">
                                  <ChoiceField
                                    data-testid={`usage-limit-resume-worktree-${group.groupId}-${worktree.worktreeId}`}
                                    checked={worktreeState.checked}
                                    indeterminate={
                                      worktreeState.indeterminate &&
                                      !worktreeState.checked
                                    }
                                    disabled={worktreeState.disabled}
                                    onChange={(): void =>
                                      toggleSessions(worktree.sessions)
                                    }
                                    label={
                                      <span className="flex min-w-0 items-center gap-2 fg-secondary">
                                        <AppCatalogBranchIcon
                                          aria-hidden="true"
                                          size="sm"
                                          className="shrink-0 opacity-70"
                                        />
                                        <span
                                          id={worktreeLabelId}
                                          className="truncate"
                                        >
                                          {worktree.worktreeName}
                                        </span>
                                      </span>
                                    }
                                  />
                                </div>
                                {readyFirst(worktree.sessions, isEligible).map(
                                  (session) =>
                                    renderSessionRow(session, 'worktree'),
                                )}
                              </div>
                            );
                          },
                        )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 border-t px-6 py-3">
          <Button
            size="compact"
            data-testid="usage-limit-resume-cancel"
            onClick={closePrompt}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            data-testid="usage-limit-resume-confirm"
            disabled={
              selectedCount === 0 ||
              submitting ||
              (origin === 'authentication' &&
                (authentication?.phase !== 'complete' ||
                  !authentication.account?.authenticated))
            }
            onClick={(): void => {
              void confirm();
            }}
          >
            {submitting
              ? 'Adding to queue…'
              : resumeConfirmLabel(countInterruptedWork(selectedSessions))}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}

export const UsageLimitResumeModal = memo(UsageLimitResumeModalContent);
