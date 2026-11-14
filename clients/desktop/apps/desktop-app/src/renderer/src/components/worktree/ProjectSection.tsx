import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { WORKTREE_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  type SortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { scheduleStickyCollapseScrollAdjust } from '@canopy/ui-app/sidebar';
import { findStickyWorkspaceSlotHost } from '@canopy/ui-app/sidebar';
import {
  findSelectedPinHosts,
  type SelectedPinHosts,
} from '@canopy/ui-app/sidebar';
import { ProjectHeader } from './ProjectHeader';
import {
  WorktreeItemAdapter,
  type WorktreeItemAdapterBaseProps,
  type WorktreeItemCollectionProps,
} from './WorktreeItemAdapter';
import { getWorktreeRecordKey } from './worktree-record-key';
import { canDragSidebarRow, orderWorktreeRows } from '@/lib/sidebar-ordering';
import {
  ArchivedContainersNavLink,
  WORKSPACE_GLYPH_RADIUS_CLASS,
} from '@canopy/ui-shared';
import { openArchivedOverviewSurface } from '@/lib/archivedContainerNavigation';
import type { BranchGroupingMenuDescriptor } from './WorktreeItem';
import {
  collectStructuralDescendantIds,
  computeWorktreeGroups,
  resolveTrackedBaseBranchFallback,
  type WorktreeGroupEntry,
} from './worktree-grouping';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { useTerminalActivityStore } from '@/stores/terminalActivityStore';
import {
  SidebarDragPreview,
  SidebarDropLine,
  SidebarNestingRail,
  HiddenItemsRow,
  SidebarFadePresence,
  WorktreeRow,
  type WorktreeRowDepthBadge,
} from '@canopy/ui-shared/components';
import { SidebarList, SidebarRowFrame, SidebarSection } from '@canopy/ui-app';

const staticListSortingStrategy: SortingStrategy = () => null;

interface WorktreeDropIndicator {
  worktreeId: string;
  position: 'before' | 'after';
}

interface ProjectSectionProps extends WorktreeItemCollectionProps {
  /**
   * Cowork workspaces have no git worktrees; real cowork sidebar rendering
   * lands in a later phase, so callers must filter cowork items out of the
   * list before rendering this component.
   */
  project: SingleRepoSidebarItem | MultiRepoSidebarItem;
  onToggleCollapsed: (projectId: string) => void;
  onCreateWorktree: (projectId: string) => void;
  onReorderWorktrees: (
    projectId: string,
    activeWorktreeId: string,
    overWorktreeId: string,
  ) => void;
  isCreatingWorktree?: boolean;
  onOpenSettings?: (projectId: string) => void;
  hasSettingsWarning?: boolean;
  disableDrag?: boolean;
  workspaceDragActive?: boolean;
  workspaceDropIndicatorPosition?: 'before' | 'after' | null;
  onToggleHiddenWorktree?: (
    projectId: string,
    worktreeId: string,
    nextHidden: boolean,
  ) => void;
  flattenHiddenWorktrees?: boolean;
  isRecentlyAdded?: boolean;
  /** Adds the expanded-row separation only when another workspace follows. */
  hasFollowingWorkspace?: boolean;
  /** Omits the redundant group row when this is the only workspace. */
  hideWorkspaceHeader?: boolean;
  /** Repo default branch per worktree key, used to exclude it from grouping. */
  defaultBranches: Record<string, string | null>;
  /** Global preference: nest child branches under their base-branch worktree. */
  branchGroupingEnabled: boolean;
}

export function ProjectSection({
  project,
  onToggleCollapsed,
  onCreateWorktree,
  isCreatingWorktree,
  onReorderWorktrees,
  onOpenSettings,
  hasSettingsWarning,
  disableDrag,
  workspaceDragActive,
  workspaceDropIndicatorPosition,
  onToggleHiddenWorktree,
  flattenHiddenWorktrees,
  isRecentlyAdded,
  hasFollowingWorkspace,
  hideWorkspaceHeader,
  defaultBranches,
  branchGroupingEnabled,
  ...worktreeItemProps
}: ProjectSectionProps): JSX.Element {
  // Early access gives the Archived link the sidebar rows' height and corner.
  const earlyAccess = useLabsExperimentEnabled('sidebar');
  const worktreeSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const terminalRunningWorktreeKeys = useTerminalActivityStore(
    (state) => state.runningWorktreeKeys,
  );
  const terminalUnseenWorktreeKeys = useTerminalActivityStore(
    (state) => state.unseenWorktreeKeys,
  );
  const terminalUnseenFailureWorktreeKeys = useTerminalActivityStore(
    (state) => state.unseenFailureWorktreeKeys,
  );
  const sectionRef = useRef<HTMLElement | null>(null);
  const [stickySlotHost, setStickySlotHost] = useState<HTMLElement | null>(
    null,
  );

  const {
    setNodeRef,
    transform,
    transition,
    isDragging,
    attributes,
    listeners,
  } = useSortable({
    id: project.id,
    disabled: disableDrag,
  });

  const workspaceHeaderStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const workspaceHeaderDragging = Boolean(workspaceDragActive || isDragging);
  const suppressHeaderClickRef = useRef(false);

  // Arm the guard for the whole drag; it is consumed by the drag gesture's
  // own synthetic click (see the click-capture handler below) or dropped when
  // a fresh pointer interaction starts. A next-task expiry timer is not
  // enough: an Escape-cancelled drag ends while the pointer is still held, so
  // its synthetic click only arrives at the eventual pointerup — arbitrarily
  // later than any fixed expiry — and the click-toggling icon slot would
  // otherwise collapse the section whose drag the user just cancelled.
  useEffect(() => {
    if (workspaceHeaderDragging) {
      suppressHeaderClickRef.current = true;
    }
  }, [workspaceHeaderDragging]);

  const sortablePointerDown = listeners?.onPointerDown as
    | ((event: ReactPointerEvent<HTMLDivElement>) => void)
    | undefined;
  const isWorkspaceHeaderDragActivator = (
    target: EventTarget | null,
  ): boolean =>
    target instanceof HTMLElement &&
    target.closest('[data-workspace-drag-activator]') !== null;
  const selectWorkspaceHeaderDragNode = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    // A new pointer interaction begins: drop any guard left armed by a drag
    // whose synthetic click never reached this header, so this gesture's own
    // click is not swallowed as though it belonged to that drag.
    suppressHeaderClickRef.current = false;
    if (disableDrag || !isWorkspaceHeaderDragActivator(event.target)) return;
    setNodeRef(event.currentTarget);
  };
  // Keyboard activations (Enter/Space) synthesize their own click, and a
  // keyboard drag's terminating key press is preventDefaulted by dnd-kit's
  // KeyboardSensor — it never produces the click that consumes the guard. Drop
  // the guard for activation keys so the next keyboard toggle after a keyboard
  // reorder is not silently swallowed. Escape deliberately does NOT clear it:
  // an Escape-cancelled pointer drag relies on the guard surviving until the
  // still-held pointer's release click.
  const handleWorkspaceHeaderKeyDownCapture = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      suppressHeaderClickRef.current = false;
    }
  };
  const handleWorkspaceHeaderPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (
      disableDrag ||
      !sortablePointerDown ||
      !isWorkspaceHeaderDragActivator(event.target)
    ) {
      return;
    }
    const activator = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-workspace-drag-activator]',
    );
    // The icon already owns dnd-kit's pointer listener. The primary label
    // deliberately shares that behavior while preserving its click-to-toggle
    // action when the pointer never crosses the six-pixel threshold.
    if (activator?.dataset.workspaceDragActivator === 'label') {
      sortablePointerDown(event);
    }
  };
  const handleWorkspaceHeaderClickCapture = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (!suppressHeaderClickRef.current) return;
    suppressHeaderClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  useLayoutEffect(() => {
    setStickySlotHost(
      findStickyWorkspaceSlotHost(sectionRef.current, project.id),
    );
  }, [project.id]);

  // When this workspace is freshly added at runtime, scroll it into view. The
  // parent owns the temporary highlight-pulse lifecycle.
  useEffect(() => {
    if (!isRecentlyAdded) return;
    sectionRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [isRecentlyAdded]);

  // Drive the highlight pulse so it plays exactly once per "recently added"
  // episode and then drops the class. The class must not linger for the whole
  // parent-owned window: MainPage hides the worktree page with `display:none`
  // on navigation, and re-showing an element that still carries an animation
  // class restarts the animation — leaving the class on would re-pulse every
  // time the user navigates back. Starting on the false->true edge and clearing
  // on `animationend`/`animationcancel`, or when the parent window closes,
  // keeps the pulse to a single play.
  const [highlightPlaying, setHighlightPlaying] = useState(false);
  const wasRecentlyAddedRef = useRef(false);
  useEffect(() => {
    if (isRecentlyAdded && !wasRecentlyAddedRef.current) {
      setHighlightPlaying(true);
    } else if (!isRecentlyAdded) {
      setHighlightPlaying(false);
    }
    wasRecentlyAddedRef.current = isRecentlyAdded ?? false;
  }, [isRecentlyAdded]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) {
      return;
    }

    const handleAnimationCancel = (event: AnimationEvent): void => {
      if (event.animationName === 'workspace-highlight-pulse') {
        setHighlightPlaying(false);
      }
    };

    section.addEventListener('animationcancel', handleAnimationCancel);
    return (): void => {
      section.removeEventListener('animationcancel', handleAnimationCancel);
    };
  }, []);

  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null);
  const [worktreeDropIndicator, setWorktreeDropIndicator] =
    useState<WorktreeDropIndicator | null>(null);

  const activeWorktree = activeWorktreeId
    ? project.worktrees.find((wt) => wt.id === activeWorktreeId)
    : undefined;
  const activeWorktreeKey = activeWorktree
    ? getWorktreeRecordKey(project.id, activeWorktree.id)
    : undefined;
  const workspaceExpanded = hideWorkspaceHeader || !project.collapsed;
  const showsExpandedContent =
    workspaceExpanded &&
    (project.worktrees.length > 0 || Boolean(isCreatingWorktree));
  // Retained-container count for the empty-state decision and the "Archived
  // and deleted" link. Once the archive store has loaded this workspace its
  // data supersedes the sidebar item's archivedContainerCount snapshot:
  // restore/permanent-delete update the store before the best-effort sidebar
  // refresh, which can fail silently and leave the snapshot stale.
  // Removals still being captured count immediately so the link reacts the
  // moment the worktree leaves the list, not when main finishes cleanup.
  const archivedContainerCount = useArchivedContainersStore(
    (s) =>
      (s.loadedWorkspaces[project.id] === true
        ? (s.byWorkspace[project.id]?.length ?? 0)
        : (project.archivedContainerCount ?? 0)) +
      (s.pendingByWorkspace[project.id]?.length ?? 0),
  );
  const hasArchivedContainers = archivedContainerCount > 0;
  // Highlight the "Archived and deleted" link while this workspace's
  // overview page (or a viewer stacked on it) is open.
  const archivedOverviewSelected = useArchivedContainersStore(
    (s) =>
      s.overview?.workspaceId === project.id ||
      s.viewer?.workspaceId === project.id,
  );
  // Cowork-style empty state: an expanded workspace with no live worktrees,
  // no in-flight creation, and no archived containers renders a quiet
  // placeholder row instead of nothing (matches the cowork "No chats" row).
  const showsEmptyState =
    workspaceExpanded &&
    project.worktrees.length === 0 &&
    !isCreatingWorktree &&
    !hasArchivedContainers;

  const isMultiRepo = project.type === 'multi-repo';
  // Use the derived display name for temporary multi-repo workspaces so the
  // sidebar shows `Repo A & Repo B` style labels. The underlying `project.id`
  // is unchanged — only the header text is replaced.
  const displayName = getWorkspaceDisplayName(project);
  const repoNames = useMemo<string[]>(
    () =>
      project.type === 'multi-repo'
        ? project.repos.map((repo) => repo.name)
        : [],
    [project],
  );
  const adapterProps: WorktreeItemAdapterBaseProps = {
    ...worktreeItemProps,
    onToggleHiddenWorktree,
    terminalRunningWorktreeKeys,
    terminalUnseenWorktreeKeys,
    terminalUnseenFailureWorktreeKeys,
  };

  // Memoized so grouping keeps a stable reference and only recomputes when the
  // worktree set actually changes, rather than on every ProjectSection render.
  // CAN-1074: pinned worktrees lead, then the tail follows the workspace's
  // sort mode (persisted manual order by default, recency when opted in).
  const itemSortMode = project.itemSortMode;
  const visibleWorktrees = useMemo(
    () =>
      orderWorktreeRows(
        flattenHiddenWorktrees
          ? project.worktrees
          : project.worktrees.filter((worktree) => !worktree.hidden),
        itemSortMode,
      ),
    [project.worktrees, flattenHiddenWorktrees, itemSortMode],
  );
  const hiddenWorktrees = useMemo(
    () =>
      flattenHiddenWorktrees
        ? []
        : project.worktrees.filter((worktree) => worktree.hidden),
    [project.worktrees, flattenHiddenWorktrees],
  );

  const baseBranches = worktreeItemProps.baseBranches;
  const { baseBranchByWorktreeId, defaultBranchNames } = useMemo(() => {
    const baseBranchByWorktreeId = new Map<string, string | null | undefined>();
    const defaultBranchNames = new Set<string>();
    for (const worktree of project.worktrees) {
      const key = getWorktreeRecordKey(project.id, worktree.id);
      // Prefer the diff-stats-resolved base branch, but fall back to the
      // worktree's tracked base branch so freshly created "Branch from"
      // worktrees (and worktrees at startup before the first diff-stats
      // refresh) group immediately.
      const resolvedBase =
        key in baseBranches
          ? baseBranches[key]
          : resolveTrackedBaseBranchFallback(project.type, worktree);
      baseBranchByWorktreeId.set(worktree.id, resolvedBase);
      const defaultBranch = defaultBranches[key]?.trim();
      if (defaultBranch) {
        defaultBranchNames.add(defaultBranch);
      }
    }
    return { baseBranchByWorktreeId, defaultBranchNames };
  }, [
    project.worktrees,
    project.id,
    project.type,
    baseBranches,
    defaultBranches,
  ]);

  const depthGrouping = useMemo(() => {
    return computeWorktreeGroups({
      worktrees: project.worktrees,
      baseBranchByWorktreeId,
      defaultBranchNames,
      groupingEnabled: branchGroupingEnabled,
    });
  }, [
    project.worktrees,
    baseBranchByWorktreeId,
    defaultBranchNames,
    branchGroupingEnabled,
  ]);

  const grouping = useMemo(() => {
    // Pinning is section-scoped, so pinned rows must remain one contiguous
    // leading group. Detach both pinned children and unpinned descendants of
    // pinned ancestors from visual grouping; depthGrouping retains the true
    // structure for badges and menu controls.
    const pinnedWorktreeIds = new Set(
      project.worktrees
        .filter((worktree) => worktree.pinned === true)
        .map((worktree) => worktree.id),
    );
    const hasPinnedAncestor = (worktreeId: string): boolean => {
      const visited = new Set<string>();
      let parentId =
        depthGrouping.stateByWorktreeId.get(worktreeId)?.parentWorktreeId ??
        null;
      while (parentId !== null && !visited.has(parentId)) {
        if (pinnedWorktreeIds.has(parentId)) {
          return true;
        }
        visited.add(parentId);
        parentId =
          depthGrouping.stateByWorktreeId.get(parentId)?.parentWorktreeId ??
          null;
      }
      return false;
    };
    const visibleBaseBranchByWorktreeId = new Map(baseBranchByWorktreeId);
    const groupingWorktrees = visibleWorktrees.map((worktree) => {
      if (worktree.pinned !== true && !hasPinnedAncestor(worktree.id)) {
        return worktree;
      }
      visibleBaseBranchByWorktreeId.set(worktree.id, null);
      if (worktree.branchGroupingParentWorktreeId === undefined) {
        return worktree;
      }
      const visuallyDetachedWorktree = { ...worktree };
      delete visuallyDetachedWorktree.branchGroupingParentWorktreeId;
      return visuallyDetachedWorktree;
    });
    return computeWorktreeGroups({
      worktrees: groupingWorktrees,
      baseBranchByWorktreeId: visibleBaseBranchByWorktreeId,
      defaultBranchNames,
      groupingEnabled: branchGroupingEnabled,
    });
  }, [
    project.worktrees,
    visibleWorktrees,
    baseBranchByWorktreeId,
    defaultBranchNames,
    branchGroupingEnabled,
    depthGrouping,
  ]);

  const depthBadgeByWorktreeId = useMemo(() => {
    const nameById = new Map<
      string,
      { branchName: string; animalName: string }
    >();
    for (const worktree of project.worktrees) {
      nameById.set(worktree.id, {
        branchName: worktree.branchName,
        animalName: worktree.id,
      });
    }

    const badges = new Map<string, WorktreeRowDepthBadge>();
    for (const worktree of project.worktrees) {
      const state = depthGrouping.stateByWorktreeId.get(worktree.id);
      if (
        !state ||
        state.ancestryDepth < 1 ||
        state.topMostAncestorId === null
      ) {
        continue;
      }
      const topMost = nameById.get(state.topMostAncestorId);
      if (!topMost) {
        continue;
      }
      const directParentId = state.parentWorktreeId;
      const directParent =
        directParentId !== null && directParentId !== state.topMostAncestorId
          ? nameById.get(directParentId)
          : undefined;
      badges.set(worktree.id, {
        depth: state.ancestryDepth,
        topMost,
        directParent,
      });
    }
    return badges;
  }, [depthGrouping, project.worktrees]);

  // Maps each worktree id to its drag container so reorders stay within a
  // single list (top-level row or a specific group's children).
  const dragContainerByWorktreeId = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of grouping.entries) {
      map.set(entry.worktree.id, 'top');
      for (const child of entry.children) {
        map.set(child.id, `group:${entry.worktree.id}`);
      }
    }
    return map;
  }, [grouping]);

  const handleWorktreeDragStart = (event: DragStartEvent): void => {
    setWorktreeDropIndicator(null);
    setActiveWorktreeId(String(event.active.id));
  };

  const handleWorktreeDragOver = (event: DragOverEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      setWorktreeDropIndicator(null);
      return;
    }

    const activeId = String(active.id);
    const overId = String(over.id);
    const activeContainer = dragContainerByWorktreeId.get(activeId);
    const overContainer = dragContainerByWorktreeId.get(overId);
    if (activeContainer === undefined || activeContainer !== overContainer) {
      setWorktreeDropIndicator(null);
      return;
    }

    const containerOrder =
      activeContainer === 'top'
        ? grouping.entries.map((entry) => entry.worktree.id)
        : (grouping.entries
            .find((entry) => `group:${entry.worktree.id}` === activeContainer)
            ?.children.map((child) => child.id) ?? []);
    const activeIndex = containerOrder.indexOf(activeId);
    const overIndex = containerOrder.indexOf(overId);
    if (activeIndex < 0 || overIndex < 0) {
      setWorktreeDropIndicator(null);
      return;
    }

    const nextIndicator: WorktreeDropIndicator = {
      worktreeId: overId,
      position: activeIndex < overIndex ? 'after' : 'before',
    };
    setWorktreeDropIndicator((current) =>
      current?.worktreeId === nextIndicator.worktreeId &&
      current.position === nextIndicator.position
        ? current
        : nextIndicator,
    );
  };

  const handleWorktreeDragEnd = (event: DragEndEvent): void => {
    setActiveWorktreeId(null);
    setWorktreeDropIndicator(null);
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    // Constrain reordering to within a single group: a grouped child can only
    // be reordered among its siblings, and top-level rows only among each
    // other. Cross-group drops are rejected.
    const activeContainer = dragContainerByWorktreeId.get(String(active.id));
    const overContainer = dragContainerByWorktreeId.get(String(over.id));
    if (
      activeContainer !== undefined &&
      overContainer !== undefined &&
      activeContainer !== overContainer
    ) {
      return;
    }

    onReorderWorktrees(project.id, String(active.id), String(over.id));
  };

  const [hiddenExpanded, setHiddenExpanded] = useState(false);

  const selectedHiddenWorktreeMatches = hiddenWorktrees.some(
    (worktree) =>
      getWorktreeRecordKey(project.id, worktree.id) ===
      worktreeItemProps.selectedWorktreeKey,
  );
  useEffect(() => {
    if (selectedHiddenWorktreeMatches) {
      setHiddenExpanded(true);
    }
  }, [selectedHiddenWorktreeMatches]);

  // Selected-item pinning: when this workspace owns the sidebar's selected
  // worktree AND its row is actually rendered in flow, portal pinned copies
  // of the workspace header + selected row into the dedicated pin hosts.
  // AppSidebar's scroll sync reveals them while the selection would
  // otherwise scroll out of view (see sticky-selected-item.ts).
  const selectedWorktree = useMemo(() => {
    const key = worktreeItemProps.selectedWorktreeKey;
    if (!key || !key.startsWith(`${project.id}/`)) return undefined;
    const selectedWorktreeId = key.slice(project.id.length + 1);
    return project.worktrees.find(
      (worktree) => worktree.id === selectedWorktreeId,
    );
  }, [project.id, project.worktrees, worktreeItemProps.selectedWorktreeKey]);
  // A collapsed workspace keeps exactly its selected row rendered, stuck
  // directly under the header — the selection never disappears behind a
  // collapse, in flow or in the pinned bands.
  const showsCollapsedSelectedRow =
    !workspaceExpanded && selectedWorktree !== undefined;
  const selectedRowRendered =
    selectedWorktree !== undefined &&
    (showsCollapsedSelectedRow ||
      flattenHiddenWorktrees === true ||
      selectedWorktree.hidden !== true ||
      hiddenExpanded);
  const [selectedPinHosts, setSelectedPinHosts] =
    useState<SelectedPinHosts | null>(null);
  useLayoutEffect(() => {
    setSelectedPinHosts(
      selectedRowRendered ? findSelectedPinHosts(sectionRef.current) : null,
    );
  }, [selectedRowRendered]);

  const setBranchGroupingOverride =
    worktreeItemProps.onSetBranchGroupingOverride;

  const buildBranchGroupingMenu = (
    worktreeId: string,
  ): BranchGroupingMenuDescriptor | undefined => {
    const state = depthGrouping.stateByWorktreeId.get(worktreeId);
    if (!state || !setBranchGroupingOverride) {
      return undefined;
    }
    // A worktree currently nested under a parent toggles its own grouping.
    if (state.isChild) {
      return {
        label: 'Unstack from base',
        kind: 'ungroup-from-base',
        testId: 'worktree-actions-menu-toggle-grouping',
        onSelect: (): Promise<void> =>
          setBranchGroupingOverride(project.id, worktreeId, 'ungroup'),
      };
    }
    // A top-level parent toggles all of its descendant branches at once.
    if (state.hasStructuralChildren) {
      const hasNestedChildren = state.nestedChildIds.length > 0;
      const override = hasNestedChildren ? 'ungroup' : 'group';
      const descendantIds = collectStructuralDescendantIds(
        worktreeId,
        depthGrouping.structuralChildIdsByWorktreeId,
      );
      return {
        label: hasNestedChildren ? 'Unstack children' : 'Stack children',
        kind: hasNestedChildren ? 'ungroup-children' : 'group-children',
        testId: 'worktree-actions-menu-toggle-grouping',
        onSelect: async (): Promise<void> => {
          // Ungroup deepest/later descendants first. Each mutation preserves
          // the currently rendered flat order; reversing the batch prevents
          // still-nested siblings from leapfrogging earlier siblings while
          // their overrides are applied one at a time.
          const orderedDescendantIds =
            override === 'ungroup'
              ? [...descendantIds].reverse()
              : descendantIds;
          for (const descendantId of orderedDescendantIds) {
            await setBranchGroupingOverride(project.id, descendantId, override);
          }
        },
      };
    }
    // A top-level worktree with an eligible parent can group under its base.
    if (state.hasEligibleParent) {
      return {
        label: 'Stack on base',
        kind: 'group-with-base',
        testId: 'worktree-actions-menu-toggle-grouping',
        onSelect: (): Promise<void> =>
          setBranchGroupingOverride(project.id, worktreeId, 'group'),
      };
    }
    return undefined;
  };

  const renderWorktreeRow = (
    worktree: (
      | SingleRepoSidebarItem
      | MultiRepoSidebarItem
    )['worktrees'][number],
    nested = false,
    nestedChildDepth?: number,
    disableSortable = false,
  ): JSX.Element => {
    const wtKey = getWorktreeRecordKey(project.id, worktree.id);
    const dropPosition =
      worktreeDropIndicator?.worktreeId === worktree.id
        ? worktreeDropIndicator.position
        : null;
    return (
      <SidebarRowFrame
        key={worktree.id}
        variant="bare"
        density="compact"
        className="relative"
        // Marks the selected in-flow row for the selected-item pin sync
        // (measured by AppSidebar; see sticky-selected-item.ts).
        data-sidebar-selected-item={
          wtKey === worktreeItemProps.selectedWorktreeKey ? '' : undefined
        }
      >
        {dropPosition && (
          <SidebarDropLine
            variant="worktree"
            position={dropPosition}
            data-testid="worktree-drop-indicator"
            data-drop-position={dropPosition}
          />
        )}
        <WorktreeItemAdapter
          {...adapterProps}
          worktreeKey={wtKey}
          project={project}
          worktree={worktree}
          branchGroupingMenu={buildBranchGroupingMenu(worktree.id)}
          depthBadge={depthBadgeByWorktreeId.get(worktree.id)}
          nested={nested}
          nestedChildDepth={nestedChildDepth}
          disableSortable={
            disableSortable ||
            !canDragSidebarRow(itemSortMode, worktree.pinned === true)
          }
        />
      </SidebarRowFrame>
    );
  };

  const firstUnpinnedEntryIndex = grouping.entries.findIndex(
    (entry) => entry.worktree.pinned !== true,
  );
  const creatingPlaceholderIndex = isCreatingWorktree
    ? firstUnpinnedEntryIndex === -1
      ? grouping.entries.length
      : firstUnpinnedEntryIndex
    : -1;
  const creatingPlaceholder = (
    <div
      className="group/sidebar-item flex items-center gap-1.5 rounded-row px-1.5 py-1.5 fg-primary/80"
      role="status"
      aria-label="Creating worktree"
      data-testid="sidebar-worktree-creating-placeholder"
    >
      <div className="flex h-5 w-5 shrink-0 items-center justify-center">
        <span
          className={`sidebar-icon-skeleton h-4 w-4 ${WORKSPACE_GLYPH_RADIUS_CLASS}`}
          aria-hidden="true"
          data-testid="sidebar-worktree-creating-icon-skeleton"
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-s font-normal leading-snug fg-secondary">
          Creating worktree…
        </p>
      </div>
    </div>
  );

  const renderGroupEntry = (entry: WorktreeGroupEntry): JSX.Element => {
    if (entry.children.length === 0) {
      return renderWorktreeRow(entry.worktree);
    }
    return (
      <div key={entry.worktree.id} className="flex flex-col gap-px">
        {renderWorktreeRow(entry.worktree)}
        <div
          // Stacked children sit flush (no vertical gap); the outer wrapper
          // keeps the 1px separation from surrounding rows.
          data-testid="worktree-branch-group-children"
          data-parent-worktree-id={entry.worktree.id}
        >
          <SortableContext
            items={entry.children.map((child) => child.id)}
            strategy={staticListSortingStrategy}
          >
            {entry.children.map((child, childIndex) => (
              <div
                key={child.id}
                className="relative"
                data-testid="worktree-branch-group-child"
                data-child-worktree-id={child.id}
              >
                {/* Per-row rail segments join into one continuous line; the
                    stack's first and last segments inset so the line does not
                    touch the group's edges. */}
                <SidebarNestingRail
                  first={childIndex === 0}
                  last={childIndex === entry.children.length - 1}
                  data-testid="worktree-nesting-rail"
                />
                {renderWorktreeRow(
                  child,
                  true,
                  depthGrouping.stateByWorktreeId.get(child.id)?.ancestryDepth,
                )}
              </div>
            ))}
          </SortableContext>
        </div>
      </div>
    );
  };

  const renderProjectHeader = (
    surface: 'flow' | 'sticky-slot' | 'pin-top' | 'pin-bottom',
  ): JSX.Element => {
    const isFlow = surface === 'flow';
    const isPinCopy = surface === 'pin-top' || surface === 'pin-bottom';
    const testIdSuffix = isFlow ? '' : `-${surface}`;
    return (
      <div
        ref={isFlow ? setNodeRef : undefined}
        style={workspaceHeaderStyle}
        className={`relative h-8 w-full ${
          workspaceHeaderDragging ? 'opacity-60' : ''
        }`}
        // Drag automation targets the flow/slot copies only; the pinned
        // selected-item copies are not drag surfaces.
        data-sidebar-workspace-sortable-header={
          isPinCopy ? undefined : project.id
        }
        data-sidebar-workspace-source-dragging={
          !isPinCopy && workspaceHeaderDragging ? 'true' : undefined
        }
        data-testid={`sidebar-project-sortable-header-${project.id}${testIdSuffix}`}
        onPointerDownCapture={
          isPinCopy ? undefined : selectWorkspaceHeaderDragNode
        }
        onPointerDown={isPinCopy ? undefined : handleWorkspaceHeaderPointerDown}
        onFocusCapture={
          isPinCopy
            ? undefined
            : (event): void => setNodeRef(event.currentTarget)
        }
        // The post-drag click-suppression guard stays off pin copies: they
        // never start drags, and the guard can only be cleared by a fresh
        // pointer-down on a drag surface — an armed guard would otherwise
        // silently swallow the pinned header's next collapse-toggle click.
        onClickCapture={
          isPinCopy ? undefined : handleWorkspaceHeaderClickCapture
        }
        onKeyDownCapture={
          isPinCopy ? undefined : handleWorkspaceHeaderKeyDownCapture
        }
      >
        <ProjectHeader
          projectId={project.id}
          name={displayName}
          color={project.color}
          worktreeCount={project.worktrees.length}
          collapsed={project.collapsed}
          onToggleCollapsed={() => {
            if (!project.collapsed) {
              scheduleStickyCollapseScrollAdjust(sectionRef.current);
            }
            onToggleCollapsed(project.id);
          }}
          onCreateWorktree={() => onCreateWorktree(project.id)}
          dragHandleAttributes={isPinCopy ? undefined : attributes}
          dragHandleListeners={disableDrag || isPinCopy ? undefined : listeners}
          disableDrag={disableDrag || isPinCopy}
          isMultiRepo={isMultiRepo}
          repoPath={
            project.type === 'single-repo' ? project.repoPath : undefined
          }
          temporary={
            project.type === 'multi-repo' && project.temporary === true
          }
          onOpenSettings={
            onOpenSettings ? (): void => onOpenSettings(project.id) : undefined
          }
          repoCount={isMultiRepo ? project.repos.length : undefined}
          repoNames={isMultiRepo ? repoNames : undefined}
          createWorktreeDisabled={isMultiRepo && project.repos.length === 0}
          hasSettingsWarning={hasSettingsWarning}
          surface={surface}
        />
      </div>
    );
  };

  // Pinned copy of the selected worktree row for the sticky-band / bottom
  // pin surfaces. Rendered flat (no nesting indent — the pinned surface has
  // no surrounding group rail) and never a drag source or drop target.
  const renderPinnedSelectedRow = (
    surface: 'pin-top' | 'pin-bottom',
  ): JSX.Element | null => {
    if (!selectedWorktree) return null;
    return (
      <SidebarRowFrame
        variant="bare"
        density="compact"
        className="relative"
        data-testid={`sidebar-selected-pin-row-${surface}`}
      >
        <WorktreeItemAdapter
          {...adapterProps}
          worktreeKey={getWorktreeRecordKey(project.id, selectedWorktree.id)}
          project={project}
          worktree={selectedWorktree}
          branchGroupingMenu={buildBranchGroupingMenu(selectedWorktree.id)}
          depthBadge={depthBadgeByWorktreeId.get(selectedWorktree.id)}
          pinnedCopy
          pinnedSurface={surface}
        />
      </SidebarRowFrame>
    );
  };

  return (
    <div
      ref={(node): void => {
        sectionRef.current = node;
      }}
      className={`relative rounded-lg ${
        hasFollowingWorkspace
          ? showsExpandedContent || showsCollapsedSelectedRow
            ? 'mb-2'
            : 'mb-px'
          : ''
      } ${highlightPlaying ? 'workspace-highlight-pulse' : ''}`}
      data-workspace-expanded={workspaceExpanded ? 'true' : 'false'}
      data-sidebar-workspace-id={project.id}
      onAnimationEnd={(event): void => {
        if (event.animationName === 'workspace-highlight-pulse') {
          setHighlightPlaying(false);
        }
      }}
    >
      {workspaceDropIndicatorPosition && (
        <SidebarDropLine
          variant="workspace"
          position={workspaceDropIndicatorPosition}
          data-drop-position={workspaceDropIndicatorPosition}
          data-testid="workspace-drop-indicator"
        />
      )}
      <SidebarSection
        collapsible={false}
        hideHeader={hideWorkspaceHeader}
        headerClassName="sidebar-workspace-sticky-header z-30"
        headerSurface="sidebar"
        header={hideWorkspaceHeader ? undefined : renderProjectHeader('flow')}
      >
        {/* Collapse exception: the selected worktree row stays rendered,
            stuck directly under the collapsed header. The wrapper carries
            `data-sidebar-folder-content` so AppSidebar's rail-layout cache
            still resolves it as this header's rows surface. */}
        {showsCollapsedSelectedRow && selectedWorktree !== undefined && (
          <div
            className="mt-px"
            data-sidebar-folder-content="code-workspace-collapsed-selected"
            data-testid={`sidebar-project-${project.id}-collapsed-selected`}
          >
            {renderWorktreeRow(selectedWorktree, false, undefined, true)}
          </div>
        )}
        {/* Keep the worktree disclosure and header in normal document flow so
          expanding never moves a row beneath the workspace header. */}
        <SidebarFadePresence
          open={showsExpandedContent || showsEmptyState}
          className="mt-px"
          data-sidebar-folder-content="code-workspace"
        >
          {showsEmptyState ? (
            <div
              className="py-2 pl-8 pr-2 text-s fg-quaternary"
              data-testid={`sidebar-project-${project.id}-empty`}
            >
              No {WORKTREE_UNIT_LABEL_PLURAL.toLowerCase()}
            </div>
          ) : (
            <>
              <DndContext
                sensors={worktreeSensors}
                collisionDetection={closestCenter}
                onDragStart={handleWorktreeDragStart}
                onDragOver={handleWorktreeDragOver}
                onDragEnd={handleWorktreeDragEnd}
                onDragCancel={() => {
                  setActiveWorktreeId(null);
                  setWorktreeDropIndicator(null);
                }}
              >
                <SortableContext
                  items={grouping.entries.map((entry) => entry.worktree.id)}
                  strategy={staticListSortingStrategy}
                >
                  <SidebarList rowGap="hairline">
                    {/* The creating row sits where the new worktree lands:
                        first among the unpinned rows. Entries keep stable
                        keys so starting a create never remounts a row. */}
                    {grouping.entries.map((entry, index) => (
                      <Fragment key={entry.worktree.id}>
                        {index === creatingPlaceholderIndex &&
                          creatingPlaceholder}
                        {renderGroupEntry(entry)}
                      </Fragment>
                    ))}
                    {creatingPlaceholderIndex === grouping.entries.length &&
                      creatingPlaceholder}
                  </SidebarList>
                </SortableContext>
                {createPortal(
                  <DragOverlay dropAnimation={null}>
                    {activeWorktree ? (
                      <SidebarDragPreview
                        className="translate-x-1"
                        data-testid="worktree-drag-overlay"
                      >
                        <WorktreeRow
                          branchLabel={
                            activeWorktree.label?.trim() ||
                            activeWorktree.branchName
                          }
                          branchName={activeWorktree.branchName}
                          worktreeId={activeWorktree.id}
                          pinnedToTop={activeWorktree.pinned === true}
                          uiStatus={
                            activeWorktreeKey
                              ? (worktreeItemProps.worktreeStatusMap.get(
                                  activeWorktreeKey,
                                ) ?? 'idle')
                              : 'idle'
                          }
                          isStreaming={
                            activeWorktreeKey
                              ? worktreeItemProps.streamingWorktreeKeys.has(
                                  activeWorktreeKey,
                                )
                              : false
                          }
                          isRunningRun={
                            activeWorktreeKey
                              ? worktreeItemProps.runRunningWorktrees.has(
                                  activeWorktreeKey,
                                )
                              : false
                          }
                          isDiscovering={
                            activeWorktreeKey
                              ? worktreeItemProps.discoveryLoading.has(
                                  activeWorktreeKey,
                                )
                              : false
                          }
                          awaitingApproval={
                            activeWorktreeKey
                              ? worktreeItemProps.awaitingApprovalKeys.has(
                                  activeWorktreeKey,
                                )
                              : false
                          }
                          hasUnread={
                            activeWorktreeKey
                              ? worktreeItemProps.unreadWorktreeKeys.has(
                                  activeWorktreeKey,
                                )
                              : false
                          }
                          healthIssue={activeWorktree.healthIssue}
                          setupPhase={
                            activeWorktreeKey &&
                            worktreeItemProps.setupRunningWorktrees.has(
                              activeWorktreeKey,
                            )
                              ? 'running-setup'
                              : activeWorktreeKey &&
                                  worktreeItemProps.tearingDownWorktrees.has(
                                    activeWorktreeKey,
                                  )
                                ? 'running-teardown'
                                : undefined
                          }
                          diffStats={
                            activeWorktreeKey
                              ? worktreeItemProps.diffStats[activeWorktreeKey]
                              : undefined
                          }
                          diffStatsStyle={
                            worktreeItemProps.worktreeDiffStatsStyle
                          }
                          runtimeState={
                            activeWorktree.status === 'done'
                              ? 'done'
                              : undefined
                          }
                          textScale="sidebar"
                        />
                      </SidebarDragPreview>
                    ) : null}
                  </DragOverlay>,
                  document.body,
                )}
              </DndContext>
              {hiddenWorktrees.length > 0 && (
                <div className="mt-1" data-testid="hidden-worktrees-section">
                  <HiddenItemsRow
                    label={`Hidden ${WORKTREE_UNIT_LABEL_PLURAL.toLowerCase()}`}
                    count={hiddenWorktrees.length}
                    expanded={hiddenExpanded}
                    onToggle={(): void =>
                      setHiddenExpanded((previous) => !previous)
                    }
                    dataTestId={`hidden-worktrees-toggle-${project.id}`}
                  />
                  <SidebarFadePresence open={hiddenExpanded}>
                    <SidebarList rowGap="hairline">
                      {hiddenWorktrees.map((worktree) =>
                        renderWorktreeRow(worktree),
                      )}
                    </SidebarList>
                  </SidebarFadePresence>
                </div>
              )}
            </>
          )}
        </SidebarFadePresence>
        {/* Archived worktrees render outside the live-worktree guard above so
            a workspace whose LAST worktree was archived (e.g. a temporary
            project kept visible only by its archives) still shows the
            subgroup. */}
        {workspaceExpanded && (
          // Row-sized, the link keeps the rows' own 1px gap (its `mt-px`).
          <div className={earlyAccess ? undefined : 'mt-0.5'}>
            <ArchivedContainersNavLink
              size={earlyAccess ? 'row' : 'compact'}
              count={archivedContainerCount}
              selected={archivedOverviewSelected}
              onOpen={() => openArchivedOverviewSurface(project.id)}
              testId={`sidebar-project-${project.id}-archived-link`}
            />
          </div>
        )}
      </SidebarSection>
      {!hideWorkspaceHeader &&
        stickySlotHost &&
        createPortal(renderProjectHeader('sticky-slot'), stickySlotHost)}
      {selectedRowRendered && selectedPinHosts && (
        <>
          {!hideWorkspaceHeader &&
            createPortal(
              renderProjectHeader('pin-top'),
              selectedPinHosts.topHeader,
            )}
          {createPortal(
            renderPinnedSelectedRow('pin-top'),
            selectedPinHosts.topRow,
          )}
          {!hideWorkspaceHeader &&
            createPortal(
              renderProjectHeader('pin-bottom'),
              selectedPinHosts.bottomHeader,
            )}
          {createPortal(
            renderPinnedSelectedRow('pin-bottom'),
            selectedPinHosts.bottomRow,
          )}
        </>
      )}
    </div>
  );
}
