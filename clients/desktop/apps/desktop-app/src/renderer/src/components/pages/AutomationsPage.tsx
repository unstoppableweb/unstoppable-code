// Automations panel: the Automations and Watchers tabs of the Workflows page
// (CAN-3980), reached via the left-nav `Workflows` entry. Triggered activities are owned by
// the renderer-side `useAutomationsStore` (which mirrors the persisted main
// process snapshot); Watchers is a thin presentational reuse of the App
// Advisor watcher store + the new `WatcherManagementButton`/modal helpers.
//
// This module re-exports the reusable form state (`FormState`,
// `activityToFormState`, `buildTrigger`, `buildAction`) so adjacent
// automation surfaces keep their imports. The form state lives in
// `automations/form/automationFormState` and the fields in
// `automations/form/ActivityFormBody`; the form itself opens in the
// Workflows edit shell (CAN-4072).
/* eslint-disable react-refresh/only-export-components */

import { Count } from '@canopy/ui-shared/components/Badge';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { PageTitlebar } from '../shared/PageTitlebar';
import { WorkflowsPageHeader } from '../workflows/WorkflowsPageHeader';
import { WorkflowsTabPanel } from '../workflows/WorkflowsTabPanel';
import { PageContent } from '../shared/PageContent';
import { useShallow } from 'zustand/react/shallow';
import type {
  AutomationAction,
  AutomationMutationResponse,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import {
  describeAutomationAction,
  getAutomationTriggerLabel,
  getNextAutomationTriggerRun,
  type AutomationActionNameResolver,
} from '@canopy/desktop-shared/lib/automations';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { getChatTabLabel } from '@/lib/chatTabLabel';
import { AutomationsCalendar } from '@/components/automations/calendar/AutomationsCalendar';
import { ViewModePicker } from '@/components/automations/calendar/ViewModePicker';
import {
  automationRevealNoticeCopy,
  automationRevealRowCue,
  type AutomationRevealOutcome,
} from '@/components/automations/automationRevealNotice';
import { prefersReducedMotion } from '@canopy/ui-shared/lib';
import { automationRunsInMessage } from '@canopy/execution-engine/lib/automation-context-copy';
import {
  loadCalendarView,
  loadViewMode,
  saveCalendarView,
  saveViewMode,
  type AutomationsViewMode,
  type CalendarView,
} from '@/components/automations/calendar/calendarPreferences';
import { formatRelativeTime } from '@/lib/format';
import { automationDuplicateRequest } from '@/lib/workflows/automation-duplicate';
import {
  ChevronDownIcon,
  PipelineIcon,
  PlayCircleIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons';
import {
  DocumentPencilIcon,
  ShareIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ShareAutomationModal } from '@/components/automations/ShareAutomationModal';
import { ReviewSharedPipelineChangeModal } from '@/components/automations/ReviewSharedPipelineChangeModal';
import {
  useAutomationScope,
  type AutomationScope,
} from '@/hooks/useAutomationScope';
import { TableActionButton, TableActionsCell } from '@canopy/ui-shared';
import {
  Button,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  Dot,
  type DotTone,
  FloatingPickerMenu,
  Notice,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  Surface,
} from '@canopy/ui-shared/components';
import {
  cycleTriggeredSort,
  loadTriggeredSort,
  saveTriggeredSort,
  sortTriggeredActivityRows,
  triggeredActivityStatusLabel,
  type TriggeredActivityRow,
  type TriggeredSortColumn,
  type TriggeredSortState,
} from '@/components/automations/triggeredActivitySort';

export {
  actionCategoryForType,
  activityToFormState,
  applyAppAdvisorActionCategorySelection,
  applyAppAdvisorRunModeSelection,
  applyChatRunModeSelection,
  applyChatTargetSelection,
  applyWorkspaceActionSelection,
  automationFormActionCategory,
  automationFormChatRunMode,
  automationFormChatTarget,
  automationFormSidebarGroupScope,
  buildAction,
  buildTrigger,
  clearedPipelineSelection,
  emptyFormState,
  hasChatAuthoredPayload,
  isAppAdvisorSessionPrompt,
  isPreviouslyTriggeredOneTime,
  resolveRepickedSharedPipeline,
  selectedAutomationWorkspaceId,
  workspaceActionModeForType,
  type ActionCategory,
  type FormState,
  type WorkspaceActionMode,
} from '../automations/form/automationFormState';
import {
  getAutomationWorktreeLabel,
  isPreviouslyTriggeredOneTime,
} from '../automations/form/automationFormState';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';

function formatNextRunPreview(date: Date | null): string | null {
  if (!date) return null;
  try {
    return date.toLocaleString();
  } catch {
    return date.toISOString();
  }
}

/**
 * A reveal accepted from the navigation store (CAN-3651). `token` is unique
 * per accepted request so scroll and focus happen once per request, even when
 * the same activity is revealed twice.
 */
interface AutomationRevealState {
  activityId: string;
  outcome: AutomationRevealOutcome;
  token: number;
  status: 'resolving' | 'shown' | 'unavailable';
}

/** The revealed row as the Triggered tab sees it. */
interface TriggeredRevealTarget {
  activityId: string;
  outcome: AutomationRevealOutcome;
  token: number;
}

/**
 * Bounds the refresh used to resolve a reveal: one requested load, plus one
 * more only when a context switch discarded the first before it hydrated.
 */
const REVEAL_REFRESH_ATTEMPTS = 2;

/**
 * What the page's body works with: the automations it loaded, the scope, and
 * the row handlers and reveal state it owns. The Workflows tabs (CAN-3981)
 * draw their own surfaces from this instead of the page's lists.
 */
export interface AutomationsPageBodyApi {
  /** Every automation, in or out of the selected context. */
  readonly activities: readonly ScheduledActivity[];
  /** Automations in the selected context. */
  readonly scopedActivities: readonly ScheduledActivity[];
  readonly recentRuns: readonly ScheduledActivityRun[];
  /** The first load has not finished. */
  readonly loading: boolean;
  readonly error: string | null;
  /** Loads the automations again, such as after a failed load. */
  readonly reload: () => Promise<void>;
  readonly mutationError: string | null;
  readonly scope: AutomationScope;
  readonly describeAction: (action: AutomationAction) => string;
  readonly beginCreate: () => void;
  readonly beginEdit: (activity: ScheduledActivity) => void;
  /** Opens an automation's run history. */
  readonly beginView: (activity: ScheduledActivity) => void;
  /**
   * Runs the automation now and reports how that call went. An automation
   * whose shared workflow changed opens its review instead, which is not a
   * failure.
   */
  readonly runNow: (
    activity: ScheduledActivity,
  ) => Promise<AutomationMutationResponse>;
  /** Turns the automation on or off and reports how that call went. */
  readonly toggleEnabled: (
    activity: ScheduledActivity,
  ) => Promise<AutomationMutationResponse>;
  /** Adds a copy of the automation, switched off, and reports how it went. */
  readonly duplicate: (
    activity: ScheduledActivity,
  ) => Promise<AutomationMutationResponse>;
  readonly share: (activity: ScheduledActivity) => void;
  /**
   * Deletes the automation; throws with the refusal. With `workflow`, a
   * workflow schedule takes its whole workflow page with it (CAN-5782).
   */
  readonly remove: (
    activity: ScheduledActivity,
    options?: { workflow?: boolean },
  ) => Promise<void>;
  /** The automation whose Run now is in flight. */
  readonly runningActivityId: string | null;
  /** A just-installed or just-updated automation to point at (CAN-3651). */
  readonly revealedActivityId: string | null;
  readonly revealNotice: ReactNode;
  readonly endReveal: () => void;
}

export interface AutomationsPageProps {
  /**
   * Draws the page body. Omit for the page's own lists. The form, the run
   * history, the shared-pipeline review and the Share dialog stay with the
   * page either way.
   */
  readonly renderBody?: (api: AutomationsPageBodyApi) => ReactNode;
}

export function AutomationsPage({
  renderBody,
}: AutomationsPageProps): JSX.Element {
  const {
    activities,
    recentRuns,
    loading,
    hydrated,
    error,
    mutationError,
    updateActivity,
    deleteActivity,
    runNow,
    createActivity,
    clearMutationError,
  } = useAutomationsStore(
    useShallow((s) => ({
      activities: s.activities,
      recentRuns: s.recentRuns,
      loading: s.loading,
      hydrated: s.hydrated,
      error: s.error,
      mutationError: s.mutationError,
      updateActivity: s.updateActivity,
      deleteActivity: s.deleteActivity,
      runNow: s.runNow,
      createActivity: s.createActivity,
      clearMutationError: s.clearMutationError,
    })),
  );

  useEffect(() => {
    const store = useAutomationsStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);

  // The Runs feed lists watchers, so the page keeps their store current.
  useEffect(() => {
    const store = useAppAdvisorWatchersStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);

  const chatProjects = useStandaloneChatStore((s) => s.chatProjects);
  const chatProjectsLoaded = useStandaloneChatStore(
    (s) => s.chatProjectsLoaded,
  );
  const loadChatProjects = useStandaloneChatStore((s) => s.loadChatProjects);
  useEffect(() => {
    if (!chatProjectsLoaded) {
      void loadChatProjects();
    }
  }, [chatProjectsLoaded, loadChatProjects]);
  const projects = useProjectsStore((s) => s.projects);
  const actionNameResolver = useMemo<AutomationActionNameResolver>(
    () => ({
      standaloneChatProjectName: (chatProjectId): string | undefined =>
        chatProjects.find((project) => project.id === chatProjectId)?.name,
      workspaceName: (workspaceId): string | undefined => {
        const project = projects.find((entry) => entry.id === workspaceId);
        return project ? getWorkspaceDisplayName(project) : undefined;
      },
      worktreeName: (workspaceId, worktreeId): string | undefined => {
        const project = projects.find((entry) => entry.id === workspaceId);
        const worktree =
          project && project.type !== 'cowork'
            ? project.worktrees.find((w) => w.id === worktreeId)
            : undefined;
        return worktree ? getAutomationWorktreeLabel(worktree) : undefined;
      },
      chatTitle: (workspaceId, worktreeId, chatId): string | undefined => {
        const worktreeChat =
          useChatStore.getState().worktreeChats[`${workspaceId}/${worktreeId}`];
        const tab = worktreeChat?.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        return tab ? getChatTabLabel(tab) : undefined;
      },
    }),
    [chatProjects, projects],
  );
  const describeAction = useCallback(
    (action: AutomationAction): string =>
      describeAutomationAction(action, actionNameResolver),
    [actionNameResolver],
  );

  // Held by id so the modal always reads the live activity from the store.
  const [reviewingActivityId, setReviewingActivityId] = useState<string | null>(
    null,
  );
  const reviewingActivity = useMemo(
    () =>
      reviewingActivityId
        ? (activities.find((entry) => entry.id === reviewingActivityId) ?? null)
        : null,
    [activities, reviewingActivityId],
  );
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(
    null,
  );
  const [activityDeleting, setActivityDeleting] = useState<string | null>(null);
  const [activityRunning, setActivityRunning] = useState<string | null>(null);
  const [reveal, setReveal] = useState<AutomationRevealState | null>(null);
  const revealTokenRef = useRef(0);

  // Lists follow the sidebar's Personal/organization context (CAN-3448).
  // Deep links, reviews and installed-copy detection keep the full list so an
  // out-of-context automation still opens.
  const scope = useAutomationScope();
  const scopedActivities = useMemo(
    () => activities.filter(scope.inContext),
    [activities, scope],
  );
  const enabledActivityCount = useMemo(
    () => scopedActivities.filter((activity) => activity.enabled).length,
    [scopedActivities],
  );
  const previouslyTriggeredCount = useMemo(
    () => scopedActivities.filter(isPreviouslyTriggeredOneTime).length,
    [scopedActivities],
  );

  const [shareActivity, setShareActivity] = useState<ScheduledActivity | null>(
    null,
  );
  const openAccountSettings = useCallback(
    (): void => openCloudAccountSettings(),
    [],
  );
  const handleShare = useCallback((activity: ScheduledActivity): void => {
    setShareActivity(activity);
  }, []);

  useCurrentUiStateReporter('automations.page', {
    activeTab: 'scheduled',
    activityCount: scopedActivities.length,
    enabledActivityCount,
    previouslyTriggeredCount,
    ...(selectedActivityId ? { selectedActivityId } : {}),
    sharedPipelineReviewModalOpen: reviewingActivity !== null,
    ...(reviewingActivity
      ? { sharedPipelineReviewActivityId: reviewingActivity.id }
      : {}),
    shareModalOpen: shareActivity !== null,
    ...(shareActivity ? { shareModalActivityId: shareActivity.id } : {}),
    ...(reveal?.status === 'shown'
      ? { revealedActivityId: reveal.activityId }
      : {}),
  });

  // -------------------------------------------------------------------------
  // Form helpers
  // -------------------------------------------------------------------------

  // The form and the run history open in the Workflows edit shell
  // (CAN-4072), which loads the automation from the store itself.
  const beginCreate = useCallback(() => {
    clearMutationError();
    useNavigationStore.getState().openAutomationDraft();
  }, [clearMutationError]);

  // Working with another row ends a reveal; opening the revealed row's own
  // details or editor keeps its cue.
  const endRevealUnlessFor = useCallback((activityId: string): void => {
    setReveal((current) =>
      current !== null && current.activityId !== activityId ? null : current,
    );
  }, []);

  const beginEdit = useCallback(
    (activity: ScheduledActivity) => {
      setSelectedActivityId(activity.id);
      endRevealUnlessFor(activity.id);
      clearMutationError();
      useNavigationStore.getState().openAutomationEdit({
        activityId: activity.id,
      });
    },
    [clearMutationError, endRevealUnlessFor],
  );

  const beginView = useCallback(
    (activity: ScheduledActivity) => {
      setSelectedActivityId(activity.id);
      endRevealUnlessFor(activity.id);
      useNavigationStore.getState().openAutomationEdit({
        activityId: activity.id,
        section: 'runs',
      });
    },
    [endRevealUnlessFor],
  );

  // An edit link or another surface opening a different automation in the
  // shell supersedes a reveal, as working with another row does; the
  // revealed automation's own shell keeps its cue.
  const shellActivityId = useNavigationStore((s) =>
    s.workflowEdit?.kind === 'automation' ? s.workflowEdit.activityId : null,
  );
  useEffect(() => {
    if (shellActivityId !== null) endRevealUnlessFor(shellActivityId);
  }, [endRevealUnlessFor, shellActivityId]);

  const pendingAutomationSharedPipelineReview = useNavigationStore(
    (s) => s.pendingAutomationSharedPipelineReview,
  );
  useEffect(() => {
    if (!pendingAutomationSharedPipelineReview || !hydrated) return;

    useNavigationStore.getState().consumeAutomationSharedPipelineReview();
    setReveal(null);
    const match = activities.find(
      (candidate) =>
        candidate.id === pendingAutomationSharedPipelineReview.activityId,
    );
    if (match?.sharedPipelineReview) {
      setSelectedActivityId(match.id);
      setReviewingActivityId(match.id);
    }
  }, [pendingAutomationSharedPipelineReview, hydrated, activities]);

  // Consume a reveal request (an install or update finished from a share
  // link) into page-local state right away, hydrated or not, so it can never
  // fire on a later visit. It dies with the page.
  const pendingAutomationReveal = useNavigationStore(
    (s) => s.pendingAutomationReveal,
  );
  useEffect(() => {
    if (!pendingAutomationReveal) return;

    useNavigationStore.getState().consumeAutomationReveal();
    revealTokenRef.current += 1;
    setReviewingActivityId(null);
    setShareActivity(null);
    setActivityDeleting(null);
    setReveal({
      activityId: pendingAutomationReveal.activityId,
      outcome: pendingAutomationReveal.outcome,
      token: revealTokenRef.current,
      status: 'resolving',
    });
  }, [pendingAutomationReveal]);

  // Resolve by exact id against the full list (not the context-filtered
  // one), so another copy of the same share never stands in for it.
  const revealedActivity = useMemo(
    () =>
      reveal
        ? (activities.find((entry) => entry.id === reveal.activityId) ?? null)
        : null,
    [activities, reveal],
  );
  const revealResolving = reveal?.status === 'resolving';
  const revealFound = revealedActivity !== null;
  useEffect(() => {
    if (!revealResolving || !revealFound) return;
    setReveal((current) =>
      current?.status === 'resolving'
        ? { ...current, status: 'shown' }
        : current,
    );
  }, [revealFound, revealResolving]);

  // Not in the list yet: request the existing load action and wait for that
  // request itself to finish. A refresh that ends without the id (or fails)
  // ends the reveal honestly instead of polling. A newer request, unmount,
  // or the id arriving through the bridge cancels this attempt.
  const resolvingToken = revealResolving ? reveal.token : null;
  const resolvingActivityId = revealResolving ? reveal.activityId : null;
  useEffect(() => {
    if (resolvingToken === null || resolvingActivityId === null) return;
    if (
      useAutomationsStore
        .getState()
        .activities.some((entry) => entry.id === resolvingActivityId)
    ) {
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      for (let attempt = 0; attempt < REVEAL_REFRESH_ATTEMPTS; attempt += 1) {
        await useAutomationsStore.getState().hydrate({ joinInFlight: true });
        if (cancelled) return;
        const state = useAutomationsStore.getState();
        // Found: the list effect above marks the reveal shown.
        if (state.activities.some((entry) => entry.id === resolvingActivityId))
          return;
        if (state.hydrated || state.error !== null) break;
      }
      if (cancelled) return;
      setReveal((current) =>
        current?.token === resolvingToken && current.status === 'resolving'
          ? { ...current, status: 'unavailable' }
          : current,
      );
    })();
    return (): void => {
      cancelled = true;
    };
  }, [resolvingActivityId, resolvingToken]);

  // Select the revealed row once it is shown, but only when the selected
  // context lists it; an out-of-context target gets the notice alone.
  const revealShownToken = reveal?.status === 'shown' ? reveal.token : null;
  const revealVisible =
    revealedActivity !== null && scope.inContext(revealedActivity);
  const revealSelectedTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (revealShownToken === null || reveal === null || !revealVisible) return;
    if (revealSelectedTokenRef.current === revealShownToken) return;
    revealSelectedTokenRef.current = revealShownToken;
    setSelectedActivityId(reveal.activityId);
  }, [reveal, revealShownToken, revealVisible]);

  // The target was deleted after it was shown.
  useEffect(() => {
    if (reveal?.status === 'shown' && hydrated && !revealFound) {
      setReveal(null);
    }
  }, [hydrated, reveal?.status, revealFound]);

  const endReveal = useCallback((): void => {
    setReveal(null);
  }, []);

  const handleSelectActivity = useCallback((id: string | null): void => {
    setSelectedActivityId(id);
    setReveal((current) =>
      current !== null && current.activityId !== id ? null : current,
    );
  }, []);

  const revealNotice = ((): JSX.Element | null => {
    if (reveal === null || reveal.status === 'resolving') return null;
    let runsInLabel: string | null = null;
    if (revealedActivity !== null && !revealVisible) {
      runsInLabel = scope.runsInLabel(revealedActivity);
      // An off automation has not acquired an execution context yet. Name
      // its saved target's owner instead, using the existing context label.
      if (runsInLabel === null) {
        const action = revealedActivity.action;
        const targetId =
          'workspaceId' in action
            ? action.workspaceId
            : action.type === 'standalone_prompt'
              ? action.chatProjectId
              : undefined;
        const project = projects.find((entry) => entry.id === targetId);
        if (project) {
          runsInLabel = automationRunsInMessage(
            scope.labelForWorkspace(project),
          );
        }
      }
    }
    const copy = automationRevealNoticeCopy(
      reveal.outcome,
      reveal.status === 'unavailable' || revealedActivity === null
        ? { kind: 'unavailable' }
        : {
            kind: 'shown',
            enabled: revealedActivity.enabled,
            runsInLabel,
          },
    );
    return (
      <Notice
        intent="positive"
        role="status"
        title={copy.title}
        onDismiss={endReveal}
        dismissLabel={copy.dismissLabel}
        dismissTestId="automations-installed-notice-dismiss"
        data-testid="automations-installed-notice"
      >
        {copy.message}
      </Notice>
    );
  })();

  const revealTarget: TriggeredRevealTarget | null =
    reveal?.status === 'shown' && revealVisible
      ? {
          activityId: reveal.activityId,
          outcome: reveal.outcome,
          token: reveal.token,
        }
      : null;

  // -------------------------------------------------------------------------
  // Activity actions
  // -------------------------------------------------------------------------

  const handleToggleEnabled = useCallback(
    (activity: ScheduledActivity): Promise<AutomationMutationResponse> =>
      updateActivity({ id: activity.id, enabled: !activity.enabled }),
    [updateActivity],
  );

  const handleDuplicate = useCallback(
    (activity: ScheduledActivity): Promise<AutomationMutationResponse> =>
      createActivity(automationDuplicateRequest(activity)),
    [createActivity],
  );

  const handleReview = useCallback(
    (activity: ScheduledActivity): void => {
      setSelectedActivityId(activity.id);
      endRevealUnlessFor(activity.id);
      setReviewingActivityId(activity.id);
    },
    [endRevealUnlessFor],
  );

  const handleRunNow = useCallback(
    async (
      activity: ScheduledActivity,
    ): Promise<AutomationMutationResponse> => {
      // A changed shared pipeline must be reviewed before it can run again.
      if (activity.sharedPipelineReview) {
        handleReview(activity);
        return { ok: true };
      }
      setActivityRunning(activity.id);
      try {
        return await runNow(activity.id);
      } finally {
        setActivityRunning(null);
      }
    },
    [handleReview, runNow],
  );

  const handleDelete = useCallback(
    async (activity: ScheduledActivity): Promise<void> => {
      if (activityDeleting === activity.id) {
        await deleteActivity(activity.id);
        setActivityDeleting(null);
        return;
      }
      setActivityDeleting(activity.id);
    },
    [activityDeleting, deleteActivity],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const modals = (
    <>
      {reviewingActivity && (
        <ReviewSharedPipelineChangeModal
          activity={reviewingActivity}
          onClose={(): void => setReviewingActivityId(null)}
        />
      )}
      {shareActivity && (
        <ShareAutomationModal
          key={shareActivity.id}
          activity={shareActivity}
          onClose={(): void => setShareActivity(null)}
          onOpenAccountSettings={openAccountSettings}
          onShared={(): void => {
            // The main-process handler persists remote metadata and the
            // service broadcast refreshes the store; nothing to reload here.
          }}
        />
      )}
    </>
  );

  if (renderBody) {
    return (
      <>
        {renderBody({
          activities,
          scopedActivities,
          recentRuns,
          loading: loading && !hydrated,
          error,
          reload: () => useAutomationsStore.getState().hydrate(),
          mutationError,
          scope,
          describeAction,
          beginCreate,
          beginEdit,
          beginView,
          runNow: handleRunNow,
          toggleEnabled: handleToggleEnabled,
          duplicate: handleDuplicate,
          share: handleShare,
          remove: async (activity, options): Promise<void> => {
            const response = await deleteActivity(activity.id, options);
            if (!response.ok) throw new Error(response.error);
          },
          runningActivityId: activityRunning,
          revealedActivityId: revealTarget?.activityId ?? null,
          revealNotice,
          endReveal,
        })}
        {modals}
      </>
    );
  }

  return (
    <div
      className="page-scroll-gutter flex h-full w-full flex-col overflow-y-auto"
      data-testid="page-automations"
    >
      <PageTitlebar />
      <PageContent className="flex flex-1 flex-col">
        <WorkflowsPageHeader
          actions={
            <Button
              variant="primary"
              size="compact"
              onClick={beginCreate}
              data-testid="automations-new-activity"
            >
              New automation
            </Button>
          }
        />
        <WorkflowsTabPanel className="flex flex-1 flex-col">
          {(error || mutationError) && (
            <div className="flex flex-col gap-3 pt-3">
              {error && (
                <Notice errorSource="automations-page" intent="destructive">
                  Could not load automations.
                </Notice>
              )}
              {mutationError && (
                <Notice
                  errorSource="automations-mutation-error"
                  intent="destructive"
                  data-testid="automations-mutation-error"
                >
                  {mutationError}
                </Notice>
              )}
            </div>
          )}
          <TriggeredActivitiesTab
            activities={scopedActivities}
            hiddenByContextLabel={
              scopedActivities.length < activities.length
                ? scope.contextLabel
                : null
            }
            loading={loading && !hydrated}
            onRunNow={handleRunNow}
            onReview={handleReview}
            onToggleEnabled={handleToggleEnabled}
            onEdit={beginEdit}
            onView={beginView}
            onShare={handleShare}
            onDelete={handleDelete}
            activityDeleting={activityDeleting}
            onDisarmDelete={(): void => setActivityDeleting(null)}
            activityRunning={activityRunning}
            onSelect={handleSelectActivity}
            selectedActivityId={selectedActivityId}
            recentRuns={recentRuns}
            onBeginCreate={beginCreate}
            describeAction={describeAction}
            describeRunsIn={scope.runsInLabel}
            notice={revealNotice}
            revealTarget={revealTarget}
            onRevealEnd={endReveal}
          />
          {modals}
        </WorkflowsTabPanel>
      </PageContent>
    </div>
  );
}

interface TriggeredActivitiesTabProps {
  activities: ScheduledActivity[];
  /** The selected context, when it hides automations from this list. */
  hiddenByContextLabel?: string | null;
  loading: boolean;
  onRunNow: (activity: ScheduledActivity) => Promise<unknown>;
  /** Opens the shared-pipeline review for an automation that needs one. */
  onReview: (activity: ScheduledActivity) => void;
  onToggleEnabled: (activity: ScheduledActivity) => Promise<unknown>;
  onEdit: (activity: ScheduledActivity) => void;
  /** Row/entry click: opens the read-only details modal (not the edit form). */
  onView: (activity: ScheduledActivity) => void;
  onShare: (activity: ScheduledActivity) => void;
  onDelete: (activity: ScheduledActivity) => Promise<void>;
  activityDeleting: string | null;
  /** Disarms the two-step delete without deleting (focus leave / Escape). */
  onDisarmDelete: () => void;
  activityRunning: string | null;
  selectedActivityId: string | null;
  onSelect: (id: string | null) => void;
  recentRuns: ScheduledActivityRun[];
  onBeginCreate: () => void;
  describeAction: (action: AutomationAction) => string;
  describeRunsIn: (activity: ScheduledActivity) => string | null;
  /** Rendered above the list and the empty state alike. */
  notice?: ReactNode;
  /** A just-installed or just-updated row to show (CAN-3651). */
  revealTarget?: TriggeredRevealTarget | null;
  /** An explicit view change ends the reveal. */
  onRevealEnd?: () => void;
}

function TriggeredActivitiesTab({
  activities,
  hiddenByContextLabel = null,
  loading,
  onRunNow,
  onReview,
  onToggleEnabled,
  onEdit,
  onView,
  onShare,
  onDelete,
  activityDeleting,
  onDisarmDelete,
  activityRunning,
  selectedActivityId,
  recentRuns,
  onSelect,
  onBeginCreate,
  describeAction,
  describeRunsIn,
  notice = null,
  revealTarget = null,
  onRevealEnd,
}: TriggeredActivitiesTabProps): JSX.Element {
  // View state for the tab. View mode + calendar sub-view are sticky
  // (localStorage); anchor date and show-disabled are session-only. These are
  // purely a presentation concern of this tab, so they live here and need no
  // new props from AutomationsPage.
  const [viewMode, setViewMode] = useState<AutomationsViewMode>(loadViewMode);
  const [calendarView, setCalendarView] =
    useState<CalendarView>(loadCalendarView);
  const [anchorDate, setAnchorDate] = useState<Date>(() => new Date());
  const [showDisabled, setShowDisabled] = useState<boolean>(false);
  // List sort is sticky too. One state drives both the active table and the
  // Previously Triggered table; `null` keeps the order the store returns.
  const [sort, setSort] = useState<TriggeredSortState | null>(
    loadTriggeredSort,
  );

  const handleSortToggle = useCallback((column: TriggeredSortColumn): void => {
    setSort((current) => cycleTriggeredSort(current, column));
  }, []);
  // Persisted from an effect so the state updater above stays pure. The
  // mount-time write only re-saves what was loaded (or drops a corrupt value).
  useEffect(() => {
    saveTriggeredSort(sort);
  }, [sort]);

  const handleViewModeChange = useCallback(
    (mode: AutomationsViewMode): void => {
      setViewMode(mode);
      saveViewMode(mode);
      onRevealEnd?.();
    },
    [onRevealEnd],
  );
  // A visible reveal shows the list without saving over a calendar
  // preference; the saved mode returns when the reveal ends.
  const effectiveViewMode: AutomationsViewMode =
    revealTarget !== null ? 'list' : viewMode;

  // Scroll to and focus the revealed row once per accepted reveal, after the
  // share landing has closed and restored focus, and after the row mounts.
  const listRef = useRef<HTMLDivElement>(null);
  const focusedRevealTokenRef = useRef<number | null>(null);
  const revealToken = revealTarget?.token ?? null;
  useEffect(() => {
    if (revealToken === null || loading) return undefined;
    if (focusedRevealTokenRef.current === revealToken) return undefined;
    let frame = 0;
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        const row = listRef.current?.querySelector<HTMLElement>(
          '[data-revealed="true"]',
        );
        if (!row) return;
        focusedRevealTokenRef.current = revealToken;
        row.scrollIntoView?.({
          block: 'center',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
        row.focus({ preventScroll: true });
      });
    });
    return (): void => window.cancelAnimationFrame(frame);
  }, [revealToken, loading, activities, effectiveViewMode]);
  const handleCalendarViewChange = useCallback((view: CalendarView): void => {
    setCalendarView(view);
    saveCalendarView(view);
  }, []);
  const handleToggleShowDisabled = useCallback((next: boolean): void => {
    setShowDisabled(next);
  }, []);

  if (loading) {
    return (
      <div className={`flex flex-col gap-6 ${notice ? 'pt-4' : 'pt-6'}`}>
        {notice}
        <div className="text-s fg-secondary">Loading automations…</div>
      </div>
    );
  }
  if (activities.length === 0) {
    return (
      <div className={`flex flex-col gap-12 ${notice ? 'pt-4' : 'pt-12'}`}>
        {notice}
        <div className="flex flex-col items-center gap-3 text-center">
          <p
            className="text-m font-medium fg-primary"
            data-testid="automations-empty-title"
          >
            {hiddenByContextLabel
              ? `No triggered activities in ${hiddenByContextLabel}`
              : 'No triggered activities'}
          </p>
          <p className="text-s fg-secondary">
            {hiddenByContextLabel
              ? 'Create one here, or switch to see the others.'
              : 'Create a scheduled or one-time trigger.'}
          </p>
          <Button
            variant="primary"
            size="compact"
            onClick={onBeginCreate}
            data-testid="automations-empty-new"
          >
            New automation
          </Button>
        </div>
      </div>
    );
  }
  const previouslyTriggered = activities.filter(isPreviouslyTriggeredOneTime);
  const activeActivities = activities.filter(
    (activity) => !isPreviouslyTriggeredOneTime(activity),
  );
  const handlers: TriggeredActivityRowHandlers = {
    onRunNow,
    onReview,
    onToggleEnabled,
    onEdit,
    onView,
    onShare,
    onDelete,
    activityDeleting,
    onDisarmDelete,
    activityRunning,
    selectedActivityId,
    recentRuns,
    onSelect,
    describeAction,
    sort,
    onSortToggle: handleSortToggle,
    describeRunsIn,
    revealTarget,
  };
  const revealInPreviouslyTriggered =
    revealTarget !== null &&
    previouslyTriggered.some(
      (activity) => activity.id === revealTarget.activityId,
    );
  return (
    <div className="flex flex-col gap-4 pt-4">
      {notice}
      <div ref={listRef} className="flex flex-col gap-4">
        <div className="flex items-center">
          <ViewModePicker
            viewMode={effectiveViewMode}
            onChange={handleViewModeChange}
          />
        </div>
        {effectiveViewMode === 'list' ? (
          <>
            {activeActivities.length > 0 ? (
              <div data-testid="automations-active-table">
                <TriggeredActivitiesTable
                  activities={activeActivities}
                  {...handlers}
                />
              </div>
            ) : (
              <Surface variant="dashed">
                <div className="px-3 py-6 text-center text-s fg-secondary">
                  No upcoming triggered activities.
                </div>
              </Surface>
            )}
            {previouslyTriggered.length > 0 && (
              <PreviouslyTriggeredSection
                activities={previouslyTriggered}
                expandForRevealToken={
                  revealInPreviouslyTriggered ? revealToken : null
                }
                {...handlers}
              />
            )}
          </>
        ) : (
          <AutomationsCalendar
            activities={activities}
            recentRuns={recentRuns}
            calendarView={calendarView}
            anchorDate={anchorDate}
            showDisabled={showDisabled}
            selectedActivityId={selectedActivityId}
            onCalendarViewChange={handleCalendarViewChange}
            onAnchorDateChange={setAnchorDate}
            onToggleShowDisabled={handleToggleShowDisabled}
            // Calendar event clicks are entry clicks: they open the read-only
            // details modal, matching the list rows.
            onEdit={onView}
            onSelect={onSelect}
            describeAction={describeAction}
          />
        )}
      </div>
    </div>
  );
}

