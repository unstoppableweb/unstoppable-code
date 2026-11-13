import { Dot } from '@canopy/ui-shared/components/Badge';
import {
  OrgProjectPlaceholderRow,
  OrgProjectPlaceholderSection,
} from '../worktree/OrgProjectPlaceholderRow';
import { WORKSPACE_LABEL_PLURAL } from '@canopy/protocol/ui-labels';
import {
  memo,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  type SortingStrategy,
} from '@dnd-kit/sortable';
import {
  ChevronDownMediumIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PlusMediumIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SidebarList,
  SidebarRailSkeleton,
  SidebarSection,
  useProjectListPagination,
} from '@canopy/ui-app';
import {
  DelayedLoadingPlaceholder,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  FloatingMenu,
  ProjectListPagination,
  RailIconButton,
  SidebarFadePresence,
  SidebarSectionToggle,
  WorkspaceSectionHeader,
} from '@canopy/ui-shared/components';
import {
  defaultCoworkWorkspaceIdForContext,
  isDefaultCoworkWorkspaceId,
  type CoworkSidebarItem,
  type MultiRepoSidebarItem,
  type SidebarItem,
  type SingleRepoSidebarItem,
  type WorktreeDiffStatsStyle,
} from '@canopy/desktop-shared/types';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { SidebarContextEmptyState } from './SidebarContextEmptyState';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { ProjectSection } from '../worktree/ProjectSection';
import { canDragSidebarRow } from '@/lib/sidebar-ordering';
import { SidebarSortMenuItems } from './SidebarSortMenuItems';
import { ProjectIcon } from '../shared/ProjectIcon';
import { SidebarProjectVisibilityMenuItems } from './SidebarProjectVisibilityMenuItems';
import { useSidebarWorkspaces } from './useSidebarWorkspaces';
import { hasMultipleWorkspaces } from '@/lib/workspaceChoice';
import { usePendingWorktreeScroll } from './usePendingWorktreeScroll';
import { SidebarCoworkWorkspaceRow } from './SidebarCoworkWorkspaceRow';
import { SidebarChatsSection } from './SidebarChatsSection';
import { SharedContainerSidebarSection } from '../shared-containers/SharedContainerSidebarSection';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { openImportSessionModal } from '@/stores/importSessionModalStore';
import { openNewCoworkTaskFromSidebar } from '@/lib/openNewCoworkTaskFromSidebar';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';

/** `ProjectSection` re-rendered frequently in the list; memoized for perf. */
const SidebarProjectSection = memo(ProjectSection);
const staticListSortingStrategy: SortingStrategy = () => null;

interface WorkspaceDropIndicator {
  workspaceId: string;
  position: 'before' | 'after';
}

/**
 * The acting-header actions for the one visible project, which borrows the
 * section header because its own row header is hidden. Its overflow entries
 * live in the section's single header menu rather than a second "…" beside
 * it, so the header never shows the same glyph twice.
 */
function SoleWorkspaceActions({
  workspace,
  onCreate,
  onOpenSettings,
}: {
  readonly workspace: SidebarItem;
  readonly onCreate: () => void;
  readonly onOpenSettings: () => void;
}): JSX.Element {
  const createDisabled =
    workspace.type === 'multi-repo' && workspace.repos.length === 0;
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/sidebar-item:opacity-100 group-hover/sidebar-item:pointer-events-auto group-focus-within/sidebar-item:opacity-100 group-focus-within/sidebar-item:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:pointer-events-auto"
      data-testid={`sidebar-sole-workspace-actions-${workspace.id}`}
    >
      <RailIconButton
        icon={SettingsIcon}
        onClick={onOpenSettings}
        aria-label={`Project settings for ${workspace.name}`}
        data-testid={`sidebar-sole-workspace-settings-${workspace.id}`}
        hoverSurface
      />
      <RailIconButton
        icon={PlusMediumIcon}
        onClick={onCreate}
        disabled={createDisabled}
        aria-label={`New task in ${workspace.name}`}
        title={createDisabled ? 'Add repos first' : 'New task'}
        data-testid={`sidebar-sole-workspace-new-task-${workspace.id}`}
        hoverSurface
      />
    </div>
  );
}

/** Narrows a mixed sidebar item to the git-backed variants `ProjectSection` renders. */
function isGitSidebarItem(
  item: SidebarItem,
): item is SingleRepoSidebarItem | MultiRepoSidebarItem {
  return item.type !== 'cowork';
}

