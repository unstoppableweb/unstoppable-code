import {
  useSidebarOrgProjectPlaceholders,
  type SidebarOrgProjectPlaceholder,
} from './useSidebarOrgProjectPlaceholders';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  type CoworkWorkEntryMeta,
  type DiffStats,
  type RepoBranchInfo,
  type SidebarItem,
  type SidebarSortMode,
  type WorkspaceDriftSummary,
  type WorkspaceContext,
} from '@canopy/desktop-shared/types';
import type { WorktreeUiStatus } from '@/lib/worktree-status';
import {
  useProjectsStore,
  type ArchiveWorktreeOptions,
  type CreateWorktreeOptions,
} from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import { useActivityStore } from '@/stores/activityStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useScriptsStore } from '@/stores/scriptsStore';
import {
  indexActiveScriptRuns,
  worktreesWithActiveRun,
} from '@/components/worktree/worktree-launch';
import { useBranchGroupingPreferenceStore } from '@/stores/branchGroupingPreferenceStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { workEntryRecencyMs } from '@/lib/sidebar-ordering';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { useNavigationStore } from '@/stores/navigationStore';
import { useSidebarScopingContext } from './useSidebarScopingContext';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { prepareBranchFromWorktree } from '@/lib/prepareBranchFromWorktree';
import { beginPendingWorktreeTabFork } from '@/stores/chat/pending-worktree-tab-forks';
import {
  buildSidebarWorkspaceFilterOptions,
  buildWorktreeStatusMap,
  partitionSidebarWorkspaces,
  type SidebarWorkspaceFilterOption,
} from './sidebarWorkspacesDerivation';
import { useChatBadgeKeys } from './useChatBadgeKeys';
import { parseBackgroundTaskCounts } from './chatBadgeKeys';
import { useLiveTaskSnapshots } from '@/hooks/useBackgroundTaskCounts';
import { addPlanExploreOriginWorktreeKeys } from '@/lib/planExploreWorktreeKeys';
import { refreshPrivateMemoryRows } from '@/lib/privateMemory';

/**
 * Everything the "Code Projects" sidebar section needs to render its
 * workspace/worktree list. The field set mirrors the props `WorktreeManager`
 * feeds to `ProjectSection` so both surfaces render identical rows; the extra
 * handlers cover selection, reordering, filtering, and settings navigation.
 */
export interface SidebarWorkspacesModel {
  setupDialog?: ReactNode;
  placeholderRows: SidebarOrgProjectPlaceholder[];
  linkedPersonalWorkspaceIds: readonly string[];
  startPlaceholderSetup: (
    projectId: string,
    restoreFocusTarget?: HTMLElement | null,
  ) => Promise<void>;
  cancelPlaceholderSetup: (projectId: string) => Promise<void>;
  scopingContext: WorkspaceContext | undefined;
  /** Workspaces ordered pin-first, then by the Projects section sort mode. */
  sortedProjects: SidebarItem[];
  /** Always-visible workspaces (not filtered, has visible worktrees). */
  visibleProjects: SidebarItem[];
  /** Workspaces that collapsed into the "Hidden Projects" group. */
  hiddenProjects: SidebarItem[];
  /** Options for the filter dropdown, one per workspace. */
  filterWorkspaceOptions: SidebarWorkspaceFilterOption[];
  /** Currently filtered-out workspace ids. */
  hiddenWorkspaceIds: string[];
  /** True while the projects list is still loading for the first time. */
  isLoading: boolean;
  /** Workspace ids currently in the runtime-added highlight-pulse window. */
  recentlyAddedProjectIds: ReadonlySet<string>;
  /** `${projectId}/${worktreeId}` → UI status for list-row indicators. */
  worktreeStatusMap: Map<string, WorktreeUiStatus>;

