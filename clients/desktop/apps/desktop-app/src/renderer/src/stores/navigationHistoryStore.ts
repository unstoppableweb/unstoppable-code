import { create } from 'zustand';
import {
  APP_ADVISOR_PROJECT_ID,
  type WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { isCoworkChatTarget } from '@/lib/cowork';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { isPageAvailable } from '@/lib/navigation/page-availability';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from './featureFlagsStore';
import {
  workflowEditKey,
  type WorkflowEditTarget,
} from '@/lib/workflows/edit-target';
import {
  askNavigationGuard,
  getPluginsPresentationContextGeneration,
  runWithoutNavigationGuard,
  useNavigationStore,
  type NavigationPage,
  type PluginsPresentationLocation,
} from './navigationStore';

/** Archived-container viewer target participating in history. */
export interface NavigationHistoryArchivedContainer {
  workspaceId: string;
  containerId: string;
}

/**
 * One place the user has been. A location is the active page plus — for the
 * worktree surface (`main`/`kanban`) — the selected worktree, so moving
 * between worktrees is a history step just like moving between pages. An
 * open archived-worktree viewer on the main page is part of the location too
 * (it behaves like a page), so back/forward re-opens/dismisses it.
 */
export interface NavigationHistoryLocation {
  page: NavigationPage;
  worktree: WorktreeSelection | null;
  archivedContainer: NavigationHistoryArchivedContainer | null;
  sharedContainer?: {
    containerId: string;
    /** Absent for a personal container shared directly. */
    organizationId?: string;
  };
  /** Present when this location is a Marketplace category detail page. */
  pluginsBrowseSectionId?: string;
  /** Restores the type context of a retired Agents location. */
  pluginsAgentTab?: true;
  pluginsPresentation?: PluginsPresentationLocation;
  pluginsContextGeneration?: number;
  /**
   * The Library's edit shell (CAN-4072). `key` is the item's identity, so a
   * section change rewrites `target` in place instead of adding a step. The
   * entry stays navigable after the item is deleted: the shell shows that
   * it was not found.
   */
  workflowEdit?: { key: string; target: WorkflowEditTarget };
}

/**
 * Hard cap on retained history entries. Deliberately far beyond what a user
 * could realistically walk back through in one session — its only job is to
 * bound memory if the app stays open for weeks. When the cap is reached the
 * oldest entries are dropped.
 */
export const NAVIGATION_HISTORY_MAX_ENTRIES = 250;

interface NavigationHistoryState {
  /** Ordered visited locations; `index` points at the current one. */
  entries: NavigationHistoryLocation[];
  index: number;
  canGoBack: boolean;
  canGoForward: boolean;
  hasRecordedNavigation: boolean;
  goBack: () => boolean;
  goForward: () => boolean;
  /** Clears all history (used by tests and tracking re-init). */
  reset: () => void;
  /** Replaces history with the app's current location. */
  resetToCurrentLocation: () => void;
  /** Replaces the untouched startup entry, preserving any real navigation. */
  replaceInitialLocation: () => boolean;
}

function locationsEqual(
  a: NavigationHistoryLocation,
  b: NavigationHistoryLocation,
): boolean {
  return (
    a.page === b.page &&
    a.pluginsAgentTab === b.pluginsAgentTab &&
    a.pluginsContextGeneration === b.pluginsContextGeneration &&
    JSON.stringify(
      a.pluginsPresentation
        ? {
            ...a.pluginsPresentation,
            scrollTop: undefined,
            browseScrollTop: undefined,
            detailReturnScrollTop: undefined,
          }
        : undefined,
    ) ===
      JSON.stringify(
        b.pluginsPresentation
          ? {
              ...b.pluginsPresentation,
              scrollTop: undefined,
              browseScrollTop: undefined,
              detailReturnScrollTop: undefined,
            }
          : undefined,
      ) &&
    (a.pluginsBrowseSectionId ?? null) === (b.pluginsBrowseSectionId ?? null) &&
    (a.worktree === null) === (b.worktree === null) &&
    (a.worktree === null ||
      (a.worktree.projectId === b.worktree?.projectId &&
        a.worktree.worktreeId === b.worktree?.worktreeId)) &&
    (a.archivedContainer === null) === (b.archivedContainer === null) &&
    (a.archivedContainer === null ||
      (a.archivedContainer.workspaceId === b.archivedContainer?.workspaceId &&
        a.archivedContainer.containerId ===
          b.archivedContainer?.containerId)) &&
    (a.sharedContainer?.containerId ?? null) ===
      (b.sharedContainer?.containerId ?? null) &&
    (a.sharedContainer?.organizationId ?? null) ===
      (b.sharedContainer?.organizationId ?? null) &&
    (a.workflowEdit?.key ?? null) === (b.workflowEdit?.key ?? null)
  );
}

/** Refinements on the same Customize page replace its history snapshot. */
function sameCustomizeDestination(
  a: NavigationHistoryLocation,
  b: NavigationHistoryLocation,
): boolean {
  const from = a.pluginsPresentation;
  const to = b.pluginsPresentation;
  return (
    a.page === 'plugins' &&
    b.page === 'plugins' &&
    (!from ||
      !to ||
      a.pluginsContextGeneration === b.pluginsContextGeneration) &&
    (a.pluginsBrowseSectionId ?? null) === (b.pluginsBrowseSectionId ?? null) &&
    from?.source?.sourceId === to?.source?.sourceId &&
    from?.entry?.id === to?.entry?.id &&
    from?.entry?.skillFilePath === to?.entry?.skillFilePath
  );
}

function captureSharedContainer():
  | NonNullable<NavigationHistoryLocation['sharedContainer']>
  | undefined {
  const viewer = useSharedContainerReplicasStore.getState().viewer;
  return viewer === null
    ? undefined
    : {
        containerId: viewer.containerId,
        ...(viewer.organizationId
          ? { organizationId: viewer.organizationId }
          : {}),
      };
}

/**
 * The archived-container viewer participates in main-page history when it
 * targets a code workspace (work-entry viewers belong to the chat page /
 * App Advisor popout, which history intentionally leaves alone).
 */
function captureArchivedContainer(): NavigationHistoryArchivedContainer | null {
  const viewer = useArchivedContainersStore.getState().viewer;
  if (
    viewer === null ||
    viewer.workspaceId === APP_ADVISOR_PROJECT_ID ||
    isCoworkChatTarget(viewer.workspaceId)
  ) {
    return null;
  }
  return { workspaceId: viewer.workspaceId, containerId: viewer.containerId };
}

/**
 * Snapshot the current location from the navigation + chat stores. The
 * selected worktree only participates on the worktree surface — every other
 * page keeps `selectedWorktree` around as background state (MainPage stays
 * mounted), and cowork chat targets are the `chat` page's own concern.
 */
function captureCurrentLocation(): NavigationHistoryLocation {
  const navigation = useNavigationStore.getState();
  const page = navigation.activePage;
  if (page === 'plugins') {
    const location: NavigationHistoryLocation = {
      page,
      worktree: null,
      archivedContainer: null,
      ...(navigation.pluginsPresentation
        ? {
            pluginsPresentation: navigation.pluginsPresentation,
            pluginsContextGeneration: getPluginsPresentationContextGeneration(),
          }
        : {}),
      ...(navigation.pluginsBrowseSectionId
        ? { pluginsBrowseSectionId: navigation.pluginsBrowseSectionId }
        : {}),
    };
    if (
      navigation.pendingPluginsNavigation?.kind === 'marketplace-browse' &&
      navigation.pendingPluginsNavigation.tab === 'agent'
    ) {
      location.pluginsAgentTab = true;
    }
    return location;
  }
  if (page === 'workflows-library' && navigation.workflowEdit !== undefined) {
    return {
      page,
      worktree: null,
      archivedContainer: null,
      workflowEdit: {
        key: workflowEditKey(navigation.workflowEdit),
        target: navigation.workflowEdit,
      },
    };
  }
  if (page !== 'main' && page !== 'kanban') {
    return { page, worktree: null, archivedContainer: null };
  }
  const selected = useChatStore.getState().selectedWorktree;
  const worktree =
    selected && !isCoworkChatTarget(selected.projectId) ? selected : null;
  const sharedContainer =
    page === 'main' ? captureSharedContainer() : undefined;
  return {
    page,
    worktree,
    archivedContainer: page === 'main' ? captureArchivedContainer() : null,
    ...(sharedContainer ? { sharedContainer } : {}),
  };
}

function isLocationNavigable(location: NavigationHistoryLocation): boolean {
  if (
    location.pluginsPresentation &&
    location.pluginsContextGeneration !==
      getPluginsPresentationContextGeneration()
  )
    return false;
  if (
    location.pluginsAgentTab &&
    !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key)
  )
    return false;
  // A page switched off since it was recorded is skipped and pruned like a
  // vanished worktree, so back/forward land on the next reachable entry
  // instead of recording the navigation fallback as a duplicate step.
  if (!isPageAvailable(location.page)) {
    return false;
  }
  const projectsState = useProjectsStore.getState();
  if (location.sharedContainer !== undefined) {
    const sharedState = useSharedContainerReplicasStore.getState();
    if (
      sharedState.listStatus === 'success' &&
      !sharedState.entries.some(
        (entry) =>
          entry.container.id === location.sharedContainer?.containerId &&
          entry.organizationId === location.sharedContainer.organizationId,
      )
    ) {
      return false;
    }
  }
  if (location.archivedContainer !== null) {
    const { workspaceId, containerId } = location.archivedContainer;
    if (!projectsState.projects.some((project) => project.id === workspaceId)) {
      return false;
    }
    // With the workspace's summaries loaded, a missing container means it was
    // restored or permanently deleted; before they load, assume it exists.
    const archivedState = useArchivedContainersStore.getState();
    if (
      archivedState.loadedWorkspaces[workspaceId] === true &&
      !archivedState.byWorkspace[workspaceId]?.some(
        (entry) => entry.id === containerId,
      )
    ) {
      return false;
    }
  }
  if (location.worktree === null) {
    return true;
  }
  return canNavigateToWorktreeFromSidebarItems(
    projectsState.projects,
    location.worktree.projectId,
    location.worktree.worktreeId,
    projectsState.hasHydratedProjects,
  );
}

