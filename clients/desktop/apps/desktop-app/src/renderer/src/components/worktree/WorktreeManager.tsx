import { Button } from '@canopy/ui-shared/components';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError, type AppError } from '@canopy/protocol/app-errors';
import { inlineFailure, inlineFailureText } from '@/lib/inline-app-error';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  APP_ADVISOR_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type AgentModelConfig,
  type CoworkSidebarItem,
  type MultiRepoSidebarItem,
  type SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { hasVisibleWorkspaceContent } from '@canopy/desktop-shared/lib/workspace-visibility';
import type { PipelineRepoChoice } from '@/components/activity/PipelineTriggerModal';
import { AddRepoToWorktreeModal } from './AddRepoToWorktreeModal';
import { SplitWorkspaceModal } from './SplitWorkspaceModal';
import { CreateTaskModal } from './CreateTaskModal';
import type { CreateFromOptions } from '@/lib/createFromSource';
import { TaskReadyPipelineModal } from './TaskReadyPipelineModal';
import { useWatcherRecipientGroups } from '@/components/watchers/useWatcherRecipientGroups';
import type { PipelineWatcherSelection } from '@/components/activity/usePipelineRunWatcher';
import { TeardownFailureDialog } from './TeardownFailureDialog';
import { WorktreeKanbanBoard } from './WorktreeKanbanBoard';
import {
  computeWorktreeUiStatus,
  type WorktreeUiStatus,
} from '@/lib/worktree-status';
import {
  setCurrentChatPanelVisible,
  type WorktreeViewMode,
} from '@/lib/worktree-layout-prefs';
import { WorktreePart } from '../panels/WorktreePart';
import { isWorktreeSurfaceVisible } from './worktreeSurfaceVisibility';
import { ArchivedContainerView } from '../archive/ArchivedContainerView';
import { ArchivedContainersOverviewPage } from '../archive/ArchivedContainersOverviewPage';
import { SharedContainerWorkspace } from '../shared-containers/SharedContainerWorkspace';
import { SharedContainerPastSharesPage } from '../shared-containers/SharedContainerPastSharesPage';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { getWorktreeChatSelection } from '../chat/useWorktreeChatSurfaceState';
import { finishWorktreeArchive } from './finishWorktreeArchive';
import { useDispatchPipelineModal } from '../activity/useDispatchPipelineModal';
import { LazyLoadErrorBoundary } from '../shared/LazyLoadErrorBoundary';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { useIsPageAvailable } from '@/lib/navigation/page-availability';
import {
  useNavigationStore,
  type WorkspaceSettingsDeepLink,
} from '@/stores/navigationStore';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { sortProjectsForSidebar } from '../sidebar/sidebarWorkspacesDerivation';
import { usePendingWorktreeScroll } from '../sidebar/usePendingWorktreeScroll';
import {
  shouldReserveSidebarTrafficLightRegion,
  titlebarCornerWidthCss,
} from '../sidebar-layout';
import { isCoworkChatTarget } from '@/lib/cowork';
import {
  resolveStartupResumeTarget,
  type StartupResumePreferences,
} from '@/lib/startup-resume';
import { useStartupResumeStore } from '@/stores/startupResumeStore';
import { retryDynamicImport } from '@/lib/retryDynamicImport';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { prepareBranchFromWorktree } from '@/lib/prepareBranchFromWorktree';
import { beginPendingWorktreeTabFork } from '@/stores/chat/pending-worktree-tab-forks';
import type {
  PipelineData,
  PipelineModelAliasPreference,
  PipelinePluginCollectionPreference,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import { TaskIcon } from '@canopy/ui-shared/icons';
import {
  PlusIcon as AppCatalogPlusIcon,
  MessageIcon as AppCatalogMessageIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type { ProjectSettingsModal as ProjectSettingsModalComponent } from './ProjectSettingsModal';
import type { WorkspaceSettingsModal as WorkspaceSettingsModalComponent } from './WorkspaceSettingsModal';
import type { ChatProjectSettingsModal as ChatProjectSettingsModalComponent } from '../standalone-chat/ChatProjectSettingsModal';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { withStartPageSuppressed } from '@/lib/panels/start-page-suppression';

const HomeSurface = lazy(async () => {
  const mod = await import('@/components/home/HomeSurface');
  return { default: mod.HomeSurface };
});

const loadProjectSettingsModal = (): Promise<{
  default: typeof ProjectSettingsModalComponent;
}> =>
  retryDynamicImport(() =>
    import('./ProjectSettingsModal').then((m) => ({
      default: m.ProjectSettingsModal,
    })),
  );

const loadWorkspaceSettingsModal = (): Promise<{
  default: typeof WorkspaceSettingsModalComponent;
}> =>
  retryDynamicImport(() =>
    import('./WorkspaceSettingsModal').then((m) => ({
      default: m.WorkspaceSettingsModal,
    })),
  );

const loadChatProjectSettingsModal = (): Promise<{
  default: typeof ChatProjectSettingsModalComponent;
}> =>
  retryDynamicImport(() =>
    import('../standalone-chat/ChatProjectSettingsModal').then((m) => ({
      default: m.ChatProjectSettingsModal,
    })),
  );

const WorkspaceRepairDialog = lazy(() =>
  import('./WorkspaceRepairDialog').then((m) => ({
    default: m.WorkspaceRepairDialog,
  })),
);
const HookChatPluginInstallDialog = lazy(() =>
  import('./HookChatPluginInstallDialog').then((m) => ({
    default: m.HookChatPluginInstallDialog,
  })),
);
const RecommendedPluginsPromptDialog = lazy(() =>
  import('./RecommendedPluginsPromptDialog').then((m) => ({
    default: m.RecommendedPluginsPromptDialog,
  })),
);
const SplitWorkflowView = lazy(() =>
  import('./SplitWorkflowView').then((m) => ({
    default: m.SplitWorkflowView,
  })),
);
import {
  useProjectsStore,
  TeardownFailedError,
  type ArchiveWorktreeOptions,
} from '@/stores/projectsStore';
import { shouldPollSidebarStats } from '@/stores/projectsStore.diffStats';
import { offerDiscardForRefusal } from './offerDiscardForRefusal';
import { useChatStore } from '@/stores/chatStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import { useActivityStore } from '@/stores/activityStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useTerminalActivityStore } from '@/stores/terminalActivityStore';
import { useShallow } from 'zustand/react/shallow';
import { useChatBadgeKeys } from '@/components/sidebar/useChatBadgeKeys';
import { parseBackgroundTaskCounts } from '@/components/sidebar/chatBadgeKeys';
import { useGitHubStore } from '@/stores/githubStore';
import {
  hasActiveSetupRun,
  isScriptRunActive,
  useScriptsStore,
} from '@/stores/scriptsStore';
import { useScriptEventSubscriptions } from '@/hooks/useScriptEventSubscriptions';
import { useHookEventSubscriptions } from '@/hooks/useHookEventSubscriptions';
import { useCodeGraphBuildEventSubscriptions } from '@/hooks/useCodeGraphBuildEventSubscriptions';
import { usePipelineRunsBridge } from '@/hooks/usePipelineRunsBridge';
import {
  isOpenWorktreeSettingsEventDetail,
  OPEN_WORKTREE_SETTINGS_EVENT,
} from '@/lib/keyboardShortcuts';
import { addPlanExploreOriginWorktreeKeys } from '@/lib/planExploreWorktreeKeys';
import { requestChangedFilesRefresh } from '@/stores/changedFilesRefreshRuntime';
import { Tooltip } from '@canopy/ui-shared';
import { localPlatform } from '@/lib/local-platform';

interface PipelinePluginCollectionContext {
  preferences: Record<string, PipelinePluginCollectionPreference>;
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  modelConfig?: AgentModelConfig;
}
const SELECTED_WORKTREE_POLL_INTERVAL_MS = 10_000;
const GLOBAL_DIFF_STATS_POLL_INTERVAL_MS = 30_000;

/**
 * A failed archive or delete, started from a worktree row (the sidebar, the
 * board or the teardown dialog), in the worktree error notice alongside
 * create, repair and join failures. The notice sits over whichever page is
 * open, so a sidebar archive that fails on Home still shows there.
 */
function showWorktreeLifecycleFailure(appError: AppError, copy: string): void {
  useProjectsStore.setState({ worktreeError: inlineFailure(appError, copy) });
}
export function WorktreeManager(): JSX.Element {
  useScriptEventSubscriptions();
  useHookEventSubscriptions();
  useCodeGraphBuildEventSubscriptions();
  useEffect(() => {
    const store = useAutomationsStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);
  const projects = useProjectsStore((state) => state.projects);
  const isLoading = useProjectsStore((state) => state.isLoading);
  const hasHydratedProjects = useProjectsStore(
    (state) => state.hasHydratedProjects,
  );
  const diffStats = useProjectsStore((state) => state.diffStats);
  const uncommittedChanges = useProjectsStore(
    (state) => state.uncommittedChanges,
  );
  const commitsAhead = useProjectsStore((state) => state.commitsAhead);
  const hasUnpushedCommits = useProjectsStore(
    (state) => state.hasUnpushedCommits,
  );
  const baseBranches = useProjectsStore((state) => state.baseBranches);
  const hasRemoteTracking = useProjectsStore(
    (state) => state.hasRemoteTracking,
  );
  const hasBranchBeenPushed = useProjectsStore(
    (state) => state.hasBranchBeenPushed,
  );
  const repoBranches = useProjectsStore((state) => state.repoBranches);
  const baseBranchExistsLocally = useProjectsStore(
    (state) => state.baseBranchExistsLocally,
  );
  const baseBranchExistsInRemote = useProjectsStore(
    (state) => state.baseBranchExistsInRemote,
  );
  const workspaceDrift = useProjectsStore((state) => state.workspaceDrift);
  const discoveryLoading = useProjectsStore((state) => state.discoveryLoading);
  const pendingWorkspaceRepair = useProjectsStore(
    (state) => state.pendingWorkspaceRepair,
  );
  const workspaceRepairPending = useProjectsStore(
    (state) => state.workspaceRepairPending,
  );
  const pendingHookChatPluginInstallPrompt = useProjectsStore(
    (state) => state.pendingHookChatPluginInstallPrompt,
  );
  const dismissPendingHookChatPluginInstallPrompt = useProjectsStore(
    (state) => state.dismissPendingHookChatPluginInstallPrompt,
  );
  const pendingRecommendedPluginPrompt = useProjectsStore(
    (state) => state.pendingRecommendedPluginPrompt,
  );
  const pendingScrollToWorktree = useProjectsStore(
    (state) => state.pendingScrollToWorktree,
  );
  const clearPendingScrollToWorktree = useProjectsStore(
    (state) => state.clearPendingScrollToWorktree,
  );
  const requestScrollToWorktree = useProjectsStore(
    (state) => state.requestScrollToWorktree,
  );
  const tearingDownWorktrees = useProjectsStore(
    (state) => state.tearingDownWorktrees,
  );
  const archivingWorktrees = useProjectsStore(
    (state) => state.archivingWorktrees,
  );
  const scriptRuns = useScriptsStore((state) => state.runs);
  const setupRunningWorktrees = useMemo(() => {
    const keys = new Set<string>();
    for (const [worktreeKey, scripts] of Object.entries(scriptRuns)) {
      if (tearingDownWorktrees.has(worktreeKey)) {
        continue;
      }
      for (const run of Object.values(scripts)) {
        if (run.lifecycle === 'setup' && isScriptRunActive(run.status)) {
          keys.add(worktreeKey);
          break;
        }
      }
    }
    return keys;
  }, [scriptRuns, tearingDownWorktrees]);

  const runRunningWorktrees = useMemo(() => {
    const keys = new Set<string>();
    for (const [worktreeKey, scripts] of Object.entries(scriptRuns)) {
      for (const run of Object.values(scripts)) {
        if (run.lifecycle === 'launch' && isScriptRunActive(run.status)) {
          keys.add(worktreeKey);
          break;
        }
      }
    }
    return keys;
  }, [scriptRuns]);

  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const refreshDiffStatsScheduled = useProjectsStore(
    (state) => state.refreshDiffStatsScheduled,
  );
  const subscribeToDiscoveryEvents = useProjectsStore(
    (state) => state.subscribeToDiscoveryEvents,
  );
  const createWorktree = useProjectsStore((state) => state.createWorktree);
  const repairPendingWorkspaceWorktree = useProjectsStore(
    (state) => state.repairPendingWorkspaceWorktree,
  );
  const cancelPendingWorkspaceRepair = useProjectsStore(
    (state) => state.cancelPendingWorkspaceRepair,
  );
  const archiveWorktree = useProjectsStore((state) => state.archiveWorktree);
  const forceArchiveWorktree = useProjectsStore(
    (state) => state.forceArchiveWorktree,
  );
  const addRepoToWorktree = useProjectsStore(
    (state) => state.addRepoToWorktree,
  );
  const removeRepoFromWorktree = useProjectsStore(
    (state) => state.removeRepoFromWorktree,
  );
  const setWorktreeHidden = useProjectsStore(
    (state) => state.setWorktreeHidden,
  );
  const subscribeToWorkspaceReferenceRepoEvents = useProjectsStore(
    (state) => state.subscribeToWorkspaceReferenceRepoEvents,
  );
  const worktreeRefsSignature = useMemo(
    () =>
      projects
        .flatMap((p) =>
          p.type === 'cowork' ? [] : p.worktrees.map((w) => `${p.id}/${w.id}`),
        )
        .join('|'),
    [projects],
  );
  const summaryHydratedKeysRef = useRef<Set<string>>(new Set());
  const summaryHydratingKeysRef = useRef<Set<string>>(new Set());

  // Runtime workspace-add detection now lives in `projectsStore` so the sidebar
  // list renders the highlight pulse from a single source. This component only
  // drives the detection on `projects` changes and clears timers on unmount.
  const detectRecentlyAddedProjects = useProjectsStore(
    (state) => state.detectRecentlyAddedProjects,
  );
  const clearRecentlyAddedProjectTimers = useProjectsStore(
    (state) => state.clearRecentlyAddedProjectTimers,
  );

  // Archived-worktree viewer overlay (plan: Archive & Retention). Only
  // code-workspace containers render here — work-entry containers are shown
  // by the cowork/App Advisor archive overlay instead. Gate on the OWNING
  // WORKSPACE (synchronously known), never on the loaded summary: waiting for
  // summaries delays the open, and a consumed summary mid-restore would drop
  // the overlay early and flash the previously selected worktree.
  const archivedWorktreeViewer = useArchivedContainersStore(
    useShallow((state) => {
      const viewer = state.viewer;
      if (
        viewer === null ||
        viewer.workspaceId === APP_ADVISOR_PROJECT_ID ||
        isCoworkChatTarget(viewer.workspaceId)
      ) {
        return null;
      }
      return viewer;
    }),
  );
  const sharedContainerViewerOpen = useSharedContainerReplicasStore(
    (state) => state.viewer !== null,
  );
  const sharedContainerPastSharesOpen = useSharedContainerReplicasStore(
    (state) => state.pastSharesOpen,
  );
  const closeSharedContainerPastShares = useSharedContainerReplicasStore(
    (state) => state.closePastShares,
  );
  const closeSharedContainerViewer = useSharedContainerReplicasStore(
    (state) => state.closeViewer,
  );
  // "Archived and deleted" overview page for a code workspace (same overlay
  // slot as the viewer; the viewer stacks on top of it and its Back returns
  // here). Cowork / App Advisor overviews render in their own overlay.
  const archivedOverviewWorkspaceId = useArchivedContainersStore((state) => {
    const overview = state.overview;
    if (
      overview === null ||
      overview.workspaceId === APP_ADVISOR_PROJECT_ID ||
      isCoworkChatTarget(overview.workspaceId)
    ) {
      return null;
    }
    return overview.workspaceId;
  });
  const closeArchivedViewerToOverview = useArchivedContainersStore(
    (state) => state.closeViewerToOverview,
  );
  const closeArchivedOverview = useArchivedContainersStore(
    (state) => state.closeOverview,
  );

  const selectedWorktree = useChatStore((state) => state.selectedWorktree);
  const selectWorktree = useChatStore((state) => state.selectWorktree);
  // Explicit user navigation to a live worktree dismisses the page-like
  // archived viewer. Deliberately NOT wired into the selectWorktree funnel:
  // workspace-activation side effects (e.g. cowork page mounts) also funnel
  // there and must not close a viewer the user just opened.
  const handleSidebarSelectWorktree = useCallback<typeof selectWorktree>(
    (projectId, worktreeId, options) => {
      dismissPageLikeViewers();
      selectWorktree(projectId, worktreeId, options);
    },
    [selectWorktree],
  );
  const unreadWorktreeKeys = useChatSidebarStore(
    (state) => state.unreadWorktreeKeys,
  );
  const acknowledgeSelectedWorktreeAttention = useChatStore(
    (state) => state.acknowledgeSelectedWorktreeAttention,
  );
  const activityPanelExpanded = useActivityStore(
    (state) => state.panelExpanded,
  );
  const setActivityPanelExpanded = useActivityStore(
    (state) => state.setPanelExpanded,
  );
  const setWorktreeSummaryEnabled = useActivityStore(
    (state) => state.setWorktreeSummaryEnabled,
  );
  const loadWorktreeSummaries = useActivityStore(
    (state) => state.loadWorktreeSummaries,
  );

  const runningExecutionsByWorktree = usePipelineRunsStore(
    (state) => state.runningExecutionsByWorktree,
  );
  const pausedExecutionsByWorktree = usePipelineRunsStore(
    (state) => state.pausedExecutionsByWorktree,
  );
  const unseenPipelineWorktreeKeys = usePipelineRunsStore(
    (state) => state.unseenPipelineWorktreeKeys,
  );
  const unseenFailedPipelineWorktreeKeys = usePipelineRunsStore(
    (state) => state.unseenFailedPipelineWorktreeKeys,
  );
  const markWorktreePipelineSeen = usePipelineRunsStore(
    (state) => state.markWorktreePipelineSeen,
  );
  const loadGlobalPipelineStatuses = usePipelineRunsStore(
    (state) => state.loadGlobalPipelineStatuses,
  );
  const markWorktreeTerminalSeen = useTerminalActivityStore(
    (state) => state.markWorktreeTerminalSeen,
  );

  const selectedWorktreeKey = selectedWorktree
    ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
    : null;
  const selectedWorktreeProjectId = selectedWorktree?.projectId ?? null;
  const selectedWorktreeId = selectedWorktree?.worktreeId ?? null;
  // The standalone-chat pseudo-project is not a worktree selection; the panel
  // grid (like ChatPanel before it) must treat it as "nothing selected".
  const worktreeChatSelection = getWorktreeChatSelection(selectedWorktree);
  // Split PR workflow presentation: when the selected worktree is under
  // lockdown OR has an open renderer-side workflow session, the normal
  // WorktreePart surface is hidden and SplitWorkflowView takes over. Hidden via
  // className, not unmounted, so the panel grid keeps its subscriptions and
  // layout state.
  //
  // Keying on `session OR locked` (not the lock alone) is what holds the
  // workflow through a COMPLETED settle: the lock releases on settle, but the
  // session persists so the Finalize finished page stays mounted until the user
  // clicks Done. The session ends on explicit exit, failure settle, or
  // cancellation settle (see githubStore), collapsing this back to normal UX.
  const selectedWorktreeSplitLocked = useGitHubStore((state) =>
    selectedWorktreeKey
      ? state.splitLockedWorktrees.has(selectedWorktreeKey) ||
        state.splitWorkflowSessions.has(selectedWorktreeKey)
      : false,
  );
  const activePage = useNavigationStore((state) => state.activePage);
  const settingsOpen = useNavigationStore((state) => state.settingsOpen);
  const sidebarHidden = useSidebarStore((state) => state.hidden);
  const pendingWorkspaceSettings = useNavigationStore(
    (state) => state.pendingWorkspaceSettings,
  );
  const consumeWorkspaceSettings = useNavigationStore(
    (state) => state.consumeWorkspaceSettings,
  );
  const pendingDispatchPipeline = useNavigationStore(
    (state) => state.pendingDispatchPipeline,
  );
  const consumeDispatchPipelineRequest = useNavigationStore(
    (state) => state.consumeDispatchPipelineRequest,
  );
  const pendingAddRepoAdhoc = useNavigationStore(
    (state) => state.pendingAddRepoAdhoc,
  );
  const consumeAddRepoAdhocRequest = useNavigationStore(
    (state) => state.consumeAddRepoAdhocRequest,
  );
  const pendingSplitWorkspace = useNavigationStore(
    (state) => state.pendingSplitWorkspace,
  );
  const consumeSplitWorkspaceRequest = useNavigationStore(
    (state) => state.consumeSplitWorkspaceRequest,
  );
  const pendingDriftDetails = useNavigationStore(
    (state) => state.pendingDriftDetails,
  );
  const consumeDriftDetailsRequest = useNavigationStore(
    (state) => state.consumeDriftDetailsRequest,
  );
  const pendingArchiveWorktree = useNavigationStore(
    (state) => state.pendingArchiveWorktree,
  );
  const consumeArchiveWorktreeRequest = useNavigationStore(
    (state) => state.consumeArchiveWorktreeRequest,
  );

  // Derive badge keys as sorted strings so the selector returns primitives
  // that only change when actual membership changes (not on every streaming token).
  const badgeKeys = useChatBadgeKeys();

  // When a plan-explore chat is streaming, light up the owning worktree's
  // thinking spinner. The plan-explore chat lives under a dedicated scope keyed
  // by the plan id, so map each streaming plan id back to its real worktree via
  // the tracked-plan registry. This is independent of whether the explore modal
  // is open, so the spinner persists while the agent runs after the modal is
  // closed.
  const trackedPlans = useActivityStore((state) => state.trackedPlans);
  const streamingWorktreeKeys = useMemo(() => {
    const streamingKeys = badgeKeys.streaming
      ? badgeKeys.streaming.split(',')
      : [];
    return addPlanExploreOriginWorktreeKeys(streamingKeys, trackedPlans);
  }, [badgeKeys.streaming, trackedPlans]);
  const backgroundTaskCounts = useMemo(
    () => parseBackgroundTaskCounts(badgeKeys.background),
    [badgeKeys.background],
  );
  const activeSessionWorktreeKeys = useMemo(() => {
    const activeKeys = badgeKeys.active ? badgeKeys.active.split(',') : [];
    return addPlanExploreOriginWorktreeKeys(activeKeys, trackedPlans);
  }, [badgeKeys.active, trackedPlans]);
  const awaitingApprovalKeys = useMemo(
    () => new Set(badgeKeys.awaiting ? badgeKeys.awaiting.split(',') : []),
    [badgeKeys.awaiting],
  );
  const pendingQuestionWorktreeKeys = useMemo(
    () => new Set(badgeKeys.question ? badgeKeys.question.split(',') : []),
    [badgeKeys.question],
  );
  const toolApprovalWorktreeKeys = useMemo(
    () =>
      new Set(badgeKeys.toolApproval ? badgeKeys.toolApproval.split(',') : []),
    [badgeKeys.toolApproval],
  );

  const pipelineRunningWorktreeKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, ids] of Object.entries(runningExecutionsByWorktree)) {
      if (ids.size > 0) keys.add(key);
    }
    return keys;
  }, [runningExecutionsByWorktree]);

  const pipelinePausedWorktreeKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, ids] of Object.entries(pausedExecutionsByWorktree)) {
      if (ids.size > 0) keys.add(key);
    }
    return keys;
  }, [pausedExecutionsByWorktree]);

  // When navigating back to main with a worktree already selected, request a
  // scroll-into-view so the selected card isn't lost when the user returns
  // from another page. The pending-scroll consumer uses `nearest`, so it
  // doesn't move the scroll if the card is already visible.
  const previousActivePageRef = useRef(activePage);
  useEffect(() => {
    const previous = previousActivePageRef.current;
    previousActivePageRef.current = activePage;
    if (activePage === 'main' && previous !== 'main' && selectedWorktree) {
      requestScrollToWorktree(
        selectedWorktree.projectId,
        selectedWorktree.worktreeId,
      );
    }
  }, [activePage, selectedWorktree, requestScrollToWorktree]);

  // Mark terminal status as seen when a worktree is selected.
  useEffect(() => {
    if (activePage === 'main' && selectedWorktreeKey) {
      markWorktreeTerminalSeen(selectedWorktreeKey);
    }
  }, [activePage, selectedWorktreeKey, markWorktreeTerminalSeen]);

  // Mark pipeline status as seen only once the activity panel is open. Also
  // fires when the panel is opened later for an already-selected worktree.
  useEffect(() => {
    if (activePage === 'main' && selectedWorktreeKey && activityPanelExpanded) {
      markWorktreePipelineSeen(selectedWorktreeKey);
    }
  }, [
    activePage,
    selectedWorktreeKey,
    activityPanelExpanded,
    markWorktreePipelineSeen,
  ]);

  const [teardownError, setTeardownError] =
    useState<TeardownFailedError | null>(null);
  const [isTeardownRetrying, setIsTeardownRetrying] = useState(false);
  // The Add Workspace modal itself is hosted at App level
  // (`AddWorkspaceModalHost`); this only opens it from the sidebar "+".
  const openAddRepoModal = useNavigationStore((s) => s.openAddWorkspaceModal);
  /**
   * Open `AddRepoToWorktreeModal` for a specific source worktree. Set by the
   * worktree action menu's "Add repo" entry (forwarded by
   * `WorktreeItemAdapter`), cleared on modal close or after a successful
   * combine.
   */
  const [addRepoAdhocContext, setAddRepoAdhocContext] = useState<{
    workspaceId: string;
    worktreeId: string;
  } | null>(null);
  /**
   * Open `SplitWorkspaceModal` for a specific temporary multi-repo worktree.
   * Set by the worktree action menu's "Split workspace" entry (forwarded by
   * `WorktreeItemAdapter`), cleared on modal close or after a successful
   * split.
   */
  const [splitWorkspaceContext, setSplitWorkspaceContext] = useState<{
    workspaceId: string;
    worktreeId: string;
  } | null>(null);
  const { openDispatchPipelineModal, dispatchPipelineModal } =
    useDispatchPipelineModal();
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [sharedTaskWorkspaceId, setSharedTaskWorkspaceId] = useState<
    string | undefined
  >();
  const [taskReadyPipelineCtx, setTaskReadyPipelineCtx] = useState<{
    workspaceId: string;
    taskText: string;
    cwd: string;
    repoChoices: PipelineRepoChoice[];
    createOptions?: CreateFromOptions;
  } | null>(null);
  const [taskPipelineRunning, setTaskPipelineRunning] = useState(false);
  const [taskPipelineRunError, setTaskPipelineRunError] = useState<
    string | null
  >(null);
  // Task pipelines run against a freshly created worktree, so only App Advisor
  // chats are available as watcher recipients (the new worktree has no chats).
  const taskWatcherGroups = useWatcherRecipientGroups();
  const [taskWatcherSelection, setTaskWatcherSelection] =
    useState<PipelineWatcherSelection | null>(null);
  const [settingsContext, setSettingsContext] =
    useState<WorkspaceSettingsDeepLink | null>(null);
  const setWorkspaceSettingsModalOpen = useNavigationStore(
    (state) => state.setWorkspaceSettingsModalOpen,
  );
  const [settingsLazyRetryKey, setSettingsLazyRetryKey] = useState(0);
  const [ProjectSettingsModal, setProjectSettingsModal] = useState(() =>
    lazy(loadProjectSettingsModal),
  );
  const [WorkspaceSettingsModal, setWorkspaceSettingsModal] = useState(() =>
    lazy(loadWorkspaceSettingsModal),
  );
  const [ChatProjectSettingsModal, setChatProjectSettingsModal] = useState(() =>
    lazy(loadChatProjectSettingsModal),
  );
  const chatProjects = useStandaloneChatStore((state) => state.chatProjects);
  const updateChatProject = useStandaloneChatStore(
    (state) => state.updateChatProject,
  );
  const deleteChatProject = useStandaloneChatStore(
    (state) => state.deleteChatProject,
  );
  const [viewModeReady, setViewModeReady] = useState(false);
  const [kanbanChatPanelVisible, setKanbanChatPanelVisible] = useState(false);
  const hiddenWorkspaceIds = useProjectsStore(
    (state) => state.hiddenWorkspaceIds,
  );
  const setHiddenWorkspaceIds = useProjectsStore(
    (state) => state.setHiddenWorkspaceIds,
  );
  const hydrateHiddenWorkspaceIds = useProjectsStore(
    (state) => state.hydrateHiddenWorkspaceIds,
  );

  // The view is now driven by the active page, not a local toggle: the sidebar
  // "Code Projects" list replaces the in-page list, and Kanban is a Labs page
  // experiment reached from its sidebar row while switched on
  // (`activePage === 'kanban'`). A board switched off while open never renders
  // before navigation falls back. `viewMode` is retained as a derived value so
  // the chat/activity panels keep namespacing their layout preferences per
  // view (list vs kanban).
  const kanbanAvailable = useIsPageAvailable('kanban');
  const kanbanActive = kanbanAvailable && activePage === 'kanban';
  const viewMode: WorktreeViewMode = kanbanActive ? 'kanban' : 'list';

  // On the worktree page the chat/work panel is always shown; on the kanban
  // page it is toggled via the board header button.
  const chatPanelVisible = viewMode === 'list' || kanbanChatPanelVisible;

  // Keep the layout-prefs helper informed about chat panel visibility so
  // chatStore.selectWorktree skips clearing unread when the panel is hidden.
  // When the panel becomes visible, acknowledge attention so any pending
  // unread on the active tab is cleared now that it's actually in view.
  useEffect(() => {
    setCurrentChatPanelVisible(chatPanelVisible);
    if (chatPanelVisible) {
      acknowledgeSelectedWorktreeAttention();
    }
  }, [chatPanelVisible, acknowledgeSelectedWorktreeAttention]);

  const splitLayoutRef = useRef<HTMLDivElement | null>(null);
  const worktreeListScrollRef = useRef<HTMLDivElement | null>(null);
  // Holds the not-currently-active view's activity-panel layout so switching
  // between the worktree and kanban pages restores that view's saved layout.
  const inactiveActivityLayoutRef = useRef<{
    activityExpanded: boolean;
  }>({
    activityExpanded: false,
  });

  // The kanban board is the only consumer while the kanban page is active (the
  // sidebar consumer disables itself there). `inline: 'nearest'` covers the
  // board's horizontal scroll when the target column is off-screen; `block:
  // 'nearest'` handles the column's inner vertical scroll. Both short-circuit
  // if the card is already visible.
  usePendingWorktreeScroll({
    enabled: kanbanActive,
    containerRef: worktreeListScrollRef,
    pending: pendingScrollToWorktree,
    clearPending: clearPendingScrollToWorktree,
    stillExists: (projectId, worktreeId) =>
      projects.some(
        (project) =>
          project.id === projectId &&
          project.type !== 'cowork' &&
          project.worktrees.some((wt) => wt.id === worktreeId),
      ),
    scrollInline: 'nearest',
  });

  // Detect runtime workspace additions and trigger the highlight pulse. The
  // detection/timers live in `projectsStore` (so sidebar rows can render the
  // pulse); this effect just drives it on `projects`/hydration changes.
  useEffect(() => {
    detectRecentlyAddedProjects();
  }, [projects, hasHydratedProjects, detectRecentlyAddedProjects]);

  // Clear any outstanding highlight timers on unmount only.
  useEffect(() => {
    return (): void => {
      clearRecentlyAddedProjectTimers();
    };
  }, [clearRecentlyAddedProjectTimers]);

  // When a worktree becomes selected (e.g. via toast notification or restored
  // selection), ensure its workspace is not filtered out. Otherwise the active
  // worktree would be invisible in the list/kanban views.
  useEffect(() => {
    if (!selectedWorktree) {
      return;
    }
    if (!hiddenWorkspaceIds.includes(selectedWorktree.projectId)) {
      return;
    }
    const next = hiddenWorkspaceIds.filter(
      (id) => id !== selectedWorktree.projectId,
    );
    setHiddenWorkspaceIds(next);
  }, [selectedWorktree, hiddenWorkspaceIds, setHiddenWorkspaceIds]);

  // CAN-1074: same pin + recency ordering the shared sidebar applies, so both
  // surfaces render the workspace list in one order.
  const projectSortMode = useSidebarStore((state) => state.projectSortMode);
  const sortedProjects = useMemo(
    () => sortProjectsForSidebar(projects, { sortMode: projectSortMode }),
    [projects, projectSortMode],
  );

  const hiddenWorkspaceIdSet = useMemo(
    () => new Set(hiddenWorkspaceIds),
    [hiddenWorkspaceIds],
  );

  const visibleProjects = useMemo(
    () =>
      sortedProjects.filter((p) => {
        if (hiddenWorkspaceIdSet.has(p.id)) return false;
        if (p.alwaysShow !== false) return true;
        return hasVisibleWorkspaceContent(p);
      }),
    [sortedProjects, hiddenWorkspaceIdSet],
  );

  const hiddenProjects = useMemo(
    () =>
      sortedProjects.filter(
        (p) =>
          p.alwaysShow === false &&
          !hasVisibleWorkspaceContent(p) &&
          !hiddenWorkspaceIdSet.has(p.id),
      ),
    [sortedProjects, hiddenWorkspaceIdSet],
  );
  // Code-tab-specific: a Cowork workspace (always present — see
  // `ensureDefaultCoworkWorkspace`) does not count as a "repository", so the
  // Code tab's empty state (single centered Home surface instead of the
  // worktree list/kanban split layout) is still keyed on having zero
  // single-repo/multi-repo workspaces, not zero sidebar entries overall.
  const hasAnyCodeWorkspaces = sortedProjects.some((p) => p.type !== 'cowork');
  const createTaskDisabled = !isLoading && !hasAnyCodeWorkspaces;
  const showEmptyState = !isLoading && !hasAnyCodeWorkspaces;

  /**
   * Single source of truth for the per-worktree UI status (idle / planning /
   * working / unread / done) used by both the list-view dot and the kanban
   * board. Keyed by `${projectId}/${worktreeId}` to match the rest of the
   * existing key-set conventions in this file.
   */
  const worktreeStatusMap = useMemo(() => {
    const map = new Map<string, WorktreeUiStatus>();
    for (const project of [...visibleProjects, ...hiddenProjects]) {
      if (project.type === 'cowork') {
        continue;
      }

      for (const worktree of project.worktrees) {
        const key = `${project.id}/${worktree.id}`;
        const isDone = worktree.status === 'done';
        const hasUnread =
          unreadWorktreeKeys.has(key) ||
          unseenPipelineWorktreeKeys.has(key) ||
          unseenFailedPipelineWorktreeKeys.has(key);
        const isWorking =
          streamingWorktreeKeys.has(key) ||
          pipelineRunningWorktreeKeys.has(key);
        const isPlanning =
          awaitingApprovalKeys.has(key) || pipelinePausedWorktreeKeys.has(key);
        map.set(
          key,
          computeWorktreeUiStatus({ isDone, hasUnread, isWorking, isPlanning }),
        );
      }
    }
    return map;
  }, [
    visibleProjects,
    hiddenProjects,
    unreadWorktreeKeys,
    unseenPipelineWorktreeKeys,
    unseenFailedPipelineWorktreeKeys,
    streamingWorktreeKeys,
    pipelineRunningWorktreeKeys,
    awaitingApprovalKeys,
    pipelinePausedWorktreeKeys,
  ]);

  const selectedWorktreeRef = useRef(selectedWorktree);
  useEffect(() => {
    selectedWorktreeRef.current = selectedWorktree;
  }, [selectedWorktree]);

  const handleToggleKanbanChatPanel = useCallback((): void => {
    setKanbanChatPanelVisible((prev) => {
      const next = !prev;
      void window.api
        .savePreferences({ kanbanChatPanelVisible: next })
        .catch((error: unknown) => {
          // Local state still applies; the failure is only recorded.
          reportClientAppError(error);
        });
      return next;
    });
  }, []);

  const refreshSelectedChangedFiles = useCallback(async (): Promise<void> => {
    const wt = selectedWorktreeRef.current;
    if (!wt) {
      return;
    }
    if (
      hasActiveSetupRun(
        useScriptsStore.getState().runs[`${wt.projectId}/${wt.worktreeId}`],
      )
    ) {
      return;
    }

    try {
      await requestChangedFilesRefresh(wt.projectId, wt.worktreeId);
    } catch (error) {
      // A background refresh: the next one retries.
      reportClientAppError(error);
    }
  }, []);

  useEffect(() => {
    let canceled = false;

    const initialize = async (): Promise<void> => {
      let resumePreferences: StartupResumePreferences | null = null;

      try {
        const preferences = await window.api.loadPreferences();
        if (!canceled) {
          // The view is now driven by `activePage` (list vs kanban), not a
          // persisted `worktreeViewMode`. Seed the active view's activity-panel
          // layout and stash the other view's layout so switching pages
          // restores it. The list↔chat divider is gone with the in-page list.
          const listLayout = {
            activityExpanded: preferences.activityPanelExpanded,
          };
          const kanbanLayout = {
            activityExpanded: preferences.kanbanActivityPanelExpanded,
          };
          const initialIsList =
            useNavigationStore.getState().activePage !== 'kanban';
          const activeLayout = initialIsList ? listLayout : kanbanLayout;
          inactiveActivityLayoutRef.current = initialIsList
            ? kanbanLayout
            : listLayout;
          setActivityPanelExpanded(activeLayout.activityExpanded);
          setWorktreeSummaryEnabled(preferences.worktreeSummaryEnabled);
          setKanbanChatPanelVisible(preferences.kanbanChatPanelVisible);
          hydrateHiddenWorkspaceIds(
            preferences.worktreeFilterHiddenWorkspaceIds,
          );
          // Seed model defaults immediately from the already-loaded preferences
          // so that tabs created during initialization use the configured defaults.
          useChatStore.setState({
            modelDefaults: {
              chatProvider: preferences.defaultChatProvider,
              chatModelByProvider: preferences.defaultChatModelByProvider,
              worktreeProvider: preferences.defaultWorktreeProvider,
              worktreeModelByProvider:
                preferences.defaultWorktreeModelByProvider,
              defaultChatInterfaceMode: preferences.defaultChatInterfaceMode,
              defaultStandaloneChatInterfaceMode:
                preferences.defaultStandaloneChatInterfaceMode,
              defaultAppAdvisorInterfaceMode:
                preferences.defaultAppAdvisorInterfaceMode,
              codexFastModeDefaultEnabled:
                preferences.codexFastModeDefaultEnabled,
              modelConfigDefaultsByProvider:
                preferences.providerModelConfigDefaults,
            },
          });
          // Captured for the post-loadProjects resume-offer decision below —
          // see resolveStartupResumeTarget for the MRU/legacy rules.
          resumePreferences = {
            lastActiveContext: preferences.lastActiveContext,
            lastSelectedWorktreeProjectId:
              preferences.lastSelectedWorktreeProjectId,
            lastSelectedWorktreeId: preferences.lastSelectedWorktreeId,
          };
        }
      } catch (error) {
        // Startup continues with the default layout.
        reportClientAppError(error);
      }

      if (!canceled) {
        setViewModeReady(true);
      }

      await loadProjects();
      if (!canceled) {
        // Startup no longer auto-selects the MRU worktree. Instead, once the
        // project list has hydrated, publish a dismissible Resume offer for
        // the Home surface when the MRU context still resolves to a live
        // target. The decision logic (unified lastActiveContext vs
        // migration-only legacy fields, cowork vs worktree) lives in the
        // pure helper so it stays unit-testable. Skip the offer entirely if
        // the user already navigated into a worktree or cowork chat while
        // hydration was in flight — the offer would be stale on arrival.
        const resumeTarget = resumePreferences
          ? resolveStartupResumeTarget(
              resumePreferences,
              useProjectsStore.getState().projects,
            )
          : null;
        if (
          resumeTarget &&
          !useChatStore.getState().selectedWorktree &&
          useNavigationStore.getState().activePage !== 'chat'
        ) {
          useStartupResumeStore.getState().setOffer(resumeTarget);
        }

        // App-level history starts after the page restore. Nothing is
        // auto-selected anymore, but hydration may still have raced a user
        // navigation — replace the untouched initial entry with the final
        // landing location, preserving any real history the user created
        // while hydration was in flight.
        useNavigationHistoryStore.getState().replaceInitialLocation();

        await loadGlobalPipelineStatuses();
        // A full first pass fans several git reads out across every worktree.
        // Seed the foreground plus a bounded background batch at startup; the
        // adaptive scheduler drains the remaining fleet on later ticks. A
        // hidden or unfocused launch catches up through the focus handler.
        if (
          shouldPollSidebarStats({
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus(),
          })
        ) {
          await refreshDiffStatsScheduled();
          await refreshSelectedChangedFiles();
        }
      }
    };

    void initialize();

    return (): void => {
      canceled = true;
    };
  }, [
    hydrateHiddenWorkspaceIds,
    loadProjects,
    loadGlobalPipelineStatuses,
    refreshDiffStatsScheduled,
    refreshSelectedChangedFiles,
    selectWorktree,
    setActivityPanelExpanded,
    setWorktreeSummaryEnabled,
  ]);

  // When the active page switches between the worktree list and kanban views,
  // swap the activity-panel expanded state so each view keeps its own saved
  // layout. Replaces the old view-toggle swap now that the page drives the
  // view. `viewModeReady` gates until the initial layout has loaded so the
  // first render doesn't clobber the seeded layout.
  const previousViewModeRef = useRef(viewMode);
  useEffect(() => {
    const previous = previousViewModeRef.current;
    previousViewModeRef.current = viewMode;
    if (!viewModeReady || previous === viewMode) {
      return;
    }
    const outgoing = {
      activityExpanded: useActivityStore.getState().panelExpanded,
    };
    const incoming = inactiveActivityLayoutRef.current;
    inactiveActivityLayoutRef.current = outgoing;
    setActivityPanelExpanded(incoming.activityExpanded);
  }, [viewMode, viewModeReady, setActivityPanelExpanded]);

  // Batch worktree-summary hydration for the activity panel. Main bounds the
  // asynchronous file-read concurrency; one atomic store merge avoids the old
  // one-IPC-per-worktree renderer update tail. (Eager chat tab hydration for
  // sidebar badges runs independently from App.tsx startup.)
  useEffect(() => {
    const allWorktrees = useProjectsStore
      .getState()
      .projects.flatMap((p) =>
        p.type === 'cowork'
          ? []
          : p.worktrees.map((wt) => ({ projectId: p.id, worktreeId: wt.id })),
      );
    const currentKeys = new Set(
      allWorktrees.map(
        (worktree) => `${worktree.projectId}/${worktree.worktreeId}`,
      ),
    );
    for (const key of Array.from(summaryHydratedKeysRef.current)) {
      if (!currentKeys.has(key)) {
        summaryHydratedKeysRef.current.delete(key);
      }
    }
    for (const key of Array.from(summaryHydratingKeysRef.current)) {
      if (!currentKeys.has(key)) {
        summaryHydratingKeysRef.current.delete(key);
      }
    }

    const newlySeenWorktrees = allWorktrees.filter((worktree) => {
      const key = `${worktree.projectId}/${worktree.worktreeId}`;
      if (
        summaryHydratedKeysRef.current.has(key) ||
        summaryHydratingKeysRef.current.has(key)
      ) {
        return false;
      }
      summaryHydratingKeysRef.current.add(key);
      return true;
    });

    if (newlySeenWorktrees.length === 0) {
      return;
    }
    void loadWorktreeSummaries(newlySeenWorktrees)
      .then(() => {
        const liveKeys = new Set(
          useProjectsStore
            .getState()
            .projects.flatMap((project) =>
              project.type === 'cowork'
                ? []
                : project.worktrees.map(
                    (worktree) => `${project.id}/${worktree.id}`,
                  ),
            ),
        );
        for (const worktree of newlySeenWorktrees) {
          const key = `${worktree.projectId}/${worktree.worktreeId}`;
          if (liveKeys.has(key)) {
            summaryHydratedKeysRef.current.add(key);
          }
        }
      })
      .catch((error: unknown) => {
        // Leave failed keys unhydrated so a later workspace snapshot retries.
        reportClientAppError(error);
      })
      .finally(() => {
        for (const worktree of newlySeenWorktrees) {
          summaryHydratingKeysRef.current.delete(
            `${worktree.projectId}/${worktree.worktreeId}`,
          );
        }
      });
  }, [worktreeRefsSignature, loadWorktreeSummaries]);

  useEffect(() => {
    const unsubDiscovery = subscribeToDiscoveryEvents();
    const unsubGitHub = useGitHubStore.getState().subscribeToEvents();
    const unsubReferenceRepo = subscribeToWorkspaceReferenceRepoEvents();
    const unsubGitLifecycle = useProjectsStore
      .getState()
      .subscribeToWorktreeGitLifecycleEvents();
    return (): void => {
      unsubDiscovery();
      unsubGitHub();
      unsubReferenceRepo();
      unsubGitLifecycle();
    };
  }, [subscribeToDiscoveryEvents, subscribeToWorkspaceReferenceRepoEvents]);

  // The renderer's single pipeline IPC bridge: global status tracking, the
  // selected run list, leased detail, and step-log interests. Always active
  // regardless of worktree selection or which panels are open.
  usePipelineRunsBridge({ trackGlobalStatus: true });

  useEffect(() => {
    if (!selectedWorktree || isCoworkChatTarget(selectedWorktree.projectId)) {
      void window.api.github.setForegroundWorktree({
        projectId: null,
        worktreeId: null,
      });
      return;
    }

    void window.api.github.setForegroundWorktree({
      projectId: selectedWorktree.projectId,
      worktreeId: selectedWorktree.worktreeId,
    });
  }, [selectedWorktree]);

  useEffect(() => {
    let interval: number | undefined;
    let lastGlobalDiffStatsRefreshAt = Date.now();

    const isSidebarPollingActive = (): boolean =>
      shouldPollSidebarStats({
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
      });

    const refreshSelectedGitHubStatus = (): void => {
      const selected = useChatStore.getState().selectedWorktree;
      if (!selected || isCoworkChatTarget(selected.projectId)) {
        return;
      }

      void window.api.github.setForegroundWorktree({
        projectId: selected.projectId,
        worktreeId: selected.worktreeId,
      });
      void useGitHubStore
        .getState()
        .requestFastRefresh(selected.projectId, selected.worktreeId);
    };

    const startPolling = (): void => {
      if (interval != null) return;
      interval = window.setInterval(() => {
        if (!isSidebarPollingActive()) {
          stopPolling();
          return;
        }
        const selected = useChatStore.getState().selectedWorktree;
        if (
          selected &&
          hasActiveSetupRun(
            useScriptsStore.getState().runs[
              `${selected.projectId}/${selected.worktreeId}`
            ],
          )
        ) {
          return;
        }
        const now = Date.now();
        if (
          now - lastGlobalDiffStatsRefreshAt >=
          GLOBAL_DIFF_STATS_POLL_INTERVAL_MS
        ) {
          lastGlobalDiffStatsRefreshAt = now;
          void refreshDiffStatsScheduled().then(() =>
            refreshSelectedChangedFiles(),
          );
          return;
        }

        void refreshSelectedChangedFiles();
      }, SELECTED_WORKTREE_POLL_INTERVAL_MS);
    };

    const stopPolling = (): void => {
      if (interval != null) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };

    const handleVisibilityChange = (): void => {
      if (isSidebarPollingActive()) {
        lastGlobalDiffStatsRefreshAt = Date.now();
        void refreshDiffStatsScheduled().then(() =>
          refreshSelectedChangedFiles(),
        );
        startPolling();
        refreshSelectedGitHubStatus();
      } else {
        stopPolling();
      }
    };

    const handleWindowFocus = (): void => {
      if (!isSidebarPollingActive()) {
        return;
      }
      lastGlobalDiffStatsRefreshAt = Date.now();
      void refreshDiffStatsScheduled().then(() =>
        refreshSelectedChangedFiles(),
      );
      startPolling();
      refreshSelectedGitHubStatus();
    };

    const handleWindowBlur = (): void => {
      stopPolling();
    };

    if (isSidebarPollingActive()) {
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);

    return (): void => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('blur', handleWindowBlur);
      stopPolling();
    };
  }, [refreshDiffStatsScheduled, refreshSelectedChangedFiles]);

  useEffect(() => {
    void refreshSelectedChangedFiles();

    if (
      !selectedWorktreeProjectId ||
      !selectedWorktreeId ||
      isCoworkChatTarget(selectedWorktreeProjectId)
    ) {
      return;
    }

    // The startup cache is intentionally allowed to paint before background
    // Git polling catches up. Promote a newly selected worktree to an
    // immediate targeted local refresh so stale commit/push actions cannot
    // remain visible until the next 30-second scheduler tick.
    if (
      shouldPollSidebarStats({
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
      })
    ) {
      void useProjectsStore
        .getState()
        .refreshWorktreeDiffStats(
          selectedWorktreeProjectId,
          selectedWorktreeId,
        );
    }
  }, [
    selectedWorktreeProjectId,
    selectedWorktreeId,
    refreshSelectedChangedFiles,
  ]);

  const handleOpenDriftDetails = useCallback(
    (workspaceId: string, worktreeId: string): void => {
      setSettingsContext({
        workspaceId,
        initialTab: 'details',
        worktreeId,
      });
    },
    [],
  );

  const handleOpenAddRepoAdhoc = useCallback(
    (workspaceId: string, worktreeId: string): void => {
      setAddRepoAdhocContext({ workspaceId, worktreeId });
    },
    [],
  );

  const handleOpenSplitWorkspace = useCallback(
    (workspaceId: string, worktreeId: string): void => {
      setSplitWorkspaceContext({ workspaceId, worktreeId });
    },
    [],
  );

  // Reads the selection at call time: a stable identity keeps this callback,
  // held by a window listener, from pinning an old render and its projects.
  const handleOpenSettingsTab = useCallback(
    (tab: 'scripts' | 'hooks' | 'environment'): void => {
      const wt = useChatStore.getState().selectedWorktree;
      if (!wt) return;
      setSettingsContext({
        workspaceId: wt.projectId,
        initialTab: tab,
        worktreeId: wt.worktreeId,
      });
    },
    [],
  );

  useEffect(() => {
    if (!pendingWorkspaceSettings) return;
    setSettingsContext({
      workspaceId: pendingWorkspaceSettings.workspaceId,
      initialTab: pendingWorkspaceSettings.initialTab,
      worktreeId: pendingWorkspaceSettings.worktreeId,
      startPage: pendingWorkspaceSettings.startPage,
    });
    consumeWorkspaceSettings();
  }, [consumeWorkspaceSettings, pendingWorkspaceSettings]);

  useEffect(() => {
    if (settingsContext) {
      setWorkspaceSettingsModalOpen(true);
    } else if (!pendingWorkspaceSettings) {
      setWorkspaceSettingsModalOpen(false);
    }
  }, [
    pendingWorkspaceSettings,
    setWorkspaceSettingsModalOpen,
    settingsContext,
  ]);

  useEffect(() => {
    return (): void => {
      useNavigationStore.getState().setWorkspaceSettingsModalOpen(false);
    };
  }, []);

  // Sidebar worktree-row action requests. Each opens the matching
  // WorktreeManager-hosted modal, mirroring the `pendingWorkspaceSettings`
  // consume pattern above. WorktreeManager is always mounted under MainPage,
  // so these work regardless of which page the sidebar row was clicked from.
  useEffect(() => {
    if (!pendingDispatchPipeline) return;
    openDispatchPipelineModal({
      projectId: pendingDispatchPipeline.projectId,
      worktreeId: pendingDispatchPipeline.worktreeId,
    });
    consumeDispatchPipelineRequest();
  }, [
    pendingDispatchPipeline,
    openDispatchPipelineModal,
    consumeDispatchPipelineRequest,
  ]);

  useEffect(() => {
    if (!pendingAddRepoAdhoc) return;
    setAddRepoAdhocContext({
      workspaceId: pendingAddRepoAdhoc.projectId,
      worktreeId: pendingAddRepoAdhoc.worktreeId,
    });
    consumeAddRepoAdhocRequest();
  }, [pendingAddRepoAdhoc, consumeAddRepoAdhocRequest]);

  useEffect(() => {
    if (!pendingSplitWorkspace) return;
    setSplitWorkspaceContext({
      workspaceId: pendingSplitWorkspace.projectId,
      worktreeId: pendingSplitWorkspace.worktreeId,
    });
    consumeSplitWorkspaceRequest();
  }, [pendingSplitWorkspace, consumeSplitWorkspaceRequest]);

  useEffect(() => {
    if (!pendingDriftDetails) return;
    handleOpenDriftDetails(
      pendingDriftDetails.projectId,
      pendingDriftDetails.worktreeId,
    );
    consumeDriftDetailsRequest();
  }, [pendingDriftDetails, handleOpenDriftDetails, consumeDriftDetailsRequest]);

  useEffect(() => {
    function handleOpenWorktreeSettings(event: Event): void {
      if (!(event instanceof CustomEvent)) {
        return;
      }

      const detail: unknown = event.detail;
      if (!isOpenWorktreeSettingsEventDetail(detail)) {
        return;
      }

      handleOpenSettingsTab(detail.tab);
    }

    window.addEventListener(
      OPEN_WORKTREE_SETTINGS_EVENT,
      handleOpenWorktreeSettings,
    );

    return (): void => {
      window.removeEventListener(
        OPEN_WORKTREE_SETTINGS_EVENT,
        handleOpenWorktreeSettings,
      );
    };
  }, [handleOpenSettingsTab]);

  const requestArchiveWorktree = useCallback(
    async (
      projectId: string,
      worktreeId: string,
      options?: ArchiveWorktreeOptions,
    ): Promise<void> => {
      // Read at call time, not captured, so this callback keeps a stable
      // identity and never pins an old projects list (see handleOpenSettingsTab).
      const project = useProjectsStore
        .getState()
        .projects.find((p) => p.id === projectId);
      const worktree =
        project && project.type !== 'cowork'
          ? project.worktrees.find((wt) => wt.id === worktreeId)
          : undefined;
      const wasMerged =
        worktree?.status === 'done' && project?.type === 'multi-repo';

      try {
        await archiveWorktree(projectId, worktreeId, options);
      } catch (err) {
        if (err instanceof TeardownFailedError) {
          err.deleteBranch = options?.deleteBranch;
          err.expectedBranchName = options?.expectedBranchName;
          err.lockAfterArchive = options?.lockAfterArchive;
          err.deleteWithoutRetentionIfMissing =
            options?.deleteWithoutRetentionIfMissing;
          setTeardownError(err);
          return;
        }
        if (
          offerDiscardForRefusal(err, {
            projectId,
            worktreeId,
            worktreeName: worktree?.label ?? worktree?.branchName ?? worktreeId,
            retry: () =>
              void requestArchiveWorktreeRef.current(
                projectId,
                worktreeId,
                options,
              ),
          })
        )
          return;
        const appError = toAppError(resolveClientAppError(err));
        if (appError)
          showWorktreeLifecycleFailure(
            appError,
            "Couldn't archive the worktree.",
          );
        return;
      }

      finishWorktreeArchive({
        projectId,
        worktreeId,
        refreshReferenceRepos: wasMerged,
      });
    },
    [archiveWorktree],
  );
  // A discard offer's Retry runs the latest request, not this render's.
  const requestArchiveWorktreeRef = useRef(requestArchiveWorktree);
  useEffect(() => {
    requestArchiveWorktreeRef.current = requestArchiveWorktree;
  }, [requestArchiveWorktree]);

  // The teardown failure dialog's "Delete without teardown".
  const requestArchiveWithoutTeardown = useCallback(
    function retryWithoutTeardown(
      projectId: string,
      worktreeId: string,
      options: ArchiveWorktreeOptions,
    ): void {
      const project = projects.find((p) => p.id === projectId);
      const worktree =
        project && project.type !== 'cowork'
          ? project.worktrees.find((wt) => wt.id === worktreeId)
          : undefined;
      forceArchiveWorktree(projectId, worktreeId, options)
        .then(() => {
          finishWorktreeArchive({
            projectId,
            worktreeId,
            refreshReferenceRepos: false,
          });
        })
        .catch((err: unknown) => {
          if (
            offerDiscardForRefusal(err, {
              projectId,
              worktreeId,
              worktreeName:
                worktree?.label ?? worktree?.branchName ?? worktreeId,
              retry: () => retryWithoutTeardown(projectId, worktreeId, options),
            })
          )
            return;
          const appError = toAppError(resolveClientAppError(err));
          if (appError)
            showWorktreeLifecycleFailure(
              appError,
              "Couldn't delete the worktree.",
            );
        });
    },
    [forceArchiveWorktree, projects],
  );

  // Sidebar-initiated archive requests. Routes through the same
  // `requestArchiveWorktree` the kanban board's row action uses so a teardown
  // failure surfaces the retry/without-teardown `TeardownFailureDialog` instead of
  // the sidebar's toast-only fallback. Mirrors the other pending-request
  // consume effects above.
  useEffect(() => {
    if (!pendingArchiveWorktree) return;
    void requestArchiveWorktree(
      pendingArchiveWorktree.projectId,
      pendingArchiveWorktree.worktreeId,
      {
        deleteBranch: pendingArchiveWorktree.deleteBranch,
        expectedBranchName: pendingArchiveWorktree.expectedBranchName,
        lockAfterArchive: pendingArchiveWorktree.lockAfterArchive,
        deleteWithoutRetentionIfMissing:
          pendingArchiveWorktree.deleteWithoutRetentionIfMissing,
      },
    );
    consumeArchiveWorktreeRequest();
  }, [
    pendingArchiveWorktree,
    requestArchiveWorktree,
    consumeArchiveWorktreeRequest,
  ]);

  const handleChooseChat = useCallback(
    async (
      workspaceId: string,
      taskText: string,
      createOptions?: CreateFromOptions,
    ): Promise<void> => {
      setCreateTaskOpen(false);
      useNavigationStore.getState().navigate('main');

      const created = await useProjectsStore
        .getState()
        .createWorktree(workspaceId, {
          ...createOptions,
          suppressStartPage: taskText.trim().length > 0,
        });
      if (!created) return;

      // Explicit targeting: do not rely on `selectedWorktree` between awaits.
      // A rapid second Create Task in another workspace can flip the
      // selection before sendMessage runs.
      await useChatStore
        .getState()
        .loadAllWorktreeTabs([
          { projectId: workspaceId, worktreeId: created.id },
        ]);

      const wcKey = `${workspaceId}/${created.id}`;
      const wc = useChatStore.getState().worktreeChats[wcKey];
      const chatId = wc?.activeTabId;
      if (!chatId) return;
      // Branch/PR mode may create-and-open with no task text: nothing to send.
      if (taskText.trim().length === 0) return;

      await useChatStore.getState().sendMessage(taskText, undefined, {
        projectId: workspaceId,
        worktreeId: created.id,
        chatId,
      });
    },
    [],
  );

  const handleChoosePlan = useCallback(
    async (
      workspaceId: string,
      taskText: string,
      createOptions?: CreateFromOptions,
    ): Promise<void> => {
      setCreateTaskOpen(false);
      useNavigationStore.getState().navigate('main');

      const created = await useProjectsStore
        .getState()
        .createWorktree(workspaceId, {
          ...createOptions,
          suppressStartPage: taskText.trim().length > 0,
        });
      if (!created) return;

      await useChatStore
        .getState()
        .loadAllWorktreeTabs([
          { projectId: workspaceId, worktreeId: created.id },
        ]);

      const wcKey = `${workspaceId}/${created.id}`;
      const wc = useChatStore.getState().worktreeChats[wcKey];
      const chatId = wc?.activeTabId;
      if (!chatId) return;
      // Branch/PR mode may create-and-open with no task text: no message means
      // no plan-mode toggle either.
      if (taskText.trim().length === 0) return;

      // A freshly created worktree's active tab has planMode === false by
      // default, so this flips it to true. The toggle must run before
      // sendMessage so the queued/sent message goes out under plan mode.
      useChatStore.getState().togglePlanMode({
        projectId: workspaceId,
        worktreeId: created.id,
        chatId,
      });
      await useChatStore.getState().sendMessage(taskText, undefined, {
        projectId: workspaceId,
        worktreeId: created.id,
        chatId,
      });
    },
    [],
  );

  const handleChoosePipeline = useCallback(
    (
      workspaceId: string,
      taskText: string,
      createOptions?: CreateFromOptions,
    ): void => {
      const workspace = projects.find((p) => p.id === workspaceId);
      if (!workspace) return;

      let cwd: string | undefined;
      const repoChoices: PipelineRepoChoice[] = [];
      if (workspace.type === 'single-repo') {
        cwd = workspace.repoPath;
      } else if (workspace.type === 'multi-repo') {
        cwd = workspace.sourceRepoPath;
        if (workspace.sourceRepoPath) {
          repoChoices.push({
            repoId: WORKSPACE_ROOT_REPO_ID,
            repoName: WORKSPACE_ROOT_REPO_NAME,
          });
        }
        for (const repo of workspace.repos) {
          repoChoices.push({ repoId: repo.id, repoName: repo.name });
        }
      }
      if (!cwd) return;

      setCreateTaskOpen(false);
      setTaskPipelineRunError(null);
      setTaskReadyPipelineCtx({
        workspaceId,
        taskText,
        cwd,
        repoChoices,
        createOptions,
      });
    },
    [projects],
  );

  const handleTaskPipelineClose = useCallback((): void => {
    if (taskPipelineRunning) return;
    setTaskReadyPipelineCtx(null);
    setTaskPipelineRunError(null);
    setTaskWatcherSelection(null);
  }, [taskPipelineRunning]);

  const handleTaskPipelineRun = useCallback(
    async (
      pipelineId: string,
      pipeline: PipelineData,
      inputs: Record<string, string> | undefined,
      selectedRepoId: string | undefined,
      pluginCollectionContext: PipelinePluginCollectionContext,
    ): Promise<void> => {
      const ctx = taskReadyPipelineCtx;
      if (!ctx) return;

      setTaskPipelineRunning(true);
      setTaskPipelineRunError(null);

      try {
        useNavigationStore.getState().navigate('main');

        const created = await useProjectsStore
          .getState()
          .createWorktree(
            ctx.workspaceId,
            withStartPageSuppressed(ctx.createOptions),
          );
        if (!created) {
          setTaskPipelineRunning(false);
          setTaskPipelineRunError("Couldn't create the worktree.");
          return;
        }

        // Phase A returned a `git-pending` worktree row. Defer both the
        // task-branch naming and the pipeline execution until the
        // `worktree:git-ready` event arrives — the worktree directory does
        // not exist on disk yet so probing it would fail.
        useProjectsStore
          .getState()
          .enqueuePendingTaskBranchNaming(
            ctx.workspaceId,
            created.id,
            ctx.taskText,
          );

        usePipelineRunsStore.getState().enqueuePendingExecution({
          projectId: ctx.workspaceId,
          worktreeId: created.id,
          pipelineId,
          pipelineContent: pipeline.content,
          ...(selectedRepoId ? { selectedRepoId } : {}),
          eventName: 'task_ready',
          eventData: { task_ready: { task_text: ctx.taskText } },
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
          pluginCollectionPreferences: pluginCollectionContext.preferences,
          ...(pluginCollectionContext.modelAliasPreferences
            ? {
                modelAliasPreferences:
                  pluginCollectionContext.modelAliasPreferences,
              }
            : {}),
          modelConfig: pluginCollectionContext.modelConfig,
          ...(pluginCollectionContext.pipelinePreferenceLocator
            ? {
                pipelinePreferenceLocator:
                  pluginCollectionContext.pipelinePreferenceLocator,
              }
            : {}),
          ...(pipeline.info.source === 'shared' &&
          pipeline.info.serverId &&
          pipeline.info.remoteId
            ? {
                sharedPipeline: {
                  serverId: pipeline.info.serverId,
                  remoteId: pipeline.info.remoteId,
                },
              }
            : {}),
          pipelineName: pipeline.info.name,
          taskText: ctx.taskText,
          ...(taskWatcherSelection
            ? {
                watcherDestination: taskWatcherSelection.destination,
                ...(taskWatcherSelection.followUpInstruction
                  ? {
                      watcherFollowUpInstruction:
                        taskWatcherSelection.followUpInstruction,
                    }
                  : {}),
              }
            : {}),
        });

        setTaskPipelineRunning(false);
        setTaskReadyPipelineCtx(null);
        setTaskWatcherSelection(null);
      } catch (err: unknown) {
        setTaskPipelineRunning(false);
        const appError = toAppError(resolveClientAppError(err));
        // The modal's run error is text: our sentence leads, and a
        // classified failure shows its catalog title.
        if (appError)
          setTaskPipelineRunError(
            inlineFailureText(
              inlineFailure(appError, "Couldn't start the workflow."),
            ),
          );
      }
    },
    [taskReadyPipelineCtx, taskWatcherSelection],
  );

  const settingsWorkspace = settingsContext
    ? (projects.find(
        (p) => p.id === settingsContext.workspaceId && p.type === 'multi-repo',
      ) as MultiRepoSidebarItem | undefined)
    : undefined;

  const settingsProject = settingsContext
    ? (projects.find(
        (p) => p.id === settingsContext.workspaceId && p.type === 'single-repo',
      ) as SingleRepoSidebarItem | undefined)
    : undefined;
  const settingsCowork = settingsContext
    ? projects.find(
        (p): p is CoworkSidebarItem =>
          p.id === settingsContext.workspaceId && p.type === 'cowork',
      )
    : undefined;
  const settingsChatProject = settingsCowork
    ? (chatProjects.find((project) => project.id === settingsCowork.id) ?? null)
    : null;
  const retrySettingsLazyModals = useCallback(() => {
    setProjectSettingsModal(() => lazy(loadProjectSettingsModal));
    setWorkspaceSettingsModal(() => lazy(loadWorkspaceSettingsModal));
    setChatProjectSettingsModal(() => lazy(loadChatProjectSettingsModal));
    setSettingsLazyRetryKey((key) => key + 1);
  }, []);
  const settingsLazyBoundaryKey = settingsContext
    ? `${settingsLazyRetryKey}:${settingsContext.workspaceId}:${
        settingsContext.worktreeId ?? ''
      }:${settingsContext.initialTab ?? ''}`
    : settingsLazyRetryKey;

  const modalLayer = (
    <>
      {addRepoAdhocContext && (
        <AddRepoToWorktreeModal
          sourceWorkspaceId={addRepoAdhocContext.workspaceId}
          sourceWorktreeId={addRepoAdhocContext.worktreeId}
          onOpenSharedDestination={(workspaceId) => {
            setAddRepoAdhocContext(null);
            setSharedTaskWorkspaceId(workspaceId);
            setCreateTaskOpen(true);
          }}
          onClose={() => setAddRepoAdhocContext(null)}
        />
      )}

      {splitWorkspaceContext && (
        <SplitWorkspaceModal
          workspaceId={splitWorkspaceContext.workspaceId}
          worktreeId={splitWorkspaceContext.worktreeId}
          onClose={() => setSplitWorkspaceContext(null)}
        />
      )}

      {createTaskOpen && (
        <CreateTaskModal
          initialWorkspaceId={sharedTaskWorkspaceId}
          onClose={() => {
            setCreateTaskOpen(false);
            setSharedTaskWorkspaceId(undefined);
          }}
          onChooseChat={(workspaceId, taskText, createOptions) => {
            void handleChooseChat(workspaceId, taskText, createOptions);
          }}
          onChoosePlan={(workspaceId, taskText, createOptions) => {
            void handleChoosePlan(workspaceId, taskText, createOptions);
          }}
          onChoosePipeline={handleChoosePipeline}
        />
      )}

      {taskReadyPipelineCtx && (
        <TaskReadyPipelineModal
          cwd={taskReadyPipelineCtx.cwd}
          repoChoices={taskReadyPipelineCtx.repoChoices}
          onClose={handleTaskPipelineClose}
          onRun={handleTaskPipelineRun}
          isRunning={taskPipelineRunning}
          runError={taskPipelineRunError}
          watcherRecipientGroups={taskWatcherGroups}
          onWatcherSelectionChange={setTaskWatcherSelection}
        />
      )}

      {dispatchPipelineModal}

      {settingsWorkspace && (
        <LazyLoadErrorBoundary
          label="Project settings"
          message="Couldn't load project settings."
          onClose={() => setSettingsContext(null)}
          onRetry={retrySettingsLazyModals}
          resetKey={settingsLazyBoundaryKey}
        >
          <Suspense fallback={null}>
            <WorkspaceSettingsModal
              isOpen
              onClose={() => setSettingsContext(null)}
              workspace={settingsWorkspace}
              onOpenSharedDestination={(workspaceId) =>
                setSettingsContext({ workspaceId, initialTab: 'repositories' })
              }
              initialTab={
                settingsContext?.initialTab === 'share'
                  ? undefined
                  : settingsContext?.initialTab
              }
              driftWorktreeId={settingsContext?.worktreeId}
              startPageIntent={settingsContext?.startPage}
              onDelete={() => setSettingsContext(null)}
            />
          </Suspense>
        </LazyLoadErrorBoundary>
      )}

      {settingsProject && (
        <LazyLoadErrorBoundary
          label="Project settings"
          message="Couldn't load project settings."
          onClose={() => setSettingsContext(null)}
          onRetry={retrySettingsLazyModals}
          resetKey={settingsLazyBoundaryKey}
        >
          <Suspense fallback={null}>
            <ProjectSettingsModal
              isOpen
              onClose={() => setSettingsContext(null)}
              project={settingsProject}
              onOpenSharedDestination={(workspaceId) =>
                setSettingsContext({ workspaceId, initialTab: 'repositories' })
              }
              initialTab={
                settingsContext?.initialTab === 'details' ||
                settingsContext?.initialTab === 'scripts' ||
                settingsContext?.initialTab === 'hooks' ||
                settingsContext?.initialTab === 'environment' ||
                settingsContext?.initialTab === 'code-graph' ||
                settingsContext?.initialTab === 'start-page'
                  ? settingsContext.initialTab
                  : undefined
              }
              driftWorktreeId={settingsContext?.worktreeId}
              startPageIntent={settingsContext?.startPage}
            />
          </Suspense>
        </LazyLoadErrorBoundary>
      )}

      {settingsCowork && settingsChatProject && (
        <LazyLoadErrorBoundary
          label="Cowork project settings"
          message="Couldn't load Cowork project settings."
          onClose={() => setSettingsContext(null)}
          onRetry={retrySettingsLazyModals}
          resetKey={settingsLazyBoundaryKey}
        >
          <Suspense fallback={null}>
            <ChatProjectSettingsModal
              isOpen
              project={settingsChatProject}
              externalPath={settingsCowork.externalPath}
              initialTab={
                settingsContext?.initialTab === 'environment' ||
                settingsContext?.initialTab === 'share'
                  ? settingsContext.initialTab
                  : 'general'
              }
              onClose={() => setSettingsContext(null)}
              onSave={updateChatProject}
              onDelete={deleteChatProject}
            />
          </Suspense>
        </LazyLoadErrorBoundary>
      )}

      {teardownError && (
        <TeardownFailureDialog
          error={teardownError}
          isRetrying={isTeardownRetrying}
          onRetry={() => {
            setIsTeardownRetrying(true);
            setTeardownError(null);
            void requestArchiveWorktree(
              teardownError.projectId,
              teardownError.worktreeId,
              {
                deleteBranch: teardownError.deleteBranch,
                expectedBranchName: teardownError.expectedBranchName,
                lockAfterArchive: teardownError.lockAfterArchive,
                deleteWithoutRetentionIfMissing:
                  teardownError.deleteWithoutRetentionIfMissing,
              },
            )
              .catch((err: unknown) => {
                if (err instanceof TeardownFailedError) {
                  setTeardownError(err);
                  return;
                }
                const appError = toAppError(resolveClientAppError(err));
                if (appError)
                  showWorktreeLifecycleFailure(
                    appError,
                    "Couldn't archive the worktree.",
                  );
              })
              .finally(() => setIsTeardownRetrying(false));
          }}
          onSkipTeardown={() => {
            setTeardownError(null);
            requestArchiveWithoutTeardown(
              teardownError.projectId,
              teardownError.worktreeId,
              {
                deleteBranch: teardownError.deleteBranch,
                expectedBranchName: teardownError.expectedBranchName,
                lockAfterArchive: teardownError.lockAfterArchive,
                deleteWithoutRetentionIfMissing:
                  teardownError.deleteWithoutRetentionIfMissing,
              },
            );
          }}
          onCancel={() => setTeardownError(null)}
        />
      )}

      {pendingWorkspaceRepair && (
        <Suspense fallback={null}>
          <WorkspaceRepairDialog
            workspaceName={pendingWorkspaceRepair.workspaceName}
            worktreeId={pendingWorkspaceRepair.id}
            branchName={pendingWorkspaceRepair.branchName}
            issues={pendingWorkspaceRepair.repairIssues}
            isPending={workspaceRepairPending}
            onRepair={(restoreClaudeMd) => {
              void repairPendingWorkspaceWorktree(restoreClaudeMd);
            }}
            onCancel={() => {
              void cancelPendingWorkspaceRepair();
            }}
          />
        </Suspense>
      )}

      {pendingHookChatPluginInstallPrompt && (
        <Suspense fallback={null}>
          <HookChatPluginInstallDialog
            worktreeLabel={pendingHookChatPluginInstallPrompt.worktreeLabel}
            items={pendingHookChatPluginInstallPrompt.items}
            onClose={dismissPendingHookChatPluginInstallPrompt}
          />
        </Suspense>
      )}

      {pendingRecommendedPluginPrompt &&
        !pendingHookChatPluginInstallPrompt && (
          <Suspense fallback={null}>
            <RecommendedPluginsPromptDialog
              prompt={pendingRecommendedPluginPrompt}
            />
          </Suspense>
        )}
    </>
  );

  const kanbanView = viewMode === 'kanban';

  return (
    <div className="relative h-full">
      {showEmptyState ? (
        <Suspense fallback={null}>
          <HomeSurface variant="embedded" />
        </Suspense>
      ) : (
        <div
          ref={splitLayoutRef}
          className="flex h-full min-h-0 flex-col lg:flex-row"
        >
          {kanbanView && (
            <section
              data-testid="worktree-panel"
              className="relative flex h-[52vh] min-h-105 w-full min-w-0 flex-1 flex-col overflow-hidden bg-base lg:h-full"
            >
              <div className="electron-drag relative flex max-h-10.75 items-center gap-2 border-b px-2.5 py-2">
                {/* When the sidebar is hidden its Create Task / Add workspace
 actions aren't reachable, so surface them here — inset past
 the persistent titlebar corner so they aren't hidden behind
 the macOS window controls. When the sidebar is shown these
 live in the sidebar, so they're omitted here to avoid
 duplication. */}
                {sidebarHidden && (
                  <>
                    <div
                      className="shrink-0"
                      style={{
                        width: titlebarCornerWidthCss(
                          shouldReserveSidebarTrafficLightRegion(
                            localPlatform(),
                          ),
                          true,
                        ),
                      }}
                    />
                    <div className="electron-no-drag flex items-center gap-1">
                      <Tooltip
                        label="Add a project first"
                        suppressed={!createTaskDisabled}
                      >
                        <Button
                          size="compact"
                          onClick={() => {
                            setCreateTaskOpen(true);
                          }}
                          disabled={createTaskDisabled}
                          data-onboarding-anchor="task-create"
                        >
                          <TaskIcon size="sm" />
                          Create task
                        </Button>
                      </Tooltip>
                      <Button
                        variant="ghost"
                        size="compact"
                        onClick={() => openAddRepoModal()}
                      >
                        <AppCatalogPlusIcon size="sm" />
                        Add project
                      </Button>
                    </div>
                  </>
                )}
                <span className="electron-no-drag inline-flex">
                  <Tooltip
                    label={
                      kanbanChatPanelVisible
                        ? 'Hide chat panel'
                        : 'Show chat panel'
                    }
                  >
                    <Button
                      variant={kanbanChatPanelVisible ? 'secondary' : 'ghost'}
                      size="compact"
                      iconOnly
                      onClick={handleToggleKanbanChatPanel}
                      aria-label={
                        kanbanChatPanelVisible
                          ? 'Hide chat panel'
                          : 'Show chat panel'
                      }
                      aria-pressed={kanbanChatPanelVisible}
                    >
                      <AppCatalogMessageIcon size="sm" aria-hidden="true" />
                    </Button>
                  </Tooltip>
                </span>
              </div>

              <div className="relative flex min-h-0 flex-1 flex-col">
                <div
                  ref={worktreeListScrollRef}
                  className="min-h-0 flex-1 overflow-auto px-1.5 py-2"
                >
                  {isLoading ? (
                    <div className="flex h-24 items-center justify-center text-s fg-secondary">
                      Loading repositories…
                    </div>
                  ) : (
                    <WorktreeKanbanBoard
                      visibleProjects={visibleProjects}
                      diffStats={diffStats}
                      uncommittedChanges={uncommittedChanges}
                      commitsAhead={commitsAhead}
                      hasUnpushedCommits={hasUnpushedCommits}
                      baseBranches={baseBranches}
                      hasRemoteTracking={hasRemoteTracking}
                      hasBranchBeenPushed={hasBranchBeenPushed}
                      repoBranches={repoBranches}
                      workspaceDrift={workspaceDrift}
                      discoveryLoading={discoveryLoading}
                      selectedWorktreeKey={selectedWorktreeKey}
                      streamingWorktreeKeys={streamingWorktreeKeys}
                      backgroundTaskCounts={backgroundTaskCounts}
                      activeSessionWorktreeKeys={activeSessionWorktreeKeys}
                      awaitingApprovalKeys={awaitingApprovalKeys}
                      pendingQuestionWorktreeKeys={pendingQuestionWorktreeKeys}
                      toolApprovalWorktreeKeys={toolApprovalWorktreeKeys}
                      unreadWorktreeKeys={unreadWorktreeKeys}
                      setupRunningWorktrees={setupRunningWorktrees}
                      runRunningWorktrees={runRunningWorktrees}
                      tearingDownWorktrees={tearingDownWorktrees}
                      archivingWorktrees={archivingWorktrees}
                      pipelineRunningWorktreeKeys={pipelineRunningWorktreeKeys}
                      pipelineUnseenWorktreeKeys={unseenPipelineWorktreeKeys}
                      pipelineUnseenFailedWorktreeKeys={
                        unseenFailedPipelineWorktreeKeys
                      }
                      pipelinePausedWorktreeKeys={pipelinePausedWorktreeKeys}
                      baseBranchExistsLocally={baseBranchExistsLocally}
                      baseBranchExistsInRemote={baseBranchExistsInRemote}
                      worktreeStatusMap={worktreeStatusMap}
                      onSelectWorktree={handleSidebarSelectWorktree}
                      onArchiveWorktree={(
                        projectId,
                        worktreeId,
                        options,
                      ): void => {
                        void requestArchiveWorktree(
                          projectId,
                          worktreeId,
                          options,
                        );
                      }}
                      onOpenDriftDetails={handleOpenDriftDetails}
                      onAddRepoToWorktree={(workspaceId, worktreeId, repoId) =>
                        addRepoToWorktree(workspaceId, worktreeId, repoId)
                      }
                      onRemoveRepoFromWorktree={(
                        workspaceId,
                        worktreeId,
                        repoId,
                      ) =>
                        removeRepoFromWorktree(workspaceId, worktreeId, repoId)
                      }
                      onCreateBranchWorktree={(projectId, worktreeId): void => {
                        void (async (): Promise<void> => {
                          const preparation = await prepareBranchFromWorktree(
                            projectId,
                            worktreeId,
                          );
                          if (preparation.status !== 'ready') return;
                          await createWorktree(projectId, {
                            baseWorktreeId: worktreeId,
                            select: false,
                            onRegistered: (created): void => {
                              const finishPendingFork =
                                beginPendingWorktreeTabFork(
                                  projectId,
                                  created.id,
                                );
                              void (async (): Promise<void> => {
                                try {
                                  const { forkOpenWorktreeState } =
                                    await import('@/lib/worktree-state-fork');
                                  await forkOpenWorktreeState({
                                    projectId,
                                    sourceWorktreeId: worktreeId,
                                    destinationWorktreeId: created.id,
                                  });
                                } catch (error: unknown) {
                                  // The branch exists; it just opens
                                  // without the source's tabs.
                                  reportRendererConsoleError(
                                    'Failed to carry open tabs to branched worktree',
                                    { error },
                                  );
                                  reportClientAppError(error);
                                } finally {
                                  finishPendingFork();
                                  useChatStore
                                    .getState()
                                    .selectWorktree(projectId, created.id);
                                }
                              })();
                            },
                          });
                        })();
                      }}
                      onDispatchPipeline={(projectId, worktreeId): void => {
                        openDispatchPipelineModal({ projectId, worktreeId });
                      }}
                      onAddRepoToWorktreeAdhoc={handleOpenAddRepoAdhoc}
                      onSplitTemporaryWorkspace={handleOpenSplitWorkspace}
                      onToggleHiddenWorktree={(
                        projectId,
                        worktreeId,
                        nextHidden,
                      ): void => {
                        void setWorktreeHidden(
                          projectId,
                          worktreeId,
                          nextHidden,
                        );
                      }}
                      onWorktreeDoubleClick={(): void => {
                        if (!kanbanChatPanelVisible) {
                          handleToggleKanbanChatPanel();
                        }
                      }}
                    />
                  )}
                </div>
              </div>
            </section>
          )}

          {chatPanelVisible && (
            <div
              className={selectedWorktreeSplitLocked ? 'hidden' : 'contents'}
              data-testid="worktree-central-panels"
            >
              <WorktreePart
                projectId={worktreeChatSelection?.projectId ?? null}
                worktreeId={worktreeChatSelection?.worktreeId ?? null}
                viewMode={viewMode}
                viewModeReady={viewModeReady}
                visible={isWorktreeSurfaceVisible({
                  activePage,
                  settingsOpen,
                  splitLocked: selectedWorktreeSplitLocked,
                  archivedViewerOpen: archivedWorktreeViewer !== null,
                  archivedOverviewOpen: archivedOverviewWorkspaceId !== null,
                  sharedContainerPastSharesOpen,
                  sharedContainerViewerOpen,
                })}
                onOpenSettingsTab={handleOpenSettingsTab}
              />
            </div>
          )}

          {selectedWorktreeSplitLocked && worktreeChatSelection && (
            <Suspense fallback={null}>
              <SplitWorkflowView
                projectId={worktreeChatSelection.projectId}
                worktreeId={worktreeChatSelection.worktreeId}
              />
            </Suspense>
          )}
        </div>
      )}

      {/* Archived-worktree viewer: absolute z-30 overlay above WorktreePart
          (grid content stays mounted behind it, mirroring the cowork archive
          overlay), below app modals at z-modal. `electron-no-drag` is
          load-bearing: WorktreePart paints an `electron-drag` rect over the
          top 40px of this same area, and app-region hit testing ignores
          z-order — without the hole, the viewer's header buttons receive
          window-drag instead of clicks (real mice only; Playwright's
          synthetic clicks bypass app-region, so E2E cannot catch it). */}
      {archivedWorktreeViewer !== null ? (
        <div className="electron-no-drag absolute inset-0 z-30 bg-base">
          <ArchivedContainerView
            workspaceId={archivedWorktreeViewer.workspaceId}
            containerId={archivedWorktreeViewer.containerId}
            onClose={closeArchivedViewerToOverview}
          />
        </div>
      ) : archivedOverviewWorkspaceId !== null ? (
        <div className="electron-no-drag absolute inset-0 z-30 bg-base">
          <ArchivedContainersOverviewPage
            workspaceId={archivedOverviewWorkspaceId}
            surface="code"
            onClose={closeArchivedOverview}
          />
        </div>
      ) : null}

      {/* Shared-container recipient surface: same absolute overlay slot as the
          archived viewer (grid content stays mounted behind it), and the same
          `electron-no-drag` hole so its header controls receive clicks rather
          than window-drag. */}
      {/* Recipient's Past shares page: the "Archived and deleted" overview's
          slot and wrapper. Opening it closes the archived overlays, and the
          share viewer mounts after it, so an accepted share opened from the
          page covers it while the page closes. */}
      {sharedContainerPastSharesOpen && (
        <div className="electron-no-drag absolute inset-0 z-30 bg-base">
          <SharedContainerPastSharesPage
            onClose={closeSharedContainerPastShares}
          />
        </div>
      )}

      {sharedContainerViewerOpen && (
        <div className="electron-no-drag absolute inset-0 z-30 bg-base">
          <SharedContainerWorkspace onClose={closeSharedContainerViewer} />
        </div>
      )}

      {modalLayer}
    </div>
  );
}