function WorkspaceDragOverlay({
  project,
}: {
  readonly project: SidebarItem;
}): JSX.Element {
  const isMultiRepo = project.type === 'multi-repo';
  const worktreeCount =
    project.type === 'cowork' ? 0 : project.worktrees.length;
  const hideCount = useLabsExperimentEnabled('sidebar');

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none flex h-8 w-full translate-x-1 cursor-default touch-none select-none rounded-row bg-popover shadow-lg"
      data-sidebar-workspace-drag-overlay-id={project.id}
      data-testid="workspace-drag-overlay"
    >
      <WorkspaceSectionHeader
        name={getWorkspaceDisplayName(project)}
        colorHex={project.color}
        workspaceType={isMultiRepo ? 'multi-repo' : 'single-repo'}
        temporary={isMultiRepo && project.temporary === true}
        worktreeCount={worktreeCount}
        pinnedToTop={project.pinned === true}
        countPresentation={hideCount ? 'hidden' : undefined}
        textScale="sidebar"
        collapsed={project.collapsed}
        canToggleCollapse={false}
        disableDrag
        showCollapseChevron={false}
        onToggleCollapse={() => undefined}
        dragHandleSlot={
          <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full">
            <ProjectIcon
              kind={
                project.type === 'cowork'
                  ? 'cowork'
                  : isMultiRepo
                    ? 'multi-repo'
                    : 'single-repo'
              }
              temporary={isMultiRepo && project.temporary === true}
              color={project.color}
              repoPath={
                project.type === 'single-repo' ? project.repoPath : undefined
              }
            />
          </span>
        }
      />
    </div>
  );
}

export interface SidebarWorkspacesSectionProps {
  readonly stickyHeaderLead?: ReactNode;
  readonly worktreeDiffStatsStyle?: WorktreeDiffStatsStyle;
}

/**
 * The More control, pinned as its own row at the top of the sticky stack.
 * It is a navigation control rather than part of the Projects header, so it
 * sits above the Chats section instead of between Chats and Projects.
 */
export function MoreStickyLead({
  lead,
}: {
  readonly lead?: ReactNode;
}): JSX.Element | null {
  if (lead === undefined) return null;
  return (
    <div
      className="sticky top-px z-40"
      data-sidebar-more-lead=""
      data-testid="sidebar-more-sticky-lead"
    >
      {lead}
    </div>
  );
}

interface StickyWorkspaceControlsProps {
  readonly lead?: ReactNode;
  readonly workspaceHeader?: ReactNode;
  readonly workspaceSlot?: ReactNode;
}

export function StickyWorkspaceControls({
  lead,
  workspaceHeader,
  workspaceSlot,
}: StickyWorkspaceControlsProps): JSX.Element {
  return (
    <div
      className="sidebar-sticky-workspace-controls sticky z-30"
      style={{
        top: 'calc(1px + var(--sidebar-more-height, 0px) + var(--sidebar-chats-header-height, 0px))',
      }}
      data-testid="sidebar-more-sticky-container"
    >
      {lead}
      <div
        aria-hidden="true"
        className="h-3"
        data-testid="sidebar-more-workspaces-gap"
      />
      {workspaceHeader}
      {workspaceHeader !== undefined && (
        <>
          {/* Pinned copies of the SELECTED worktree / work entry and its
              project header. The selected project's section portals its
              copies into these hosts; AppSidebar's scroll sync reveals the
              group while the selected row would otherwise scroll out above,
              seating it where the project slot normally sits (the slot then
              shifts below the pinned pair via the pin-height var). */}
          <div
            aria-hidden="true"
            className="sidebar-selected-pin-top pointer-events-none z-20"
            data-sidebar-selected-pin-top=""
            data-testid="sidebar-selected-pin-top"
            hidden
          >
            <div
              className="pointer-events-auto"
              data-sidebar-selected-pin-part="header"
            />
            <div
              className="pointer-events-auto"
              data-sidebar-selected-pin-part="group-header"
            />
            <div
              className="pointer-events-auto"
              data-sidebar-selected-pin-part="row"
            />
          </div>
          {/* The slot is a stable child of the sticky controls group. Real
              project rows stay in document flow and portal only their
              interactive header chrome into these hidden hosts. */}
          <div
            aria-hidden="true"
            className="sidebar-sticky-workspace-slot pointer-events-none z-10"
            data-sidebar-sticky-workspace-slot=""
            data-testid="sidebar-sticky-workspace-slot"
            hidden
          >
            {workspaceSlot}
          </div>
        </>
      )}
    </div>
  );
}