/**
 * True while `goBack`/`goForward` is applying a location to the app stores.
 * The tracking subscription uses it to fold the resulting store changes into
 * the existing entry instead of pushing new ones.
 */
let restoring = false;

/**
 * Apply a history location to the app stores. `step` asked the navigation
 * guard before it got here, so nothing in the restore asks again.
 */
function applyLocation(location: NavigationHistoryLocation): void {
  restoring = true;
  try {
    runWithoutNavigationGuard(() => restoreLocation(location));
  } finally {
    // Store subscriptions fire synchronously inside the calls above, and the
    // tracking commit is microtask-coalesced — clear the flag after that
    // commit has run so restore-driven changes never push entries.
    queueMicrotask(() => {
      restoring = false;
    });
  }
}

function restoreLocation(location: NavigationHistoryLocation): void {
  const navigation = useNavigationStore.getState();
  if (location.pluginsPresentation) {
    navigation.openPluginsNavigation({
      kind: 'restore',
      location: location.pluginsPresentation,
    });
  } else if (location.pluginsAgentTab) {
    navigation.openPluginsNavigation({
      kind: 'marketplace-browse',
      query: '',
      tab: 'agent',
    });
  } else {
    navigation.navigate(location.page);
  }
  if (location.page === 'workflows-library') {
    navigation.replaceWorkflowEdit(location.workflowEdit?.target ?? null);
  }
  navigation.setPluginsBrowseSectionId(
    location.page === 'plugins'
      ? (location.pluginsBrowseSectionId ?? null)
      : null,
  );
  if (location.page === 'main' || location.page === 'kanban') {
    if (location.worktree) {
      useChatStore
        .getState()
        .selectWorktree(
          location.worktree.projectId,
          location.worktree.worktreeId,
        );
    } else {
      useChatStore.getState().deselectWorktree();
    }
  }
  // Apply the archived-viewer part of the location LAST so it overlays the
  // restored selection: re-open the viewer for viewer locations (scrolling
  // its sidebar row into view, matching worktree selections), dismiss it
  // otherwise.
  const archivedStore = useArchivedContainersStore.getState();
  const sharedStore = useSharedContainerReplicasStore.getState();
  if (location.sharedContainer !== undefined) {
    archivedStore.closeViewer();
    void sharedStore.openContainer(location.sharedContainer);
  } else if (location.archivedContainer !== null) {
    sharedStore.closeViewer();
    archivedStore.openViewer(
      location.archivedContainer.workspaceId,
      location.archivedContainer.containerId,
    );
    useProjectsStore
      .getState()
      .requestScrollToWorktree(
        location.archivedContainer.workspaceId,
        location.archivedContainer.containerId,
      );
  } else {
    archivedStore.closeViewer();
    sharedStore.closeViewer();
  }
}