interface TriggeredActivityRowHandlers {
  onRunNow: (activity: ScheduledActivity) => Promise<unknown>;
  /** Opens the shared-pipeline review for an automation that needs one. */
  onReview: (activity: ScheduledActivity) => void;
  onToggleEnabled: (activity: ScheduledActivity) => Promise<unknown>;
  onEdit: (activity: ScheduledActivity) => void;
  /** Row click: opens the read-only details modal (not the edit form). */
  onView: (activity: ScheduledActivity) => void;
  onShare: (activity: ScheduledActivity) => void;
  onDelete: (activity: ScheduledActivity) => Promise<void>;
  activityDeleting: string | null;
  /** Disarms the two-step delete without deleting (focus leave / Escape). */
  onDisarmDelete: () => void;
  activityRunning: string | null;
  selectedActivityId: string | null;
  recentRuns: ScheduledActivityRun[];
  onSelect: (id: string | null) => void;
  describeAction: (action: AutomationAction) => string;
  /** Shared by the active and Previously Triggered tables; `null` = unsorted. */
  sort: TriggeredSortState | null;
  onSortToggle: (column: TriggeredSortColumn) => void;
  /** `Runs in {context}` under the name; `null` hides it. */
  describeRunsIn: (activity: ScheduledActivity) => string | null;
  /** The just-installed or just-updated row, if it is shown. */
  revealTarget: TriggeredRevealTarget | null;
}