  // --- CAN-1074 recency + pinning ---
  /** Ordering mode for the top-level Projects section. */
  projectSortMode: SidebarSortMode;
  /** Switch the Projects section between recency and manual ordering. */
  onSetProjectSortMode: (mode: SidebarSortMode) => void;
  /** Pin/unpin a workspace within the Projects section. */
  onToggleWorkspacePinned: (workspaceId: string, pinned: boolean) => void;
  /** Switch a workspace's child rows between recency and manual ordering. */
  onSetWorkspaceItemSortMode: (
    workspaceId: string,
    mode: SidebarSortMode,
  ) => void;
  /** Pin/unpin a worktree within its workspace's section. */
  onToggleWorktreePinned: (
    projectId: string,
    worktreeId: string,
    pinned: boolean,
  ) => void;

  // --- WorktreeItemCollectionProps parity ---
  diffStats: Record<string, DiffStats>;
  uncommittedChanges: Record<string, boolean>;
  commitsAhead: Record<string, boolean>;
  hasUnpushedCommits: Record<string, boolean>;
  baseBranches: Record<string, string | null>;
  defaultBranches: Record<string, string | null>;
  branchGroupingEnabled: boolean;
  hasRemoteTracking: Record<string, boolean>;
  hasBranchBeenPushed: Record<string, boolean>;
  repoBranches: Record<string, RepoBranchInfo[]>;
  workspaceDrift: Record<string, WorkspaceDriftSummary>;
  discoveryLoading: Set<string>;
  selectedWorktreeKey: string | null;
  streamingWorktreeKeys: Set<string>;
  /** Live background tasks by row, for the background spinner (D15). */
  backgroundTaskCounts: ReadonlyMap<string, number>;
  activeSessionWorktreeKeys: Set<string>;
  awaitingApprovalKeys: Set<string>;
  pendingQuestionWorktreeKeys: Set<string>;
  toolApprovalWorktreeKeys: Set<string>;
  unreadWorktreeKeys: Set<string>;
  setupRunningWorktrees: Set<string>;
  runRunningWorktrees: Set<string>;
  tearingDownWorktrees: Set<string>;
  archivingWorktrees: Set<string>;
  pipelineRunningWorktreeKeys: Set<string>;
  unseenPipelineWorktreeKeys: Set<string>;
  unseenFailedPipelineWorktreeKeys: Set<string>;
  pipelinePausedWorktreeKeys: Set<string>;
  baseBranchExistsLocally: Record<string, boolean>;
  baseBranchExistsInRemote: Record<string, boolean>;
  creatingWorktreeForProject: Set<string>;
  workspaceReferenceRepoStatus: ReturnType<
    typeof useProjectsStore.getState
  >['workspaceReferenceRepoStatus'];