/** Moves to `target` and applies its location. */
function moveTo(entries: NavigationHistoryLocation[], target: number): void {
  useNavigationHistoryStore.setState({
    entries,
    index: target,
    canGoBack: target > 0,
    canGoForward: target < entries.length - 1,
  });
  applyLocation(entries[target]);
}

interface PlannedStep {
  /** History with the unreachable entries passed over removed. */
  entries: NavigationHistoryLocation[];
  /** Position of the current entry within `entries`. */
  index: number;
  /** Entry to move to, or null when none is reachable. */
  target: number | null;
}

/**
 * Finds the next reachable entry in `direction`, pruning the entries whose
 * worktree or page no longer exists on the way.
 */
function planStep(
  state: Pick<NavigationHistoryState, 'entries' | 'index'>,
  direction: -1 | 1,
): PlannedStep {
  const entries = state.entries.map((location): NavigationHistoryLocation => {
    const page: string = location.page;
    return page === 'agents'
      ? { ...location, page: 'plugins', pluginsAgentTab: true }
      : location;
  });
  let index = state.index;
  let target = index + direction;
  while (target >= 0 && target < entries.length) {
    if (isLocationNavigable(entries[target])) {
      return { entries, index, target };
    }
    entries.splice(target, 1);
    if (target < index) {
      index -= 1;
    }
    // After the splice the next candidate sits at `target` when moving
    // forward (later entries shifted left) and at `target - 1` when moving
    // back (earlier entries kept their positions).
    if (direction === -1) {
      target -= 1;
    }
  }
  return { entries, index, target: null };
}