interface TriggeredActivitiesTableProps extends TriggeredActivityRowHandlers {
  activities: ScheduledActivity[];
}

function TriggeredActivitiesTable({
  activities,
  onRunNow,
  onReview,
  onToggleEnabled,
  onEdit,
  onView,
  onShare,
  onDelete,
  activityDeleting,
  onDisarmDelete,
  activityRunning,
  selectedActivityId,
  recentRuns,
  onSelect,
  describeAction,
  sort,
  onSortToggle,
  describeRunsIn,
  revealTarget,
}: TriggeredActivitiesTableProps): JSX.Element {
  // One `now` for the whole table so every row's next run (and the Next
  // trigger sort) is measured from the same instant. Not memoized: `now`
  // changes every render and the list is small.
  const now = new Date();
  const rows: TriggeredActivityRow[] = activities.map((activity) => ({
    activity,
    nextRun: activity.enabled
      ? getNextAutomationTriggerRun(activity.schedule, now)
      : null,
  }));
  const sortedRows = sortTriggeredActivityRows(rows, sort);
  const activeColumn = sort?.column ?? null;
  const direction = sort?.direction ?? null;
  return (
    <DataTableFrame caption="Triggered automations">
      <DataTableHead>
        <DataTableHeaderCell
          sort={{
            direction: activeColumn === 'name' ? direction : null,
            onToggle: (): void => onSortToggle('name'),
            testId: 'automations-sort-name',
          }}
        >
          Name
        </DataTableHeaderCell>
        <DataTableHeaderCell>Trigger</DataTableHeaderCell>
        <DataTableHeaderCell>Action</DataTableHeaderCell>
        <DataTableHeaderCell
          sort={{
            direction: activeColumn === 'nextTrigger' ? direction : null,
            onToggle: (): void => onSortToggle('nextTrigger'),
            testId: 'automations-sort-nextTrigger',
          }}
        >
          Next trigger
        </DataTableHeaderCell>
        <DataTableHeaderCell
          sort={{
            direction: activeColumn === 'lastResult' ? direction : null,
            onToggle: (): void => onSortToggle('lastResult'),
            testId: 'automations-sort-lastResult',
          }}
        >
          Last result
        </DataTableHeaderCell>
        <DataTableHeaderCell
          width="8.75rem"
          sort={{
            direction: activeColumn === 'status' ? direction : null,
            onToggle: (): void => onSortToggle('status'),
            testId: 'automations-sort-status',
          }}
        >
          Status
        </DataTableHeaderCell>
        <DataTableHeaderCell width="8.75rem" align="right">
          Actions
        </DataTableHeaderCell>
      </DataTableHead>
      <DataTableBody>
        {sortedRows.map(({ activity, nextRun }) => {
          const isConfirmingDelete = activityDeleting === activity.id;
          const persistedRunning = recentRuns.some(
            (run) => run.activityId === activity.id && run.status === 'running',
          );
          const isRunning = activityRunning === activity.id || persistedRunning;
          const isRevealed = revealTarget?.activityId === activity.id;
          const isSelected = selectedActivityId === activity.id || isRevealed;
          const runsIn = describeRunsIn(activity);
          return (
            <DataTableRow
              key={activity.id}
              data-testid={`automations-activity-row-${activity.id}`}
              data-revealed={isRevealed ? 'true' : undefined}
              focusable={isRevealed}
              selected={isSelected}
              onActivate={(): void => {
                onSelect(activity.id);
                onView(activity);
              }}
            >
              <DataTableCell tone="primary" overflow="wrap">
                {activity.name}
                {isRevealed && revealTarget !== null && (
                  <span
                    className="block fg-secondary"
                    data-testid={`automations-activity-newly-installed-${activity.id}`}
                  >
                    {automationRevealRowCue(revealTarget.outcome)}
                  </span>
                )}
                {runsIn !== null && (
                  <span
                    className="block fg-tertiary"
                    data-testid={`automations-activity-runs-in-${activity.id}`}
                  >
                    {runsIn}
                  </span>
                )}
              </DataTableCell>
              <DataTableCell overflow="wrap">
                {activity.schedule.kind === 'cron'
                  ? `${getAutomationTriggerLabel(activity.schedule)} · ${activity.schedule.expression}`
                  : `${getAutomationTriggerLabel(activity.schedule)} · ${new Date(activity.schedule.runAt).toLocaleString()}`}
              </DataTableCell>
              {/* Prompt actions quote the prompt, so the cell is blocked. */}
              <DataTableCell
                overflow="wrap"
                replay="block"
                data-testid={`automations-activity-action-${activity.id}`}
              >
                {describeAction(activity.action)}
              </DataTableCell>
              <DataTableCell>
                {formatNextRunPreview(nextRun) ?? '—'}
              </DataTableCell>
              <DataTableCell>
                {activity.lastResult
                  ? `${activity.lastResult.status} · ${formatRelativeTime(activity.lastResult.completedAt)}`
                  : '—'}
              </DataTableCell>
              <DataTableCell>
                <StatusBadgeDropdown
                  activity={activity}
                  isRunning={isRunning}
                  onToggleEnabled={onToggleEnabled}
                />
              </DataTableCell>
              <DataTableCell align="right">
                <TableActionsCell
                  onFocusLeave={onDisarmDelete}
                  onEscape={(): boolean => {
                    if (!isConfirmingDelete) {
                      return false;
                    }
                    onDisarmDelete();
                    return true;
                  }}
                >
                  {activity.sharedPipelineReview && (
                    <TableActionButton
                      label="Review"
                      onClick={(): void => onReview(activity)}
                      testId={`automations-review-${activity.id}`}
                    >
                      <PipelineIcon size="sm" />
                    </TableActionButton>
                  )}
                  <TableActionButton
                    label="Run now"
                    onClick={(): void => {
                      void onRunNow(activity);
                    }}
                    disabled={isRunning}
                    testId={`automations-run-now-${activity.id}`}
                  >
                    <PlayCircleIcon size="sm" />
                  </TableActionButton>
                  <TableActionButton
                    label="Edit"
                    onClick={(): void => onEdit(activity)}
                    testId={`automations-edit-${activity.id}`}
                  >
                    <DocumentPencilIcon size="sm" />
                  </TableActionButton>
                  {/* Usage-limit resume rows are generated by the "Schedule
                        Resume" banner and bind to a local pipeline execution,
                        so they can never be shared — hide the affordance
                        rather than offer a dead end. */}
                  {activity.action.type !== 'pipeline_execution_resume' && (
                    <TableActionButton
                      label="Share"
                      onClick={(): void => onShare(activity)}
                      testId={`automations-share-${activity.id}`}
                    >
                      <ShareIcon size="sm" />
                    </TableActionButton>
                  )}
                  <TableActionButton
                    label={isConfirmingDelete ? 'Confirm delete' : 'Delete'}
                    onClick={(): void => {
                      void onDelete(activity);
                    }}
                    testId={`automations-delete-${activity.id}`}
                    tone={isConfirmingDelete ? 'destructive' : 'default'}
                  >
                    <TrashIcon size="sm" />
                  </TableActionButton>
                </TableActionsCell>
              </DataTableCell>
            </DataTableRow>
          );
        })}
      </DataTableBody>
    </DataTableFrame>
  );
}