export function SidebarWorkspacesSection({
  stickyHeaderLead,
  worktreeDiffStatsStyle = 'short',
}: SidebarWorkspacesSectionProps = {}): JSX.Element {
  const collapsed = useSidebarStore((s) => s.codeSectionCollapsed);
  const setCollapsed = useSidebarStore((s) => s.setCodeSectionCollapsed);
  const activePage = useNavigationStore((s) => s.activePage);
  const homeWorkspaceId = useHomeComposerStore((s) => s.workspaceId);
  const navigate = useNavigationStore((s) => s.navigate);
  const openAddWorkspaceModal = useNavigationStore(
    (s) => s.openAddWorkspaceModal,
  );

  const model = useSidebarWorkspaces();
  const activeChatProjectId = useStandaloneChatStore(
    (state) => state.activeChatProjectId,
  );
  const archivedProjectId = useArchivedContainersStore(
    (state) => state.viewer?.workspaceId ?? state.overview?.workspaceId,
  );
  const scopingContext = model.scopingContext;
  const organizationName = useWorkspaceContextStore((store) =>
    scopingContext?.kind === 'organization'
      ? store.state.organizations.find(
          (organization) => organization.id === scopingContext.organizationId,
        )?.name
      : undefined,
  );
  // The auto-created default Cowork workspace is the catch-all for
  // project-less chats. It never renders as a workspace row: its Work Entries
  // list flat under a dedicated top-level "Chats" section pinned below every
  // project (ChatGPT's Projects / Recents shape, named "Chats" because it is
  // the catch-all bucket rather than a recency view). Named cowork workspaces
  // stay in the Projects list like any other user-made container.
  // Resolved from the FULL sorted list, not the visible partition: the
  // workspace filter and the Hidden group must never be able to take the
  // Chats section away, and a persisted hidden id for it is ignored. Each
  // scoping context has its own catch-all (an organization's in org scope).
  const defaultCoworkId = defaultCoworkWorkspaceIdForContext(scopingContext);
  const defaultCoworkProject: CoworkSidebarItem | null =
    model.sortedProjects.find(
      (project): project is CoworkSidebarItem =>
        project.type === 'cowork' && project.id === defaultCoworkId,
    ) ?? null;
  const listedProjects =
    defaultCoworkProject === null
      ? model.visibleProjects
      : model.visibleProjects.filter(
          (project) => project.id !== defaultCoworkProject.id,
        );
  const hiddenListedProjects =
    defaultCoworkProject === null
      ? model.hiddenProjects
      : model.hiddenProjects.filter(
          (project) => project.id !== defaultCoworkProject.id,
        );
  const filterWorkspaceOptions =
    defaultCoworkProject === null
      ? model.filterWorkspaceOptions
      : model.filterWorkspaceOptions.filter(
          (option) => option.id !== defaultCoworkProject.id,
        );
  // Any project hidden from the section keeps the header menu (and its dot)
  // visible, since nothing else in the sidebar reports the filter.
  const projectsFiltered = filterWorkspaceOptions.some((option) =>
    model.hiddenWorkspaceIds.includes(option.id),
  );
  // The sole-workspace rule counts what is actually rendered, which includes
  // the default cowork workspace even though it lives in the Chats section: a
  // user with one project plus their chats has two things in the sidebar, so
  // the project keeps its own header exactly as it did before this section
  // existed (CAN-2672). Derived from the rendered lists rather than
  // `visibleProjects` so a stale hidden id for the default workspace — which
  // the Chats section deliberately ignores — cannot drop the count.
  const renderedProjects =
    defaultCoworkProject === null
      ? listedProjects
      : [...listedProjects, defaultCoworkProject];
  const showWorkspaceHeaders =
    hasMultipleWorkspaces(renderedProjects) || model.placeholderRows.length > 0;
  const soleVisibleWorkspace =
    !showWorkspaceHeaders && listedProjects.length === 1
      ? listedProjects[0]
      : null;

  const pendingScrollToWorktree = useProjectsStore(
    (state) => state.pendingScrollToWorktree,
  );
  const clearPendingScrollToWorktree = useProjectsStore(
    (state) => state.clearPendingScrollToWorktree,
  );

  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  // CAN-1074: Projects-section ordering control.
  const [projectsMenuOpen, setProjectsMenuOpen] = useState(false);
  const projectsMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [workspaceDropIndicator, setWorkspaceDropIndicator] =
    useState<WorkspaceDropIndicator | null>(null);
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [sharedWithMeExpanded, setSharedWithMeExpanded] = useState(true);

  // The onboarding sidebar tour's "Chat" stop (`sidebar-chat` anchor) must
  // resolve to exactly one element: the default Cowork workspace rendered in
  // the Chats section, falling back to the first listed cowork row.
  const firstCoworkProjectId =
    defaultCoworkProject?.id ??
    listedProjects.find((project) => !isGitSidebarItem(project))?.id ??
    null;

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const handleOpenAddWorkspaceModal = (): void => {
    openAddWorkspaceModal();
  };

  // An organization with no project rows: its default Chats is not a project.
  const showsContextEmptyState =
    scopingContext?.kind === 'organization' &&
    model.placeholderRows.length === 0 &&
    model.sortedProjects.every((project): boolean =>
      isDefaultCoworkWorkspaceId(project.id),
    );

  // The compact sidebar style (early access): the project list disclosure
  // reads More / Less with no count, and rows show status in a leading dot.
  const compactSidebar = useLabsExperimentEnabled('sidebar');
  const projectPage = useProjectListPagination(
    listedProjects,
    (project) => project.id,
    [
      model.selectedWorktreeKey?.split('/')[0],
      activePage === 'chat' ? activeChatProjectId : null,
      activePage === 'home' ? homeWorkspaceId : null,
      archivedProjectId,
      pendingScrollToWorktree?.projectId,
      ...Array.from(model.recentlyAddedProjectIds),
    ],
    scopingContext?.kind === 'organization'
      ? scopingContext.organizationId
      : 'personal',
  );

  // Cowork chat hydration now lives in `useSidebarWorkspaces`, so the shared
  // surface gets it too — this section is no longer the only renderer of
  // cowork rows.

  // Scroll a newly-created (or otherwise targeted) worktree row into view.
  // `WorktreeManager`'s own consumer only scrolls the kanban board (its scroll
  // ref is attached inside the kanban section, which only mounts on the
  // kanban page), so the sidebar is the only consumer on every other page.
  // Disable while the kanban page is active so the two consumers never race for
  // the same pending signal — first-consumer-clears is otherwise ambiguous
  // since both the sidebar and the kanban board can render a matching row.
  usePendingWorktreeScroll({
    enabled: activePage !== 'kanban',
    containerRef: scrollContainerRef,
    pending: pendingScrollToWorktree,
    clearPending: clearPendingScrollToWorktree,
    stillExists: (projectId, worktreeId) => {
      if (
        model.sortedProjects.some(
          (project) =>
            project.id === projectId &&
            project.type !== 'cowork' &&
            project.worktrees.some((wt) => wt.id === worktreeId),
        )
      ) {
        return true;
      }
      // Archived-container rows share the pending-scroll pipeline (their
      // ids occupy the worktreeId slot). While the target workspace's
      // summaries are still loading the id cannot be confirmed — keep
      // polling; the hook's frame budget bounds the wait either way.
      const archivedState = useArchivedContainersStore.getState();
      return (
        archivedState.byWorkspace[projectId]?.some(
          (entry) => entry.id === worktreeId,
        ) === true ||
        (archivedState.viewer?.workspaceId === projectId &&
          archivedState.viewer.containerId === worktreeId &&
          archivedState.loadedWorkspaces[projectId] !== true)
      );
    },
  });

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || model.recentlyAddedProjectIds.size === 0) {
      return;
    }

    const coworkProject = model.visibleProjects.find(
      (project) =>
        project.type === 'cowork' &&
        model.recentlyAddedProjectIds.has(project.id),
    );
    if (!coworkProject) {
      return;
    }

    const target = container.querySelector<HTMLElement>(
      `[data-testid="${CSS.escape(`sidebar-cowork-project-${coworkProject.id}`)}"]`,
    );
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [model.recentlyAddedProjectIds, model.visibleProjects]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleProjectDragStart = (event: DragStartEvent): void => {
    setWorkspaceDropIndicator(null);
    setActiveProjectId(String(event.active.id));
  };

  const handleProjectDragOver = (event: DragOverEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      setWorkspaceDropIndicator(null);
      return;
    }

    const activeId = String(active.id);
    const overId = String(over.id);
    const workspaceOrder = listedProjects.map((project) => project.id);
    const activeIndex = workspaceOrder.indexOf(activeId);
    const overIndex = workspaceOrder.indexOf(overId);
    if (activeIndex < 0 || overIndex < 0) {
      setWorkspaceDropIndicator(null);
      return;
    }

    const nextIndicator: WorkspaceDropIndicator = {
      workspaceId: overId,
      position: activeIndex < overIndex ? 'after' : 'before',
    };
    setWorkspaceDropIndicator((current) =>
      current?.workspaceId === nextIndicator.workspaceId &&
      current.position === nextIndicator.position
        ? current
        : nextIndicator,
    );
  };

  const handleProjectDragEnd = (event: DragEndEvent): void => {
    setActiveProjectId(null);
    setWorkspaceDropIndicator(null);
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    model.onReorderProjects(String(active.id), String(over.id));
  };

  const activeProject = activeProjectId
    ? model.sortedProjects.find((project) => project.id === activeProjectId)
    : undefined;

  // Worktree click: select, then navigate to the worktree page whenever the
  // user is elsewhere (overview, pipelines, kanban, …) so the selection is
  // actually visible. MainPage is always mounted, so navigation is instant.
  const handleSelectWorktree = (
    projectId: string,
    worktreeId: string,
  ): void => {
    model.onSelectWorktree(projectId, worktreeId);
    if (activePage !== 'main') {
      navigate('main');
    }
  };

  const commonSectionProps = {
    worktreeDiffStatsStyle,
    diffStats: model.diffStats,
    uncommittedChanges: model.uncommittedChanges,
    commitsAhead: model.commitsAhead,
    hasUnpushedCommits: model.hasUnpushedCommits,
    baseBranches: model.baseBranches,
    defaultBranches: model.defaultBranches,
    branchGroupingEnabled: model.branchGroupingEnabled,
    onSetBranchGroupingOverride: model.onSetBranchGroupingOverride,
    hasRemoteTracking: model.hasRemoteTracking,
    hasBranchBeenPushed: model.hasBranchBeenPushed,
    repoBranches: model.repoBranches,
    workspaceDrift: model.workspaceDrift,
    discoveryLoading: model.discoveryLoading,
    selectedWorktreeKey: model.selectedWorktreeKey,
    streamingWorktreeKeys: model.streamingWorktreeKeys,
    backgroundTaskCounts: model.backgroundTaskCounts,
    activeSessionWorktreeKeys: model.activeSessionWorktreeKeys,
    awaitingApprovalKeys: model.awaitingApprovalKeys,
    pendingQuestionWorktreeKeys: model.pendingQuestionWorktreeKeys,
    toolApprovalWorktreeKeys: model.toolApprovalWorktreeKeys,
    unreadWorktreeKeys: model.unreadWorktreeKeys,
    onSelectWorktree: handleSelectWorktree,
    onToggleCollapsed: model.onToggleCollapsed,
    onCreateWorktree: model.onCreateWorktree,
    onArchiveWorktree: model.onArchiveWorktree,
    setupRunningWorktrees: model.setupRunningWorktrees,
    runRunningWorktrees: model.runRunningWorktrees,
    tearingDownWorktrees: model.tearingDownWorktrees,
    archivingWorktrees: model.archivingWorktrees,
    pipelineRunningWorktreeKeys: model.pipelineRunningWorktreeKeys,
    pipelineUnseenWorktreeKeys: model.unseenPipelineWorktreeKeys,
    pipelineUnseenFailedWorktreeKeys: model.unseenFailedPipelineWorktreeKeys,
    pipelinePausedWorktreeKeys: model.pipelinePausedWorktreeKeys,
    worktreeStatusMap: model.worktreeStatusMap,
    onReorderWorktrees: model.onReorderWorktrees,
    onOpenSettings: model.onOpenSettings,
    onOpenDriftDetails: model.onOpenDriftDetails,
    onDispatchPipeline: model.onDispatchPipeline,
    onAddRepoToWorktreeAdhoc: model.onAddRepoToWorktreeAdhoc,
    onSplitTemporaryWorkspace: model.onSplitTemporaryWorkspace,
    onAddRepoToWorktree: model.onAddRepoToWorktree,
    onRemoveRepoFromWorktree: model.onRemoveRepoFromWorktree,
    onCreateBranchWorktree: model.onCreateBranchWorktree,
    onToggleHiddenWorktree: model.onSetWorktreeHidden,
    baseBranchExistsLocally: model.baseBranchExistsLocally,
    baseBranchExistsInRemote: model.baseBranchExistsInRemote,
  };

  if (model.isLoading) {
    return (
      <div
        className="group/section min-h-px"
        data-testid="sidebar-section-code"
      >
        <MoreStickyLead key="more" lead={stickyHeaderLead} />
        <StickyWorkspaceControls />
        {/* While workspaces load, the measured skeleton of the Chats and
        Projects sections, headers kept as themselves, takes their place. */}
        <DelayedLoadingPlaceholder slowNote="Still loading projects…">
          <SidebarRailSkeleton
            testId="sidebar-section-code-loading"
            rowStatusPlacement={compactSidebar ? 'leading' : 'trailing'}
          />
        </DelayedLoadingPlaceholder>
      </div>
    );
  }

  return (
    <div ref={scrollContainerRef}>
      {model.setupDialog}
      <MoreStickyLead key="more" lead={stickyHeaderLead} />
      {/* Project-less chats sit above the project list, below the sticky
          sentinel so the Projects band's threshold geometry is unchanged.
          Its own scroll mask fades it beneath the sticky chrome. */}
      <SidebarChatsSection />
      {/* One container spans the project rows AND every trailing section so
          the Projects controls (sticky top) and the Chats header (sticky top
          + bottom) share a containing block. A sticky element never leaves
          its containing block, so a Chats header nested inside its own
          section was stranded below the fold whenever the section itself
          was. The Projects DOM contract is preserved: `sidebar-section-code
          > [data-sidebar-section-content]` still resolves to the project
          rows (trailing sections nest their content one level deeper or
          omit that mark), and the sticky-slot host lookup still climbs to
          this element. */}
      <div
        className="group/section flex flex-col"
        data-testid="sidebar-section-code"
        data-collapsed={collapsed || undefined}
      >
        <StickyWorkspaceControls
          workspaceHeader={
            <div className="sidebar-sticky-header group group/workspaces group/sidebar-item flex min-w-0 items-center gap-1 px-1">
              <SidebarSectionToggle
                section="workspaces"
                label={WORKSPACE_LABEL_PLURAL}
                open={!collapsed}
                testId="sidebar-section-code-toggle"
                chevronTestId="sidebar-workspaces-chevron"
                onboardingAnchor="sidebar-workspaces"
                onClick={(): void => setCollapsed(!collapsed)}
              />
              {/* Nudged 2px down with the label, so the "+" sits on its line. */}
              <div className="ml-auto shrink-0 translate-y-0.5">
                <div className="flex shrink-0 items-center gap-0.5">
                  {soleVisibleWorkspace && (
                    <SoleWorkspaceActions
                      workspace={soleVisibleWorkspace}
                      onCreate={(): void => {
                        if (isGitSidebarItem(soleVisibleWorkspace))
                          void model.onCreateWorktree(soleVisibleWorkspace.id);
                        else {
                          // Same path as the cowork row "+".
                          openNewCoworkTaskFromSidebar(soleVisibleWorkspace.id);
                        }
                      }}
                      onOpenSettings={(): void =>
                        model.onOpenSettings(soleVisibleWorkspace.id)
                      }
                    />
                  )}
                  <div className="relative">
                    <RailIconButton
                      ref={projectsMenuButtonRef}
                      icon={MoreHorizontalIcon}
                      aria-label="More actions for Projects"
                      title="More actions"
                      aria-haspopup="menu"
                      aria-expanded={projectsMenuOpen}
                      data-testid="sidebar-section-code-more"
                      // Hidden projects are state the rows themselves cannot
                      // show, so the control that reverses it stays visible
                      // instead of waiting for a hover.
                      data-active={projectsFiltered ? 'true' : undefined}
                      hoverSurface
                      revealOnItemHover={!projectsFiltered}
                      onClick={(): void => setProjectsMenuOpen((open) => !open)}
                    />
                    {projectsFiltered && (
                      <Dot
                        tone="filter"
                        data-testid="sidebar-section-code-more-active-dot"
                        className="pointer-events-none absolute right-0.5 top-0.5"
                      />
                    )}
                  </div>
                  <FloatingMenu
                    open={projectsMenuOpen}
                    onOpenChange={setProjectsMenuOpen}
                    anchorRef={projectsMenuButtonRef}
                    placement="bottom-left"
                    className="w-max min-w-40 max-w-[calc(100vw-1rem)]"
                    aria-label="Projects actions"
                    data-testid="sidebar-section-code-menu"
                    // The visibility checkboxes below are multi-select; the
                    // ordering rows close the menu themselves.
                    closeOnSelect={false}
                  >
                    {soleVisibleWorkspace && (
                      // The sole project borrows this header, so its own
                      // overflow entries belong in this menu instead of a
                      // second "…" beside it.
                      <DropdownMenuItem
                        data-testid="workspace-import-session-menu-item"
                        onClick={(): void => {
                          setProjectsMenuOpen(false);
                          useCloudConnectGateStore
                            .getState()
                            .requestConnect({}, () =>
                              openImportSessionModal(soleVisibleWorkspace.id),
                            );
                        }}
                      >
                        <DropdownMenuItemIcon>
                          <DownloadIcon />
                        </DropdownMenuItemIcon>
                        <span className="truncate">Import session…</span>
                      </DropdownMenuItem>
                    )}
                    <SidebarSortMenuItems
                      mode={model.projectSortMode}
                      testIdPrefix="sidebar-projects-sort"
                      label="Sort projects by"
                      divider={Boolean(soleVisibleWorkspace)}
                      onSelect={(mode): void => {
                        setProjectsMenuOpen(false);
                        model.onSetProjectSortMode(mode);
                      }}
                    />
                    <SidebarProjectVisibilityMenuItems
                      options={filterWorkspaceOptions}
                      hiddenWorkspaceIds={model.hiddenWorkspaceIds}
                      onChange={model.onFilterChange}
                    />
                  </FloatingMenu>
                  <RailIconButton
                    icon={PlusMediumIcon}
                    onClick={handleOpenAddWorkspaceModal}
                    aria-label="Add project"
                    title="Add project"
                    data-testid="sidebar-section-code-add"
                    data-onboarding-anchor="workspace-add"
                    hoverSurface
                    // Stays on screen while the list is empty: it is then
                    // the only way to add a project (CAN-3550).
                    revealOnItemHover={
                      model.hiddenWorkspaceIds.length === 0 &&
                      !showsContextEmptyState
                    }
                  />
                </div>
              </div>
            </div>
          }
          workspaceSlot={listedProjects.map((project) => (
            <div
              key={project.id}
              aria-hidden="true"
              className="pointer-events-auto absolute inset-0"
              data-sidebar-sticky-slot-workspace-id={project.id}
              hidden
            />
          ))}
        />
        <SidebarFadePresence
          open={!collapsed}
          className="sidebar-workspaces-rows-clip pb-1"
          data-sidebar-section-content=""
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleProjectDragStart}
            onDragOver={handleProjectDragOver}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={() => {
              setActiveProjectId(null);
              setWorkspaceDropIndicator(null);
            }}
          >
            <SortableContext
              items={projectPage.projects.map((project) => project.id)}
              strategy={staticListSortingStrategy}
            >
              {showsContextEmptyState ? (
                <SidebarContextEmptyState
                  organizationName={organizationName ?? 'this organization'}
                  organizationId={
                    scopingContext?.kind === 'organization'
                      ? scopingContext.organizationId
                      : undefined
                  }
                />
              ) : (
                <SidebarList>
                  {projectPage.projects.map((project, index) =>
                    isGitSidebarItem(project) ? (
                      <SidebarProjectSection
                        key={project.id}
                        project={project}
                        isRecentlyAdded={model.recentlyAddedProjectIds.has(
                          project.id,
                        )}
                        hasFollowingWorkspace={
                          index < projectPage.projects.length - 1
                        }
                        hideWorkspaceHeader={!showWorkspaceHeaders}
                        isCreatingWorktree={model.creatingWorktreeForProject.has(
                          project.id,
                        )}
                        hasSettingsWarning={
                          project.type === 'multi-repo'
                            ? project.repos.length === 0 ||
                              Boolean(
                                model.workspaceReferenceRepoStatus[project.id]
                                  ?.warnings?.length,
                              )
                            : undefined
                        }
                        workspaceDragActive={activeProjectId === project.id}
                        workspaceDropIndicatorPosition={
                          workspaceDropIndicator?.workspaceId === project.id
                            ? workspaceDropIndicator.position
                            : null
                        }
                        {...commonSectionProps}
                        disableDrag={
                          !canDragSidebarRow(
                            model.projectSortMode,
                            project.pinned === true,
                          )
                        }
                      />
                    ) : (
                      <SidebarCoworkWorkspaceRow
                        key={project.id}
                        item={project}
                        hasFollowingWorkspace={
                          index < projectPage.projects.length - 1
                        }
                        hideWorkspaceHeader={!showWorkspaceHeaders}
                        workspaceDragActive={activeProjectId === project.id}
                        workspaceDropIndicatorPosition={
                          workspaceDropIndicator?.workspaceId === project.id
                            ? workspaceDropIndicator.position
                            : null
                        }
                        disableDrag={
                          !canDragSidebarRow(
                            model.projectSortMode,
                            project.pinned === true,
                          )
                        }
                        isTourAnchor={project.id === firstCoworkProjectId}
                      />
                    ),
                  )}
                </SidebarList>
              )}
            </SortableContext>
            <ProjectListPagination
              remainingCount={projectPage.remainingCount}
              expanded={projectPage.expanded}
              onShowMore={projectPage.showMore}
              onShowLess={projectPage.showLess}
              compactLabels={compactSidebar}
            />
            {createPortal(
              <DragOverlay dropAnimation={null}>
                {activeProject ? (
                  <WorkspaceDragOverlay project={activeProject} />
                ) : null}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
        </SidebarFadePresence>

        {/*
          Outside the Projects collapse boundary on purpose: Shared projects is
          a sibling group with its own heading, not part of the Projects list.
          Collapsing Projects must not take the organization's setup offers with
          it.
        */}
        {model.placeholderRows.length > 0 && (
          <OrgProjectPlaceholderSection>
            {model.placeholderRows.map(
              ({ project, state, progress, unfinished, relationship }) => (
                <OrgProjectPlaceholderRow
                  key={project.id}
                  project={project}
                  state={state}
                  progress={progress}
                  unfinished={unfinished}
                  relationship={relationship}
                  onSetup={model.startPlaceholderSetup}
                  onCancel={model.cancelPlaceholderSetup}
                />
              ),
            )}
          </OrgProjectPlaceholderSection>
        )}

        {hiddenListedProjects.length > 0 && (
          <SidebarSection
            as="div"
            className="group/section mt-3 flex flex-col"
            data-testid="hidden-workspaces-section"
            collapsed={!hiddenExpanded}
            onCollapsedChange={(nextCollapsed): void =>
              setHiddenExpanded(!nextCollapsed)
            }
            headerButtonProps={{ 'data-testid': 'hidden-workspaces-toggle' }}
            headerClassName="group group/hidden-workspaces"
            spacing="inset"
            header={
              <div className="flex h-8 min-w-0 items-center gap-1 px-1 text-s font-normal">
                <span className="min-w-0 truncate fg-quaternary transition-colors group-hover/hidden-workspaces:fg-secondary group-focus-within/hidden-workspaces:fg-secondary">
                  Hidden
                </span>
                <ChevronDownMediumIcon
                  size="sm"
                  data-testid="sidebar-hidden-workspaces-chevron"
                  className={`shrink-0 fg-quaternary transition-[color,opacity] group-hover/hidden-workspaces:fg-secondary group-hover/hidden-workspaces:opacity-100 group-focus-within/hidden-workspaces:fg-secondary group-focus-within/hidden-workspaces:opacity-100 ${
                    hiddenExpanded ? 'opacity-0' : '-rotate-90 opacity-100'
                  }`}
                />
              </div>
            }
          >
            <SidebarList>
              {hiddenListedProjects.map((project, index) =>
                isGitSidebarItem(project) ? (
                  <SidebarProjectSection
                    key={project.id}
                    project={project}
                    disableDrag
                    flattenHiddenWorktrees
                    hasFollowingWorkspace={
                      index < hiddenListedProjects.length - 1
                    }
                    isCreatingWorktree={model.creatingWorktreeForProject.has(
                      project.id,
                    )}
                    hasSettingsWarning={
                      project.type === 'multi-repo'
                        ? project.repos.length === 0 ||
                          Boolean(
                            model.workspaceReferenceRepoStatus[project.id]
                              ?.warnings?.length,
                          )
                        : undefined
                    }
                    {...commonSectionProps}
                  />
                ) : (
                  <SidebarCoworkWorkspaceRow
                    key={project.id}
                    item={project}
                    disableDrag
                    hasFollowingWorkspace={
                      index < hiddenListedProjects.length - 1
                    }
                  />
                ),
              )}
            </SidebarList>
          </SidebarSection>
        )}

        <SharedContainerSidebarSection
          expanded={sharedWithMeExpanded}
          onExpandedChange={setSharedWithMeExpanded}
        />
      </div>
    </div>
  );
}