/**
 * Step `direction` through history, skipping (and pruning) entries whose
 * worktree no longer exists. Returns whether a move happened.
 *
 * The navigation guard is asked before the index moves (CAN-4072), so a
 * refused step leaves history where it was. A deferred answer returns
 * `false` now and moves once allowed, unless the user moved elsewhere in the
 * meantime. It then plans again from the history as it is by then, since a
 * save from the prompt may have replaced the current entry.
 */
function step(direction: -1 | 1): boolean {
  const state = useNavigationHistoryStore.getState();
  const planned = planStep(state, direction);
  if (planned.target === null) {
    if (planned.entries.length !== state.entries.length) {
      useNavigationHistoryStore.setState({
        entries: planned.entries,
        index: planned.index,
        canGoBack: planned.index > 0,
        canGoForward: planned.index < planned.entries.length - 1,
      });
    }
    return false;
  }
  const decision = askNavigationGuard(planned.entries[planned.target].page);
  if (typeof decision === 'boolean') {
    if (!decision) return false;
    moveTo(planned.entries, planned.target);
    return true;
  }
  void decision.then(
    (allowed) => {
      const current = useNavigationHistoryStore.getState();
      if (
        !allowed ||
        current.index !== state.index ||
        current.entries.length !== state.entries.length
      ) {
        return;
      }
      const replanned = planStep(current, direction);
      if (replanned.target !== null) {
        moveTo(replanned.entries, replanned.target);
      }
    },
    () => undefined,
  );
  return false;
}