function PreviouslyTriggeredSection({
  activities,
  expandForRevealToken,
  ...handlers
}: TriggeredActivitiesTableProps & {
  /** Expands the section once for a reveal whose row it holds. */
  expandForRevealToken: number | null;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // Adjusted during render (not in an effect) so the revealed row is mounted
  // by the time the parent's scroll-and-focus effect looks for it. The user
  // can still collapse the section afterwards.
  const [expandedForToken, setExpandedForToken] = useState<number | null>(null);
  if (
    expandForRevealToken !== null &&
    expandForRevealToken !== expandedForToken
  ) {
    setExpandedForToken(expandForRevealToken);
    setExpanded(true);
  }
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="compact"
        onClick={(): void => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        data-testid="automations-previously-triggered-toggle"
        className="self-start"
      >
        <ChevronDownIcon
          size="sm"
          className={`transition-transform ${expanded ? '' : '-rotate-90'}`}
        />
        <span>Previously triggered</span>
        <Count value={activities.length} />
      </Button>
      {expanded && (
        <div data-testid="automations-previously-triggered-table">
          <TriggeredActivitiesTable activities={activities} {...handlers} />
        </div>
      )}
    </div>
  );
}

interface StatusBadgeDropdownProps {
  activity: ScheduledActivity;
  isRunning: boolean;
  onToggleEnabled: (activity: ScheduledActivity) => Promise<unknown>;
}

function StatusBadgeDropdown({
  activity,
  isRunning,
  onToggleEnabled,
}: StatusBadgeDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const failed = activity.lastResult?.status === 'failure' && !activity.enabled;
  const label = isRunning ? 'Running' : triggeredActivityStatusLabel(activity);
  let toneClasses: string;
  let dotTone: DotTone;
  if (isRunning) {
    toneClasses = 'border-fg-info/40 bg-info-subtle fg-primary';
    dotTone = 'working';
  } else if (activity.sharedPipelineReview) {
    toneClasses = 'border-line-attention/40 bg-warning-subtle fg-warning';
    dotTone = 'attention';
  } else if (failed) {
    toneClasses =
      'border-line-destructive/40 bg-destructive-subtle fg-destructive';
    dotTone = 'danger';
  } else if (activity.enabled) {
    toneClasses = 'border-line-positive/40 bg-success-subtle fg-primary';
    // A named deviation in docs/design/markers.md: green is the pill's on
    // state, not a live connection.
    dotTone = 'success';
  } else {
    toneClasses = 'bg-fg-primary/[0.04] fg-secondary';
    dotTone = 'filter';
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(event): void => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={`automations-toggle-${activity.id}`}
        className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-3xs font-medium transition-colors ${toneClasses}`}
      >
        <Dot tone={dotTone} />
        <span>{label}</span>
        <ChevronDownIcon size="sm" />
      </button>
      <FloatingPickerMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-left"
        interaction="listbox"
        role="listbox"
        aria-label="Automation status"
        // The menu is portaled; keep its clicks off the row underneath.
        onClick={(event): void => event.stopPropagation()}
      >
        <StatusDropdownOption
          label="Enabled"
          description="Runs when triggered"
          dotTone="success"
          selected={activity.enabled}
          onSelect={(): void => {
            setOpen(false);
            if (!activity.enabled) {
              void onToggleEnabled(activity);
            }
          }}
        />
        <StatusDropdownOption
          label="Disabled"
          description="Skips trigger events"
          dotTone="filter"
          selected={!activity.enabled}
          onSelect={(): void => {
            setOpen(false);
            if (activity.enabled) {
              void onToggleEnabled(activity);
            }
          }}
        />
      </FloatingPickerMenu>
    </>
  );
}

function StatusDropdownOption({
  label,
  description,
  dotTone,
  selected,
  onSelect,
}: {
  label: string;
  description: string;
  dotTone: DotTone;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <PickerMenuOption
      role="option"
      aria-selected={selected}
      selected={selected}
      onClick={onSelect}
    >
      <PickerMenuOptionLeading>
        <Dot tone={dotTone} />
      </PickerMenuOptionLeading>
      <PickerMenuOptionContent>
        <PickerMenuOptionLabel>{label}</PickerMenuOptionLabel>
        <PickerMenuOptionDescription>{description}</PickerMenuOptionDescription>
      </PickerMenuOptionContent>
      <PickerMenuOptionCheck selected={selected} />
    </PickerMenuOption>
  );
}