  // --- actions ---
  onSelectWorktree: (projectId: string, worktreeId: string) => void;
  onToggleCollapsed: (projectId: string) => void;
  onCreateWorktree: (
    projectId: string,
    options?: Pick<CreateWorktreeOptions, 'worktreeId' | 'onRegistered'>,
  ) => ReturnType<
    ReturnType<typeof useProjectsStore.getState>['createWorktree']
  >;
  onCreateBranchWorktree: (projectId: string, worktreeId: string) => void;
  onReorderProjects: (activeId: string, overId: string) => void;
  onReorderWorktrees: (
    projectId: string,
    activeWorktreeId: string,
    overWorktreeId: string,
  ) => void;
  onSetBranchGroupingOverride: (
    projectId: string,
    worktreeId: string,
    override: 'group' | 'ungroup' | null,
  ) => Promise<void>;
  onArchiveWorktree: (
    projectId: string,
    worktreeId: string,
    options?: ArchiveWorktreeOptions,
  ) => void;
  onAddRepoToWorktree: (
    workspaceId: string,
    worktreeId: string,
    repoId: string,
  ) => void | Promise<void>;
  onRemoveRepoFromWorktree: (
    workspaceId: string,
    worktreeId: string,
    repoId: string,
  ) => void | Promise<void>;
  onSetWorktreeHidden: (
    projectId: string,
    worktreeId: string,
    nextHidden: boolean,
  ) => void;
  /**
   * Open workspace settings via the shared navigation store. `WorktreeManager`
   * (always mounted under `MainPage`) consumes the request and hosts the modal,
   * so this works even when another page is active.
   */
  onOpenSettings: (workspaceId: string) => void;
  onFilterChange: (hiddenWorkspaceIds: string[]) => void;
  /**
   * Open the dispatch-pipeline modal for a worktree. Routes through the shared
   * navigation store; `WorktreeManager` (always mounted) hosts the modal.
   */
  onDispatchPipeline: (projectId: string, worktreeId: string) => void;
  /** Open the ad-hoc add-repo modal for a worktree (WorktreeManager-hosted). */
  onAddRepoToWorktreeAdhoc: (projectId: string, worktreeId: string) => void;
  /** Open the split-workspace modal for a temporary multi-repo worktree (WorktreeManager-hosted). */
  onSplitTemporaryWorkspace: (projectId: string, worktreeId: string) => void;
  /** Open workspace settings on the drift details tab for a worktree. */
  onOpenDriftDetails: (projectId: string, worktreeId: string) => void;
}

/**
 * Store-driven derivation of the sidebar "Code Projects" list. Faithfully
 * reproduces the prop derivations `WorktreeManager` computes for its own aside
 * (`sortedProjects`, `visibleProjects`, `hiddenProjects`, badge key sets, and
 * `worktreeStatusMap`) so the unified sidebar and the legacy aside stay in
 * lock-step while both are mounted.
 *
 * Per-component-local highlight state (`recentlyAddedProjectIds`) is
 * intentionally omitted — it lives entirely in `WorktreeManager` and drives a
 * scroll-into-view pulse that only makes sense for the aside's scroll
 * container.
 */