export const useNavigationHistoryStore = create<NavigationHistoryState>(
  (set, get) => ({
    entries: [],
    index: -1,
    canGoBack: false,
    canGoForward: false,
    hasRecordedNavigation: false,
    goBack: (): boolean => step(-1),
    goForward: (): boolean => step(1),
    reset: (): void => {
      set({
        entries: [],
        index: -1,
        canGoBack: false,
        canGoForward: false,
        hasRecordedNavigation: false,
      });
    },
    resetToCurrentLocation: (): void => {
      const location = captureCurrentLocation();
      set({
        entries: [location],
        index: 0,
        canGoBack: false,
        canGoForward: false,
        hasRecordedNavigation: false,
      });
    },
    replaceInitialLocation: (): boolean => {
      const state = get();
      if (
        state.hasRecordedNavigation ||
        state.entries.length !== 1 ||
        state.index !== 0
      ) {
        return false;
      }
      const location = captureCurrentLocation();
      set({
        entries: [location],
        index: 0,
        canGoBack: false,
        canGoForward: false,
      });
      return true;
    },
  }),
);

/** Rewrites the current entry to `location` without moving. */
function rewriteCurrentEntry(location: NavigationHistoryLocation): void {
  const state = useNavigationHistoryStore.getState();
  if (state.index < 0) return;
  const entries = [...state.entries];
  entries[state.index] = location;
  useNavigationHistoryStore.setState({ entries });
}

function commitCurrentLocation(mode: CommitMode): void {
  const location = captureCurrentLocation();
  const state = useNavigationHistoryStore.getState();
  const current = state.index >= 0 ? state.entries[state.index] : undefined;
  if (current && locationsEqual(current, location)) {
    // Same item in the edit shell: keep its latest section for restore.
    if (
      current.workflowEdit?.target !== location.workflowEdit?.target ||
      current.pluginsPresentation?.scrollTop !==
        location.pluginsPresentation?.scrollTop
    ) {
      rewriteCurrentEntry(location);
    }
    return;
  }
  if (current && !restoring && sameCustomizeDestination(current, location)) {
    rewriteCurrentEntry(location);
    return;
  }
  if (mode === 'replace' && !restoring && current) {
    // `replaceWorkflowEdit` (a draft saved, a duplicate opened) stands in
    // for the item already recorded rather than being a step of its own.
    const entries = [...state.entries];
    entries[state.index] = location;
    useNavigationHistoryStore.setState({
      entries,
      hasRecordedNavigation: true,
    });
    return;
  }
  if (restoring) {
    // A restore landed somewhere other than the recorded entry (e.g. the
    // worktree vanished mid-flight). Rewrite the current entry to reality
    // instead of growing the stack.
    if (state.index >= 0) {
      const entries = [...state.entries];
      entries[state.index] = location;
      useNavigationHistoryStore.setState({ entries });
    }
    return;
  }
  // Standard branch-truncating push: navigating after going back discards
  // the forward tail, matching browser history semantics.
  let entries = [...state.entries.slice(0, state.index + 1), location];
  if (entries.length > NAVIGATION_HISTORY_MAX_ENTRIES) {
    entries = entries.slice(entries.length - NAVIGATION_HISTORY_MAX_ENTRIES);
  }
  useNavigationHistoryStore.setState({
    entries,
    index: entries.length - 1,
    canGoBack: entries.length > 1,
    canGoForward: false,
    hasRecordedNavigation: true,
  });
}

/**
 * How the pending commit records its location: `replace` only when every
 * change since the last commit came from `replaceWorkflowEdit`.
 */
type CommitMode = 'push' | 'replace';

let pendingCommitMode: CommitMode | null = null;

function scheduleCommit(mode: CommitMode = 'push'): void {
  const scheduled = pendingCommitMode !== null;
  pendingCommitMode =
    pendingCommitMode === 'push' || mode === 'push' ? 'push' : 'replace';
  if (scheduled) {
    return;
  }
  // Microtask coalescing: a single user navigation often mutates both stores
  // (page change + worktree selection) in the same tick; commit once after
  // both have settled so intermediate states never become history entries.
  queueMicrotask(() => {
    const commitMode = pendingCommitMode ?? 'push';
    pendingCommitMode = null;
    commitCurrentLocation(commitMode);
  });
}

/**
 * Start recording navigation history. Subscribes to the navigation and chat
 * stores rather than instrumenting call sites, so every navigation path —
 * sidebar clicks, keyboard shortcuts, deep links, and App Advisor
 * `navigation.*` / `worktree.select` actions — is captured through the same
 * funnel. History is intentionally in-memory only; it starts empty on every
 * launch and is never persisted.
 *
 * Returns an unsubscribe/cleanup function.
 */
export function initNavigationHistoryTracking(): () => void {
  useNavigationHistoryStore.getState().resetToCurrentLocation();
  const initialNavigation = useNavigationStore.getState();
  let lastPage = initialNavigation.activePage;
  let lastPluginsBrowseSectionId = initialNavigation.pluginsBrowseSectionId;
  let lastPluginsPresentation = initialNavigation.pluginsPresentation;
  let lastWorkflowEdit = initialNavigation.workflowEdit;
  let lastReplaceCount = initialNavigation.workflowEditReplaceCount;
  const unsubscribeNavigation = useNavigationStore.subscribe((state) => {
    const replaced = state.workflowEditReplaceCount !== lastReplaceCount;
    lastReplaceCount = state.workflowEditReplaceCount;
    if (
      state.activePage !== lastPage ||
      state.pluginsBrowseSectionId !== lastPluginsBrowseSectionId ||
      state.pluginsPresentation !== lastPluginsPresentation ||
      state.workflowEdit !== lastWorkflowEdit
    ) {
      lastPage = state.activePage;
      lastPluginsBrowseSectionId = state.pluginsBrowseSectionId;
      lastPluginsPresentation = state.pluginsPresentation;
      lastWorkflowEdit = state.workflowEdit;
      scheduleCommit(replaced ? 'replace' : 'push');
    }
  });
  let lastSelection = useChatStore.getState().selectedWorktree;
  const unsubscribeChat = useChatStore.subscribe((state) => {
    if (state.selectedWorktree !== lastSelection) {
      lastSelection = state.selectedWorktree;
      scheduleCommit();
    }
  });
  const viewerKey = (
    viewer: { workspaceId: string; containerId: string } | null,
  ): string | null =>
    viewer === null ? null : `${viewer.workspaceId}\0${viewer.containerId}`;
  let lastViewerKey = viewerKey(useArchivedContainersStore.getState().viewer);
  const unsubscribeArchived = useArchivedContainersStore.subscribe((state) => {
    // Track open/close and container identity only — tab/chat switches inside
    // the viewer replace the viewer object but are not navigation steps.
    const key = viewerKey(state.viewer);
    if (key !== lastViewerKey) {
      lastViewerKey = key;
      scheduleCommit();
    }
  });
  const sharedViewerKey = (
    viewer: { containerId: string; organizationId?: string } | null,
  ): string | null =>
    viewer === null
      ? null
      : `${viewer.organizationId ?? ''}\0${viewer.containerId}`;
  let lastSharedViewerKey = sharedViewerKey(
    useSharedContainerReplicasStore.getState().viewer,
  );
  const unsubscribeShared = useSharedContainerReplicasStore.subscribe(
    (state) => {
      const key = sharedViewerKey(state.viewer);
      if (key !== lastSharedViewerKey) {
        lastSharedViewerKey = key;
        scheduleCommit();
      }
    },
  );
  return (): void => {
    unsubscribeNavigation();
    unsubscribeChat();
    unsubscribeArchived();
    unsubscribeShared();
  };
}