export function useSidebarWorkspaces(): SidebarWorkspacesModel {
  const projects = useProjectsStore((state) => state.projects);
  const isLoading = useProjectsStore((state) => state.isLoading);
  const hiddenWorkspaceIds = useProjectsStore(
    (state) => state.hiddenWorkspaceIds,
  );
  const setHiddenWorkspaceIds = useProjectsStore(
    (state) => state.setHiddenWorkspaceIds,
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
  const defaultBranches = useProjectsStore((state) => state.defaultBranches);
  const hasRemoteTracking = useProjectsStore(
    (state) => state.hasRemoteTracking,
  );
  const hasBranchBeenPushed = useProjectsStore(
    (state) => state.hasBranchBeenPushed,
  );
  const repoBranches = useProjectsStore((state) => state.repoBranches);
  const workspaceDrift = useProjectsStore((state) => state.workspaceDrift);
  const discoveryLoading = useProjectsStore((state) => state.discoveryLoading);
  const baseBranchExistsLocally = useProjectsStore(
    (state) => state.baseBranchExistsLocally,
  );
  const baseBranchExistsInRemote = useProjectsStore(
    (state) => state.baseBranchExistsInRemote,
  );
  const creatingWorktreeForProject = useProjectsStore(
    (state) => state.creatingWorktreeForProject,
  );
  const tearingDownWorktrees = useProjectsStore(
    (state) => state.tearingDownWorktrees,
  );
  const archivingWorktrees = useProjectsStore(
    (state) => state.archivingWorktrees,
  );
  const workspaceReferenceRepoStatus = useProjectsStore(
    (state) => state.workspaceReferenceRepoStatus,
  );
  const toggleCollapsed = useProjectsStore((state) => state.toggleCollapsed);
  const createWorktree = useProjectsStore((state) => state.createWorktree);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);
  const reorderWorktrees = useProjectsStore((state) => state.reorderWorktrees);
  const setWorktreePinned = useProjectsStore(
    (state) => state.setWorktreePinned,
  );
  const setWorkspacePinned = useProjectsStore(
    (state) => state.setWorkspacePinned,
  );
  const setWorkspaceItemSortMode = useProjectsStore(
    (state) => state.setWorkspaceItemSortMode,
  );
  const projectSortMode = useSidebarStore((state) => state.projectSortMode);
  const setProjectSortMode = useSidebarStore(
    (state) => state.setProjectSortMode,
  );
  const sidebarEntriesByProject = useStandaloneChatStore(
    (state) => state.sidebarEntriesByProject,
  );
  // The ACTIVE cowork project's entries live in `workEntries`, not in the
  // lazily loaded map (see `getSidebarProjectEntries`), so recency has to read
  // both or the workspace the user is chatting in never floats up.
  const activeChatProjectId = useStandaloneChatStore(
    (state) => state.activeChatProjectId,
  );
  const activeChatWorkEntries = useStandaloneChatStore(
    (state) => state.workEntries,
  );
  // Cowork chat hydration belongs to the sidebar MODEL, not to one of the two
  // components that render it. The rail shows on every page, including before
  // the chat page's own `initialize()` has ever run, so without this the
  // active cowork project's Work Entries are simply absent — and the Chats
  // section renders an empty body under a live header.
  //
  // It lived in `SidebarWorkspacesSection` until the shared surface started
  // rendering the same rows, at which point the flag path mounted the rows
  // without the effects that feed them.
  const chatProjectsLoaded = useStandaloneChatStore(
    (state) => state.chatProjectsLoaded,
  );
  const loadChatProjects = useStandaloneChatStore(
    (state) => state.loadChatProjects,
  );
  useEffect(() => {
    return window.api?.onWorkspacePrivateMemoryChanged?.(() => {
      void refreshPrivateMemoryRows().catch(() => {
        // A later sidebar load can retry a transient projection failure.
      });
    });
  }, []);
  const chatInitialized = useStandaloneChatStore((state) => state.initialized);
  const refreshWorkEntries = useStandaloneChatStore(
    (state) => state.refreshWorkEntries,
  );
  useEffect(() => {
    if (chatProjectsLoaded) return;
    void loadChatProjects().catch(() => {
      // Non-fatal: the chat page's initialize will retry.
    });
  }, [chatProjectsLoaded, loadChatProjects]);
  useEffect(() => {
    if (!chatProjectsLoaded || chatInitialized) return;
    void refreshWorkEntries(activeChatProjectId).catch(() => {
      // Non-fatal: the chat page's initialize will retry.
    });
  }, [
    activeChatProjectId,
    chatProjectsLoaded,
    chatInitialized,
    refreshWorkEntries,
  ]);

  const addRepoToWorktree = useProjectsStore(
    (state) => state.addRepoToWorktree,
  );
  const removeRepoFromWorktree = useProjectsStore(
    (state) => state.removeRepoFromWorktree,
  );
  const setWorktreeHidden = useProjectsStore(
    (state) => state.setWorktreeHidden,
  );
  const setWorktreeBranchGroupingOverride = useProjectsStore(
    (state) => state.setWorktreeBranchGroupingOverride,
  );
  const recentlyAddedProjectIds = useProjectsStore(
    (state) => state.recentlyAddedProjectIds,
  );

  const branchGroupingEnabled = useBranchGroupingPreferenceStore(
    (state) => state.enabled,
  );

  const openWorkspaceSettings = useNavigationStore(
    (state) => state.openWorkspaceSettings,
  );
  const navigate = useNavigationStore((state) => state.navigate);
  const requestDispatchPipeline = useNavigationStore(
    (state) => state.requestDispatchPipeline,
  );
  const requestAddRepoAdhoc = useNavigationStore(
    (state) => state.requestAddRepoAdhoc,
  );
  const requestSplitWorkspace = useNavigationStore(
    (state) => state.requestSplitWorkspace,
  );
  const requestDriftDetails = useNavigationStore(
    (state) => state.requestDriftDetails,
  );
  const requestArchiveWorktree = useNavigationStore(
    (state) => state.requestArchiveWorktree,
  );
  const activePage = useNavigationStore((state) => state.activePage);

  const selectedWorktree = useChatStore((state) => state.selectedWorktree);
  const selectWorktree = useChatStore((state) => state.selectWorktree);
  const deselectWorktree = useChatStore((state) => state.deselectWorktree);
  const unreadWorktreeKeys = useChatSidebarStore(
    (state) => state.unreadWorktreeKeys,
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

  // Active runs only, without their output: a script printing must not
  // re-render every sidebar consumer of this model.
  const activeScriptRuns = useScriptsStore(
    useShallow((state) => indexActiveScriptRuns(state.runs)),
  );
  const trackedPlans = useActivityStore((state) => state.trackedPlans);

  const selectedWorktreeKey = selectedWorktree
    ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
    : null;
  const visibleSelectedWorktreeKey =
    activePage === 'main' ? selectedWorktreeKey : null;

  // Derive streaming/active/awaiting key strings as sorted primitives so the
  // selector only produces new values on real membership changes (not on every
  // streaming token). Shared with WorktreeManager so the two sidebar hosts
  // cannot drift. Chats with live managed delegates count as streaming and
  // active, so their rows show working with Archive and Delete disabled.
  const badgeKeys = useChatBadgeKeys();

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

  const setupRunningWorktrees = useMemo(() => {
    const keys = worktreesWithActiveRun(activeScriptRuns, 'setup');
    tearingDownWorktrees.forEach((worktreeKey) => keys.delete(worktreeKey));
    return keys;
  }, [activeScriptRuns, tearingDownWorktrees]);

  const runRunningWorktrees = useMemo(
    () => worktreesWithActiveRun(activeScriptRuns, 'launch'),
    [activeScriptRuns],
  );

  const scopingContext = useSidebarScopingContext();
  const {
    setupDialog,
    placeholderRows,
    linkedPersonalWorkspaceIds,
    linkedProjectIds,
    linksResolvedOrganizationId,
    startPlaceholderSetup,
    cancelPlaceholderSetup,
  } = useSidebarOrgProjectPlaceholders(projects, scopingContext);
  // Share the linked-checkout ids so Automations and the command palette
  // scope with the sidebar's rule (CAN-3448), and the projects they link so
  // the Add project dialog reads them as on this computer (CAN-3469).
  useEffect(() => {
    useLinkedPersonalWorkspacesStore
      .getState()
      .setIds(
        linkedPersonalWorkspaceIds,
        scopingContext?.kind === 'organization'
          ? scopingContext.organizationId
          : null,
      );
  }, [linkedPersonalWorkspaceIds, scopingContext]);
  useEffect(() => {
    useLinkedPersonalWorkspacesStore
      .getState()
      .setProjectIds(linkedProjectIds, linksResolvedOrganizationId);
  }, [linkedProjectIds, linksResolvedOrganizationId]);
  /**
   * Main projects a persisted cowork workspace watermark. Overlay it with
   * whatever fresher Work Entry metadata the renderer has already loaded so
   * current activity can move the workspace before the next project reload.
   */
  const coworkRecencyOverrides = useMemo((): ReadonlyMap<string, number> => {
    const overrides = new Map<string, number>();
    const record = (
      workspaceId: string,
      entries: readonly CoworkWorkEntryMeta[],
    ): void => {
      let latest: number | undefined;
      for (const entry of entries) {
        const recency = workEntryRecencyMs(entry);
        if (
          recency !== undefined &&
          (latest === undefined || recency > latest)
        ) {
          latest = recency;
        }
      }
      if (latest !== undefined) {
        overrides.set(workspaceId, latest);
      }
    };
    for (const [workspaceId, entries] of Object.entries(
      sidebarEntriesByProject,
    )) {
      record(workspaceId, entries);
    }
    // Recorded last so the live list wins over any stale map copy.
    record(activeChatProjectId, activeChatWorkEntries);
    return overrides;
  }, [sidebarEntriesByProject, activeChatProjectId, activeChatWorkEntries]);

  const { sortedProjects, visibleProjects, hiddenProjects } = useMemo(
    () =>
      partitionSidebarWorkspaces(
        projects,
        hiddenWorkspaceIds,
        {
          sortMode: projectSortMode,
          recencyOverrides: coworkRecencyOverrides,
        },
        scopingContext,
        linkedPersonalWorkspaceIds,
      ),
    [
      projects,
      hiddenWorkspaceIds,
      projectSortMode,
      coworkRecencyOverrides,
      scopingContext,
      linkedPersonalWorkspaceIds,
    ],
  );

  const filterWorkspaceOptions = useMemo(
    () => buildSidebarWorkspaceFilterOptions(sortedProjects),
    [sortedProjects],
  );

  // Rows count background work that started before this renderer subscribed.
  useLiveTaskSnapshots(
    visibleProjects.flatMap((project) =>
      project.type === 'cowork'
        ? []
        : project.worktrees.map((worktree) => ({
            projectId: project.id,
            worktreeId: worktree.id,
          })),
    ),
  );

  const worktreeStatusMap = useMemo(
    () =>
      buildWorktreeStatusMap([...visibleProjects, ...hiddenProjects], {
        unreadWorktreeKeys,
        unseenPipelineWorktreeKeys,
        unseenFailedPipelineWorktreeKeys,
        streamingWorktreeKeys,
        pipelineRunningWorktreeKeys,
        awaitingApprovalKeys,
        pipelinePausedWorktreeKeys,
      }),
    [
      visibleProjects,
      hiddenProjects,
      unreadWorktreeKeys,
      unseenPipelineWorktreeKeys,
      unseenFailedPipelineWorktreeKeys,
      streamingWorktreeKeys,
      pipelineRunningWorktreeKeys,
      awaitingApprovalKeys,
      pipelinePausedWorktreeKeys,
    ],
  );

  const onSelectWorktree = useCallback(
    (projectId: string, worktreeId: string): void => {
      // Explicit user navigation to a live worktree dismisses the page-like
      // archived viewer (programmatic activations must not, so this lives on
      // the click handler rather than the selectWorktree funnel).
      dismissPageLikeViewers();
      // A row click is an implicit entry, so it opens on the tab that needs
      // the user rather than the one last read.
      selectWorktree(projectId, worktreeId, { attentionLanding: true });
    },
    [selectWorktree],
  );

  const onToggleCollapsed = useCallback(
    (projectId: string): void => {
      void toggleCollapsed(projectId);
    },
    [toggleCollapsed],
  );

  const onCreateWorktree = useCallback(
    (
      projectId: string,
      options?: Pick<CreateWorktreeOptions, 'worktreeId' | 'onRegistered'>,
    ): ReturnType<typeof createWorktree> => {
      // Reveal the Code surface at local registration, when the row has been
      // inserted and selected. The returned promise also waits for persistence
      // and post-create refreshes, which must not delay the active UI.
      return createWorktree(projectId, {
        ...(options?.worktreeId === undefined
          ? {}
          : { worktreeId: options.worktreeId }),
        onRegistered: (worktree) => {
          navigate('main');
          options?.onRegistered?.(worktree);
        },
      });
    },
    [createWorktree, navigate],
  );

  const onCreateBranchWorktree = useCallback(
    (projectId: string, worktreeId: string): void => {
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
            const finishPendingFork = beginPendingWorktreeTabFork(
              projectId,
              created.id,
            );
            navigate('main');
            // Registration is the earliest usable milestone. Start the handoff
            // here instead of waiting for post-create diff/drift refreshes.
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
                // Worktree creation already committed; keep it usable even if
                // the tab handoff fails instead of risking a duplicate retry.
                reportRendererConsoleError(
                  'Failed to carry open tabs to branched worktree',
                  { error },
                );
              } finally {
                finishPendingFork();
                useChatStore.getState().selectWorktree(projectId, created.id);
              }
            })();
          },
        });
      })();
    },
    [createWorktree, navigate],
  );

  const onSetProjectSortMode = useCallback(
    (mode: SidebarSortMode): void => {
      void setProjectSortMode(mode).catch(() => {
        useGitHubStore.getState().addToast('Failed to change order', 'error');
      });
    },
    [setProjectSortMode],
  );

  const onToggleWorkspacePinned = useCallback(
    (workspaceId: string, pinned: boolean): void => {
      void setWorkspacePinned(workspaceId, pinned);
    },
    [setWorkspacePinned],
  );

  const onSetWorkspaceItemSortMode = useCallback(
    (workspaceId: string, mode: SidebarSortMode): void => {
      void setWorkspaceItemSortMode(workspaceId, mode);
    },
    [setWorkspaceItemSortMode],
  );

  const onToggleWorktreePinned = useCallback(
    (projectId: string, worktreeId: string, pinned: boolean): void => {
      void setWorktreePinned(projectId, worktreeId, pinned);
    },
    [setWorktreePinned],
  );

  const onReorderProjects = useCallback(
    (activeId: string, overId: string): void => {
      void reorderProjects(activeId, overId);
    },
    [reorderProjects],
  );

  const onReorderWorktrees = useCallback(
    (
      projectId: string,
      activeWorktreeId: string,
      overWorktreeId: string,
    ): void => {
      void reorderWorktrees(projectId, activeWorktreeId, overWorktreeId);
    },
    [reorderWorktrees],
  );

  const onSetBranchGroupingOverride = useCallback(
    (
      projectId: string,
      worktreeId: string,
      override: 'group' | 'ungroup' | null,
    ): Promise<void> =>
      setWorktreeBranchGroupingOverride(projectId, worktreeId, override),
    [setWorktreeBranchGroupingOverride],
  );

  // Routes through the shared navigation-store request seam instead of
  // archiving directly. `WorktreeManager` (always mounted) consumes the
  // request and runs its own `requestArchiveWorktree`, which surfaces the
  // richer retry/without-teardown `TeardownFailureDialog` on teardown failure
  // instead of a toast-only fallback.
  const onArchiveWorktree = useCallback(
    (
      projectId: string,
      worktreeId: string,
      options?: ArchiveWorktreeOptions,
    ): void => {
      requestArchiveWorktree({
        projectId,
        worktreeId,
        deleteBranch: options?.deleteBranch,
        expectedBranchName: options?.expectedBranchName,
        lockAfterArchive: options?.lockAfterArchive,
        deleteWithoutRetentionIfMissing:
          options?.deleteWithoutRetentionIfMissing,
      });
    },
    [requestArchiveWorktree],
  );

  const onOpenSettings = useCallback(
    (workspaceId: string): void => {
      openWorkspaceSettings({ workspaceId });
    },
    [openWorkspaceSettings],
  );

  const onAddRepoToWorktree = useCallback(
    (
      workspaceId: string,
      worktreeId: string,
      repoId: string,
    ): void | Promise<void> =>
      addRepoToWorktree(workspaceId, worktreeId, repoId),
    [addRepoToWorktree],
  );

  const onRemoveRepoFromWorktree = useCallback(
    (
      workspaceId: string,
      worktreeId: string,
      repoId: string,
    ): void | Promise<void> =>
      removeRepoFromWorktree(workspaceId, worktreeId, repoId),
    [removeRepoFromWorktree],
  );

  const onSetWorktreeHidden = useCallback(
    (projectId: string, worktreeId: string, nextHidden: boolean): void => {
      void setWorktreeHidden(projectId, worktreeId, nextHidden);
    },
    [setWorktreeHidden],
  );

  const onFilterChange = useCallback(
    (next: string[]): void => {
      setHiddenWorkspaceIds(next);
      const current = useChatStore.getState().selectedWorktree;
      if (current && next.includes(current.projectId)) {
        deselectWorktree();
      }
    },
    [setHiddenWorkspaceIds, deselectWorktree],
  );

  // Row action-menu entries that open a `WorktreeManager`-hosted modal. Each
  // sets the matching navigation-store request flag WorktreeManager consumes.
  // Mirrors the Create Task request pattern.
  const onDispatchPipeline = useCallback(
    (projectId: string, worktreeId: string): void => {
      requestDispatchPipeline({ projectId, worktreeId });
    },
    [requestDispatchPipeline],
  );

  const onAddRepoToWorktreeAdhoc = useCallback(
    (projectId: string, worktreeId: string): void => {
      requestAddRepoAdhoc({ projectId, worktreeId });
    },
    [requestAddRepoAdhoc],
  );

  const onSplitTemporaryWorkspace = useCallback(
    (projectId: string, worktreeId: string): void => {
      requestSplitWorkspace({ projectId, worktreeId });
    },
    [requestSplitWorkspace],
  );

  const onOpenDriftDetails = useCallback(
    (projectId: string, worktreeId: string): void => {
      requestDriftDetails({ projectId, worktreeId });
    },
    [requestDriftDetails],
  );

  return {
    setupDialog,
    placeholderRows,
    linkedPersonalWorkspaceIds,
    startPlaceholderSetup,
    cancelPlaceholderSetup,
    scopingContext,
    sortedProjects,
    visibleProjects,
    hiddenProjects,
    projectSortMode,
    onSetProjectSortMode,
    onToggleWorkspacePinned,
    onSetWorkspaceItemSortMode,
    onToggleWorktreePinned,
    filterWorkspaceOptions,
    hiddenWorkspaceIds,
    isLoading,
    recentlyAddedProjectIds,
    worktreeStatusMap,
    diffStats,
    uncommittedChanges,
    commitsAhead,
    hasUnpushedCommits,
    baseBranches,
    defaultBranches,
    branchGroupingEnabled,
    hasRemoteTracking,
    hasBranchBeenPushed,
    repoBranches,
    workspaceDrift,
    discoveryLoading,
    selectedWorktreeKey: visibleSelectedWorktreeKey,
    streamingWorktreeKeys,
    backgroundTaskCounts,
    activeSessionWorktreeKeys,
    awaitingApprovalKeys,
    pendingQuestionWorktreeKeys,
    toolApprovalWorktreeKeys,
    unreadWorktreeKeys,
    setupRunningWorktrees,
    runRunningWorktrees,
    tearingDownWorktrees,
    archivingWorktrees,
    pipelineRunningWorktreeKeys,
    unseenPipelineWorktreeKeys,
    unseenFailedPipelineWorktreeKeys,
    pipelinePausedWorktreeKeys,
    baseBranchExistsLocally,
    baseBranchExistsInRemote,
    creatingWorktreeForProject,
    workspaceReferenceRepoStatus,
    onSelectWorktree,
    onToggleCollapsed,
    onCreateWorktree,
    onCreateBranchWorktree,
    onReorderProjects,
    onReorderWorktrees,
    onSetBranchGroupingOverride,
    onArchiveWorktree,
    onAddRepoToWorktree,
    onRemoveRepoFromWorktree,
    onSetWorktreeHidden,
    onOpenSettings,
    onFilterChange,
    onDispatchPipeline,
    onAddRepoToWorktreeAdhoc,
    onSplitTemporaryWorkspace,
    onOpenDriftDetails,
  };
}
