import { inlineFailureText } from '@/lib/inline-app-error';
import { SidebarChatsSectionMenuItems } from '@canopy/ui-shared/components';
import {
  noteChatIntent,
  endChatIntent,
  type ChatPrefetchTarget,
} from '@/stores/chat/chat-prefetch';
import {
  useSidebarItemGroupsStore,
  overlaySidebarItemGroups,
} from '@/stores/sidebarItemGroupsStore';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { workspaceContextLabel } from '@/lib/automationContextScope';
import { useShallow } from 'zustand/shallow';
import type {
  CanopyCapabilities,
  CanopyClient,
  SessionViewModel,
  WorktreeCreateResult,
} from '@canopy/app-core';
import {
  getWorktreeDeleteLabels,
  SidebarSurface,
  snapshotWorkspaceMatchesContext,
  workspaceLayout,
  worktreeRemovalBlockedReason,
  type GetWorkEntryBatchRemovalFacts,
  type GetWorkEntryBulkState,
  type RemoveWorkEntryInBatch,
  type SidebarBatchRemovalUiState,
  type SidebarSelection,
  type SidebarSurfaceTestIds,
  type WorkEntryMultiSelectBinding,
  type WorktreeBatchRemovalFacts,
  type WorktreeBatchRemovalOptions,
  type WorktreeBatchRemovalUiState,
  type WorktreeRemovalMode,
  SidebarRailSkeleton,
} from '@canopy/ui-app';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { useDesktopSidebarActivityHost } from './desktopSidebarActivityMode';
import {
  openCoworkWorkEntryFromSidebar,
  selectCoworkWorkspaceFromSidebar,
} from '@/lib/openCoworkWorkEntryFromSidebar';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { useCanopyDesktopPrSplitEnabled } from '@/hooks/useCanopyDesktopPrSplitEnabled';
import { ArchivedContainerActionsMenu } from '@/components/archive/ArchivedContainerActionsMenu';
import { offerRetainedArchiveDiscard } from '@/components/archive/offerRetainedArchiveDiscard';
import { useSplitPrGatingPreferences } from '@/hooks/useSplitPrPreferences';
import { useActivityStore } from '@/stores/activityStore';
import {
  usePipelineRunsStore,
  type WorktreePipelineEntry,
} from '@/stores/pipelineRunsStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useSidebarPageHandoffStore } from '@/stores/sidebarPageHandoffStore';
import { isCoworkChatTarget } from '@/lib/cowork';
import {
  ArchivedContainersNavLink,
  summarizeCommandFailure,
} from '@canopy/ui-shared';
import { openArchivedOverviewSurface } from '@/lib/archivedContainerNavigation';
import { useNavigationStore } from '@/stores/navigationStore';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useDesktopPendingProjects } from './desktopPendingProjects';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { TeardownFailedError, useProjectsStore } from '@/stores/projectsStore';
import { finishWorktreeArchive } from '@/components/worktree/finishWorktreeArchive';
import {
  WorktreeArchiveRefusalError,
  WorktreeRemovalRefusedError,
} from '@/lib/worktreeRemovalAdmission';
import { worktreeDiscardBatchPointer } from '@canopy/ui-shared/lib/worktree-discard-copy';
import type { WorktreeDiscardDescription } from '@canopy/protocol/portal/worktree-discard';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useSidebarStore } from '@/stores/sidebarStore';
import { createDiffStatsKey } from '@/stores/projectsStore.diffStats';
import {
  getSidebarProjectEntries,
  useStandaloneChatStore,
} from '@/stores/standaloneChatStore';
import {
  getWorktreeRemovalBlocker,
  removalBlockedReason,
} from '@/stores/chat/close-guard';
import type {
  CoworkSidebarItem,
  DiffStats,
  SidebarItem,
  WorkspaceContext,
  WorktreeData,
  WorktreeDiffStatsStyle,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  defaultCoworkWorkspaceIdForContext,
  isDefaultCoworkWorkspaceId,
} from '@canopy/desktop-shared/types';
import {
  ActionMenuRowStyle,
  DelayedLoadingPlaceholder,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  type WorktreeMenuItem,
  type WorktreeMenuItemKey,
} from '@canopy/ui-shared/components';
import {
  AssignmentAddIcon,
  BuildingIcon,
  DownloadIcon,
  LinkIcon,
  SettingsIcon,
  ShareIcon,
  SplitIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { getSplitWorkspaceMenuState } from '@/components/worktree/split-workspace-menu';
import {
  indexActiveScriptRuns,
  isWorktreeLaunchActiveInIndex,
  resolveWorktreeLaunchEntry,
  runWorktreeLaunch,
  stopWorktreeScripts,
  worktreesWithStoppableScripts,
} from '@/components/worktree/worktree-launch';
import { WorktreeLaunchIdSlot } from '@/components/worktree/WorktreeLaunchStopControl';
import type { ScriptEntry } from '@/components/activity/script-utils';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import { useScriptsStore } from '@/stores/scriptsStore';
import { worktreeKey } from '@/stores/githubStore';
import {
  SPLIT_PR_BLOCKER_COPY,
  deriveSplitPrEligibilityInputs,
  gatherSplitPrReadinessInputs,
  splitPrReadinessStoreAccessors,
} from '@/lib/splitPrEligibilityInputs';
import {
  canShowStandaloneDeleteButton,
  isWorktreeFresh,
} from '@/components/worktree/worktree-delete-action';
import { WorktreeBranchInfoDialog } from '@/components/worktree/WorktreeBranchInfoDialog';
import {
  WorktreeRemovalConfirmDialog,
  type WorktreeArchiveConfirmationTarget,
} from '@/components/worktree/WorktreeRemovalConfirmDialog';
import {
  getDeleteAction,
  type DeleteAction,
} from '@/components/worktree/worktree-delete-action';
import { resolveArchiveRetentionDays } from '@canopy/desktop-shared/lib/archive-retention';
import { subscribeToWorktreeArchiveConfirmationRequests } from '@/lib/worktreeArchiveConfirmationEvents';
import { useGitHubStore } from '@/stores/githubStore';
import { hasVisibleWorkspaceContent } from '@canopy/desktop-shared/lib/workspace-visibility';
import { InviteTeammateModal } from '@/components/shared/InviteTeammateModal';
import { SharedContainerSidebarSection } from '@/components/shared-containers/SharedContainerSidebarSection';
import {
  sharedWorktreeKey,
  useSharedContainersStore,
} from '@/stores/sharedContainersStore';
import { useSharedContainerEntryPointVisible } from '@/hooks/useSharedContainerEntryPointVisible';
import { subscribeToSharedContainerInviteRequests } from '@/lib/sharedContainerInviteEvents';
import { CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { openImportSessionModal } from '@/stores/importSessionModalStore';
import {
  canMoveToOrganization,
  openMoveToOrganizationModal,
} from '@/stores/moveToOrganizationModalStore';
import { useCanopyOrgProjectsEnabled } from '@/hooks/useCanopyOrgProjectsEnabled';
import { DesktopMoveToOrganizationDialog } from './DesktopMoveToOrganizationDialog';
import { DesktopLinkCloudProjectDialog } from './DesktopLinkCloudProjectDialog';
import {
  canLinkCloudProject,
  openLinkCloudProjectModal,
} from '@/stores/linkCloudProjectModalStore';
import { useCanopyProjectIdentityAvailable } from '@/hooks/useCanopyCloudConnected';
import { openNewCoworkTaskFromSidebar } from '@/lib/openNewCoworkTaskFromSidebar';
import { SidebarCoworkWorkspaceRow } from './SidebarCoworkWorkspaceRow';
import { CloudCoworkOfflineRow } from '@/cloud-chats/CloudCoworkOfflineRow';
import {
  CLOUD_PROJECT_DANGER_COPY,
  cloudSidebarRowCapabilities,
  type CloudSidebarRowKind,
} from '@/cloud-chats/cloud-sidebar-capabilities';
import { useCloudCoworkSidebar } from '@/cloud-chats/useCloudCoworkSidebar';
import { isWebCoreScope } from '@/lib/chat-authority';
import { appendCloudSidebarRows } from '@/cloud-chats/append-cloud-sidebar-rows';
import { shouldPrefetchWorktreeChat } from '@/cloud-chats/cloud-sidebar-intent';
import { routeSidebarReorder } from '@/cloud-chats/route-sidebar-reorder';
import { StickyWorkspaceControls } from './SidebarWorkspacesSection';
import {
  SidebarPinMenuItem,
  SidebarSortMenuItems,
} from './SidebarSortMenuItems';
import { canDragSidebarRow } from '@/lib/sidebar-ordering';
import { resolveTrackedBaseBranchFallback } from '@canopy/desktop-shared/lib/worktree-grouping';
import { SidebarProjectVisibilityMenuItems } from './SidebarProjectVisibilityMenuItems';
import { CHATS_SECTION_VISIBLE_ENTRIES } from './SidebarChatsSection';
import {
  OrgProjectPlaceholderRow,
  OrgProjectPlaceholderSection,
} from '../worktree/OrgProjectPlaceholderRow';
import { useOrgDefaultChatsWorkspace } from './useOrgDefaultChatsWorkspace';
import { useSelectedCoworkEntryId } from './useSelectedCoworkEntryId';
import { useSidebarWorkspaces } from './useSidebarWorkspaces';
import {
  resetDesktopRowLiveKeys,
  setDesktopRowLiveKeys,
  useDesktopWorktreeRowOverrides,
  type DesktopWorktreeRowLiveKeys,
} from './desktopWorktreeRowOverrides';
import { SidebarContextEmptyState } from './SidebarContextEmptyState';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useSidebarScopingContext } from './useSidebarScopingContext';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import {
  useWorktreeRowNamings,
  type WorktreeRowNaming,
} from './worktreeChatNames';
import { useSpaceNotificationSidebarProps } from '@/hooks/useSpaceNotificationSidebarProps';

/** Row naming while early access is off: stored label or branch, then id. */
const DEFAULT_ROW_NAMING: WorktreeRowNaming = { title: undefined };

// Creation must reject to release the shared sidebar's pending row. The
// projects store already presents this failure through WorktreeErrorNotice.
class WorktreeCreationNoticeError extends Error {
  override name = 'WorktreeCreationNoticeError';
}

// Host contracts are exported alongside the component for focused unit tests.

/**
 * Desktop's archived entry point for a project: the link into the Archived
 * overview page, exactly as the legacy section renders it, rather than the
 * shared surface's inline archived list. Live store data supersedes the
 * sidebar item's archived-count snapshot once a workspace has been loaded.
 */
function DesktopArchivedNavLink({
  workspaceId,
  fallbackCount,
}: {
  readonly workspaceId: string;
  readonly fallbackCount: number;
}): JSX.Element {
  const count = useArchivedContainersStore(
    (s) =>
      (s.loadedWorkspaces[workspaceId] === true
        ? (s.byWorkspace[workspaceId]?.length ?? 0)
        : fallbackCount) + (s.pendingByWorkspace[workspaceId]?.length ?? 0),
  );
  const selected = useArchivedContainersStore(
    (s) =>
      s.overview?.workspaceId === workspaceId ||
      s.viewer?.workspaceId === workspaceId,
  );
  // Early access gives the link the sidebar rows' height and corner.
  const rowSized = useLabsExperimentEnabled('sidebar');
  return (
    // Row-sized, the link sits 1px under the last row (its own margin).
    <div className={rowSized ? undefined : 'mt-0.5'}>
      <ArchivedContainersNavLink
        size={rowSized ? 'row' : 'compact'}
        count={count}
        selected={selected}
        onOpen={() => openArchivedOverviewSurface(workspaceId)}
        testId={`sidebar-project-${workspaceId}-archived-link`}
      />
    </div>
  );
}

/**
 * Stable empty result for a worktree with no pipeline runs. `getPipelinePopoverEntries`
 * must return the SAME reference across calls for an unchanged (empty) row:
 * `SidebarPipelineStatusPopover`'s live path feeds it straight into
 * `useSyncExternalStore` as the snapshot getter, and a fresh `[]` on every
 * call reads as "changed" every render — `useSyncExternalStore` schedules
 * another render to reconcile, which calls it again, which returns another
 * new `[]`, forever, until React throws "Maximum update depth exceeded".
 */
const EMPTY_PIPELINE_POPOVER_ENTRIES: WorktreePipelineEntry[] = [];

export const DESKTOP_SHARED_SIDEBAR_TEST_IDS: SidebarSurfaceTestIds = {
  root: 'sidebar-shared-rail',
  // The Projects section keeps the legacy section's id: specs address the
  // section (header and list), not the rail around it.
  workspacesSection: 'sidebar-section-code',
  workspaceHeader: (workspaceId) => `sidebar-project-header-${workspaceId}`,
  // Cowork rows kept `sidebar-cowork-project-<id>-toggle` as their collapse
  // control; code projects never had a toggle id (specs use the role name),
  // and theirs must not share the `sidebar-project-header-` prefix that specs
  // use to find the one header per workspace.
  workspaceToggle: (workspaceId, workspaceType) =>
    workspaceType === 'cowork'
      ? `sidebar-cowork-project-${workspaceId}-toggle`
      : `sidebar-project-toggle-${workspaceId}`,
  workspaceSortableHeader: (workspaceId) =>
    `sidebar-project-sortable-header-${workspaceId}`,
  workspaceOptionsButton: 'workspace-project-options-button',
  workspaceContextMenu: 'workspace-session-context-menu',
  workspaceEmpty: (workspaceId) => `sidebar-project-${workspaceId}-empty`,
  workspacesSectionToggle: 'sidebar-section-code-toggle',
  workspacesSectionMenu: 'sidebar-section-code-more',
  workspacesSectionMenuContent: 'sidebar-section-code-menu',
  chatsSection: 'sidebar-section-chats',
  chatsSectionToggle: 'sidebar-section-chats-toggle',
  chatsSectionSettings: 'sidebar-section-chats-settings',
  chatsSectionMenu: 'sidebar-section-chats-more',
  chatsSectionMenuContent: 'workspace-session-context-menu',
  chatsSectionCreateChat: 'sidebar-section-chats-new-chat',
  chatsSectionContent: 'sidebar-section-chats-content',
  scroll: 'sidebar-workspaces-content',
  loading: 'sidebar-section-code-loading',
  workspaceList: 'sidebar-workspaces-list',
  workspaceSection: (workspaceId) => `sidebar-project-${workspaceId}`,
  worktreeRow: () => 'worktree-row',
  hiddenWorkspacesToggle: 'hidden-workspaces-toggle',
  hiddenWorktreesToggle: (workspaceId) =>
    `hidden-worktrees-toggle-${workspaceId}`,
  hiddenWorktreesSection: 'hidden-worktrees-section',
  addWorkspace: 'sidebar-section-code-add',
  worktreeActionsMenuButton: 'worktree-actions-menu-button',
  worktreeActionsMenu: 'worktree-actions-menu',
  worktreeActionSetLabel: 'worktree-actions-menu-set-label',
  worktreeActionBranchInfo: 'worktree-actions-menu-info',
  worktreeActionLaunch: 'worktree-actions-menu-launch',
  worktreeActionDispatchPipeline: 'worktree-actions-menu-dispatch-pipeline',
  worktreeActionSplitPr: 'worktree-actions-menu-split-pr',
  worktreeActionAddRepository: 'worktree-actions-menu-add-repo',
  worktreeActionCreateBranch: 'worktree-actions-menu-create-branch',
  worktreeActionToggleHidden: 'worktree-actions-menu-toggle-hidden',
  worktreeActionTogglePin: 'worktree-actions-menu-toggle-pin',
  worktreeActionMoveToOrganization:
    'worktree-actions-menu-move-to-organization',
  worktreeActionGrouping: 'worktree-actions-menu-toggle-grouping',
  worktreeNotifications: 'worktree-actions-menu-notifications',
  worktreeRemoval: 'worktree-actions-menu-archive',
  worktreeDeletion: 'worktree-actions-menu-delete',
  worktreeDirectRemoval: 'worktree-archive-button',
  worktreeDirectShow: 'worktree-show-button',
  coworkWorkspace: (workspaceId) => `sidebar-cowork-project-${workspaceId}`,
  standaloneChatRow: (chatId) => `sidebar-work-entry-${chatId}`,
};

/**
 * Place a desktop-only row menu item beside the shared item it belongs with
 * (Split project follows Add repository, as on the legacy row). Without that
 * item it goes ahead of the Hide and removal group, never after Delete.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function insertWorktreeMenuItemAfter(
  items: readonly WorktreeMenuItem[],
  item: WorktreeMenuItem,
  afterKey: WorktreeMenuItemKey,
): readonly WorktreeMenuItem[] {
  const anchor = items.findIndex((candidate) => candidate.key === afterKey);
  const index =
    anchor !== -1
      ? anchor + 1
      : items.findIndex((candidate) => candidate.separatorBefore === true);
  return index === -1
    ? [...items, item]
    : [...items.slice(0, index), item, ...items.slice(index)];
}

/** The PR states the shared Split PR gate knows; anything else is unknown. */
function knownPrState(
  state: string | undefined,
): 'open' | 'closed' | 'merged' | 'draft' | undefined {
  switch (state) {
    case 'open':
    case 'closed':
    case 'merged':
    case 'draft':
      return state;
    default:
      return undefined;
  }
}

/** A row control's test id, suffixed on a pinned copy of the row. */
function pinnedTestId(base: string, pinnedSurface: string | undefined): string {
  return pinnedSurface ? `${base}-${pinnedSurface}` : base;
}

// eslint-disable-next-line react-refresh/only-export-components
export function parseDesktopWorktreeSelection(
  selectionKey: string | null,
): Extract<SidebarSelection, { kind: 'worktree' }> | null {
  if (!selectionKey) return null;
  const separatorIndex = selectionKey.indexOf('/');
  if (separatorIndex < 1 || separatorIndex === selectionKey.length - 1) {
    return null;
  }
  return {
    kind: 'worktree',
    workspaceLocalId: selectionKey.slice(0, separatorIndex),
    worktreeLocalId: selectionKey.slice(separatorIndex + 1),
  };
}

export interface DesktopSelectionActions {
  readonly navigate: (page: 'main' | 'chat') => void;
  readonly openStandaloneChat: (workspaceId: string, chatId: string) => void;
  readonly selectWorkspace: (workspaceId: string) => void;
  readonly selectWorktree: (workspaceId: string, worktreeId: string) => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export function desktopArchivedCount(
  projects: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly archivedContainerCount?: number;
  }>,
  workspaceId: string,
): number | undefined {
  const project = projects.find((item) => item.id === workspaceId);
  return project?.type === 'cowork'
    ? undefined
    : project?.archivedContainerCount;
}

/**
 * Route empty deferred (`alwaysShow: false`) workspaces into the surface's
 * Hidden disclosure. The surface derives that bucket from the snapshot, which
 * main rebuilds only on invalidation; the store, which the archived-container
 * purge refreshes at once, is what decides emptiness here. Returns the input
 * snapshot untouched when nothing changes so memoized consumers keep their
 * identity.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function deferEmptyWorkspaces(
  snapshot: SessionViewModel,
  deferredEmptyWorkspaceIds: ReadonlySet<string>,
): SessionViewModel {
  if (deferredEmptyWorkspaceIds.size === 0) return snapshot;
  let changed = false;
  const workspaces = (snapshot.workspaces ?? []).map((workspace) => {
    if (
      workspace.hidden === true ||
      !deferredEmptyWorkspaceIds.has(workspace.localId)
    ) {
      return workspace;
    }
    changed = true;
    return { ...workspace, hidden: true };
  });
  return changed ? { ...snapshot, workspaces } : snapshot;
}

/** The store's minimal project shape the row-listing rule reads. */
interface StoreWorktreeListing {
  readonly id: string;
  readonly type: string;
  readonly worktrees?: ReadonlyArray<{ readonly id: string }>;
}

/**
 * The row-menu entries a snapshot row the projects store does not hold keeps:
 * read-only information only. Every other entry (label, pin, hide, removal,
 * grouping, split, repositories, launch, pipelines) persists through the store
 * and would fail for such a row.
 */
const NON_STORE_ROW_MENU_KEYS: ReadonlySet<string> = new Set([
  'branch-info',
  'debug-info',
]);

/**
 * Whether the rail lists a snapshot row. A desktop row the store has let go of
 * (its archive is in flight) leaves at once, as it did on the legacy list,
 * while the snapshot still carries it. A cloud row is never the store's (it
 * holds only this device's worktrees), so it is the snapshot's to list even
 * when its workspace id matches a store project; so are rows of workspaces the
 * store does not own.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isSnapshotWorktreeListed(
  projects: readonly StoreWorktreeListing[],
  worktree: {
    readonly workspaceLocalId: string;
    readonly localId: string;
    readonly backend?: string;
  },
): boolean {
  if (worktree.backend === 'cloud') return true;
  const project = projects.find(
    (item) => item.id === worktree.workspaceLocalId,
  );
  if (!project || project.type === 'cowork') return true;
  return (project.worktrees ?? []).some((item) => item.id === worktree.localId);
}

/**
 * Overlay the store-owned presentation bits the user toggles directly
 * (workspace collapse, worktree pin/hide) onto the session snapshot.
 *
 * The desktop snapshot is rebuilt by main on every structure change, and that
 * round-trip is what the surface would otherwise wait for before a collapsed
 * header or a pinned row moves: tens of milliseconds in a small fixture,
 * hundreds with a real workspace list. The projects store updates
 * synchronously on the same click, so reading these fields from it lets the
 * rail react immediately, the way the legacy rows (which read the store
 * directly) did. Returns the input snapshot untouched when nothing differs so
 * memoized consumers keep their identity.
 *
 * `pinnedProjectIds` lifts pinned projects to the top of the Projects list
 * (CAN-1074). Main projects each workspace at its persisted slot only, so
 * without it a pinned project never moved up the shared rail. The shared rail
 * otherwise keeps persisted order in either sort mode, so this is a stable
 * partition of that order: the store's projects take their own slots, pinned
 * ones first and each group in persisted order, and a workspace the store
 * does not own (an organization placeholder) keeps its slot.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function overlayStorePresentation(
  snapshot: SessionViewModel,
  projects: readonly SidebarItem[],
  pinnedProjectIds?: ReadonlySet<string>,
): SessionViewModel {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  let changed = false;
  // Partial snapshots (organization catalog placeholders, tests) may omit a
  // list; treat a missing list as empty rather than failing the overlay.
  const snapshotWorkspaces = snapshot.workspaces ?? [];
  const orderById = new Map<string, number>();
  if (pinnedProjectIds !== undefined && pinnedProjectIds.size > 0) {
    const owned = snapshotWorkspaces
      .filter((workspace) => projectById.has(workspace.localId))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    const slots = owned.map((workspace) => workspace.order ?? 0);
    const isPinned = (localId: string): boolean =>
      pinnedProjectIds.has(localId);
    [
      ...owned.filter((workspace) => isPinned(workspace.localId)),
      ...owned.filter((workspace) => !isPinned(workspace.localId)),
    ].forEach((workspace, index) => {
      const slot = slots[index];
      if (slot !== undefined) orderById.set(workspace.localId, slot);
    });
  }
  const workspaces = snapshotWorkspaces.map((workspace) => {
    const project = projectById.get(workspace.localId);
    const order = orderById.get(workspace.localId) ?? workspace.order;
    const collapsed =
      project === undefined
        ? workspace.collapsed === true
        : project.collapsed === true;
    if (
      order === workspace.order &&
      (workspace.collapsed === true) === collapsed
    ) {
      return workspace;
    }
    changed = true;
    return {
      ...workspace,
      ...(order === undefined ? {} : { order }),
      ...(project === undefined ? {} : { collapsed }),
    };
  });
  const worktreeById = new Map<string, WorktreeData>();
  for (const project of projects) {
    if (project.type === 'cowork') continue;
    for (const worktree of project.worktrees) {
      worktreeById.set(`${project.id}/${worktree.id}`, worktree);
    }
  }
  const worktrees = (snapshot.worktrees ?? []).map((worktree) => {
    const stored = worktreeById.get(
      `${worktree.workspaceLocalId}/${worktree.localId}`,
    );
    if (!stored) return worktree;
    const pinned = stored.pinned === true;
    const hidden = stored.hidden === true;
    if (
      (worktree.pinned === true) === pinned &&
      (worktree.hidden === true) === hidden
    ) {
      return worktree;
    }
    changed = true;
    return { ...worktree, pinned, hidden };
  });
  return changed ? { ...snapshot, workspaces, worktrees } : snapshot;
}

// eslint-disable-next-line react-refresh/only-export-components
export function routeDesktopSidebarSelection(
  selection: SidebarSelection,
  snapshot: SessionViewModel,
  actions: DesktopSelectionActions,
): void {
  if (!selection) return;
  if (selection.kind === 'worktree') {
    // A cloud task opens through the cowork work-entry seam, which picks its
    // page (CAN-6099; CAN-6175 moves it to the cowork page).
    if (isWebCoreScope(selection.workspaceLocalId)) {
      actions.openStandaloneChat(
        selection.workspaceLocalId,
        selection.worktreeLocalId,
      );
      return;
    }
    actions.selectWorktree(
      selection.workspaceLocalId,
      selection.worktreeLocalId,
    );
    actions.navigate('main');
    return;
  }
  if (selection.kind === 'workspace') {
    // `kind: 'workspace'` is not cowork-only by contract. The shared tree
    // header no longer selects its project from the name or badge (CAN-3053),
    // but a single-repo or multi-repo id arriving here by any other path must
    // still be refused. Those ids never appear in `chatProjects`, so routing
    // them on would spend a `chatProject.list()` self-heal and then throw
    // `Chat project not found`, which the sidebar helper now turns into a
    // toast telling the user to retry something that can never succeed.
    //
    // Read layout, not `type`: a cloud workspace classifies as `cowork` but
    // lays out as a tree and projects its chats into worktrees, so `type`
    // would route it to a chat page it does not have (REG-2819).
    const workspace = snapshot.workspaces?.find(
      (item) => item.localId === selection.workspaceLocalId,
    );
    if (!workspace) {
      // The shared surface renders its rows from this same snapshot, so a
      // rendered row is always resolvable and reaching here means the snapshot
      // and the selection disagree. That is a genuine inconsistency rather
      // than the expected tree-layout refusal below, so it leaves a trace: a
      // silent return is how "clicking the row does nothing" becomes
      // untriageable.
      reportRendererConsoleError(
        'Sidebar workspace selection had no snapshot row',
        { workspaceLocalId: selection.workspaceLocalId },
      );
      return;
    }
    // Desktop has no workspace-level view. The shared tree header stopped
    // offering the affordance (no `onSelectName`/`onSelectBadge`, CAN-3053);
    // this refusal stays as the backstop for any other caller.
    if (workspaceLayout(workspace) !== 'flat') return;
    actions.selectWorkspace(selection.workspaceLocalId);
    actions.navigate('chat');
    return;
  }
  const chat = snapshot.standaloneChats.find(
    (item) => item.localId === selection.standaloneChatId,
  );
  if (!chat) return;
  actions.openStandaloneChat(chat.projectLocalId, chat.localId);
  actions.navigate('chat');
}

/*
 * No `navItemActions` here on purpose. This host renders the workspaces
 * section nested inside AppSidebar (and inside the shadow panel) — AppSidebar
 * still owns the native main navigation above it — so supplying nav actions
 * would render a second, unstyled set of rows under the real ones. It gains
 * them only if the shared surface ever replaces the whole rail.
 */
export interface DesktopSharedSidebarHostProps {
  readonly client?: CanopyClient;
  readonly testIds?: SidebarSurfaceTestIds;
  readonly onSnapshot?: (snapshot: SessionViewModel) => void;
  readonly onRefreshMeasured?: (durationMs: number) => void;
  readonly worktreeDiffStatsStyle?: WorktreeDiffStatsStyle;
}

/** The Chats section's rows: desktop's Work Entry list for the catch-all. */
function DesktopChatsSectionRows({
  item,
  collapsed,
  listsNoneFoundWhenEmpty,
  workEntryMultiSelect,
}: {
  item: CoworkSidebarItem | undefined;
  collapsed: boolean;
  listsNoneFoundWhenEmpty: boolean;
  workEntryMultiSelect: WorkEntryMultiSelectBinding | undefined;
}): JSX.Element | null {
  if (!item) return null;
  return (
    <SidebarCoworkWorkspaceRow
      item={item}
      workEntryMultiSelect={workEntryMultiSelect}
      hideWorkspaceHeader
      sectionCollapsed={collapsed}
      disableDrag
      selectedPinSeat="chats"
      maxEntries={CHATS_SECTION_VISIBLE_ENTRIES}
      excludeFromWorkspaceList
      isTourAnchor
      listsNoneFoundWhenEmpty={listsNoneFoundWhenEmpty}
    />
  );
}

/** The Chats header's overflow rows: share, import, and sort. */
function DesktopChatsSectionMenuItems({
  item,
}: {
  item: CoworkSidebarItem | undefined;
}): JSX.Element | null {
  if (!item) return null;
  return (
    <SidebarChatsSectionMenuItems
      mode={item.itemSortMode}
      sortLabel={`Sort ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()} by`}
      onSort={(mode): void => {
        void useProjectsStore
          .getState()
          .setWorkspaceItemSortMode(item.id, mode);
      }}
      onShare={(): void => {
        useNavigationStore.getState().openWorkspaceSettingsModal({
          workspaceId: item.id,
          initialTab: 'share',
        });
      }}
      onImport={(): void => {
        useCloudConnectGateStore
          .getState()
          .requestConnect({}, () => openImportSessionModal(item.id));
      }}
    />
  );
}

// Bulk removal (CAN-3975): the shared rail runs one archive per confirmed
// worktree. It calls the store directly, not the single-slot navigation
// request the one-row confirm uses, so N requests never overwrite each other,
// and always after the batch's own confirm. Like the single row, the queue
// moves on once the row has left the sidebar (`onRowHidden`); main's Git
// removal and cleanup finish in the background, and a failure there rejects
// this promise, which the rail reports on its batch notice alone.
export const removeDesktopWorktreeInBatch = async (
  workspaceId: string,
  worktreeId: string,
  {
    mode,
    deleteBranch,
    expectedBranchName,
    onRowHidden,
  }: WorktreeBatchRemovalOptions,
): Promise<void> => {
  const project = useProjectsStore
    .getState()
    .projects.find((item) => item.id === workspaceId);
  const worktree =
    project && project.type !== 'cowork'
      ? project.worktrees.find((item) => item.id === worktreeId)
      : undefined;
  // The store returns without doing anything for an unknown worktree.
  if (!project || !worktree) throw new Error('Worktree was not found');
  const wasMerged = worktree.status === 'done' && project.type === 'multi-repo';
  try {
    // Rejects on failure after restoring the row (projectsStore test).
    await useProjectsStore.getState().archiveWorktree(workspaceId, worktreeId, {
      deleteBranch: deleteBranch === true,
      // The branch the batch confirm showed, as the single confirm passes
      // its target's: a branch that changed while queued is refused.
      expectedBranchName: expectedBranchName ?? worktree.branchName,
      ...(mode === 'archive' ? { lockAfterArchive: true } : {}),
      ...(mode === 'delete' ? { deleteWithoutRetentionIfMissing: true } : {}),
      ...(onRowHidden !== undefined ? { onUiRemoved: onRowHidden } : {}),
    });
  } catch (error) {
    if (error instanceof TeardownFailedError) {
      throw new Error('Teardown script failed. Try again from the row menu.');
    }
    const discard = await batchDiscardDescription(error, workspaceId);
    if (discard) throw new Error(worktreeDiscardBatchPointer(discard));
    throw error;
  }
  finishWorktreeArchive({
    projectId: workspaceId,
    worktreeId,
    refreshReferenceRepos: wasMerged,
  });
};

/**
 * CAN-5336 Q4: the batch never discards; a discardable refusal's row reason
 * points at the row menu instead. The source pre-check's refusal carries no
 * description, so it is described here; a failed read keeps the refusal.
 */
async function batchDiscardDescription(
  error: unknown,
  workspaceId: string,
): Promise<WorktreeDiscardDescription | null> {
  if (error instanceof WorktreeArchiveRefusalError) return error.discard;
  if (!(error instanceof WorktreeRemovalRefusedError)) return null;
  try {
    const description = await window.api.describeWorktreeDiscard({
      projectId: workspaceId,
      worktreeId: error.worktreeId,
    });
    return description.status === 'discardable' ? description : null;
  } catch {
    return null;
  }
}

// Bulk removal of Work Entries: the same store call the single-row confirm
// makes, awaited, so the runner removes one entry at a time.
export const removeDesktopWorkEntryInBatch: RemoveWorkEntryInBatch = async (
  workspaceId,
  entryId,
  { mode },
) =>
  useStandaloneChatStore.getState().deleteWorkEntry(entryId, workspaceId, {
    lockAfterArchive: mode === 'archive',
  });

/**
 * A Work Entry's batch facts, read live before each removal: gone when the
 * store no longer lists it, blocked while delegates or close-blocking
 * provider work still run in it. A chat that is only streaming does not
 * block, as on the single row.
 */
export const desktopWorkEntryBatchRemovalFacts: GetWorkEntryBatchRemovalFacts =
  (workspaceId, entryId) => {
    const exists = getSidebarProjectEntries(
      useStandaloneChatStore.getState(),
      workspaceId,
    ).some((entry) => entry.id === entryId);
    if (!exists) return undefined;
    const blockedReason = removalBlockedReason(
      getWorktreeRemovalBlocker(workspaceId, entryId),
    );
    return blockedReason === undefined ? {} : { blockedReason };
  };

/** The single row's Pin to top, awaited, with its failure toast. */
export const setDesktopWorkEntryPinned = (
  workspaceId: string,
  entryId: string,
  pinned: boolean,
): Promise<void> =>
  useStandaloneChatStore
    .getState()
    .setWorkEntryPinned(entryId, pinned, workspaceId)
    .catch(() => {
      useGitHubStore
        .getState()
        .addToast(pinned ? 'Failed to pin' : 'Failed to unpin', 'error');
    });

/** The single row's Mark done / Mark active, awaited; failures stay quiet as there. */
export const setDesktopWorkEntryStatus = (
  workspaceId: string,
  entryId: string,
  status: 'active' | 'done',
): Promise<void> =>
  useStandaloneChatStore
    .getState()
    .setWorkEntryStatus(entryId, status, workspaceId)
    .catch(() => undefined);

/** A Work Entry's pin and done state, read live; gone when the store drops it. */
export const desktopWorkEntryBulkState: GetWorkEntryBulkState = (
  workspaceId,
  entryId,
) => {
  const entry = getSidebarProjectEntries(
    useStandaloneChatStore.getState(),
    workspaceId,
  ).find((candidate) => candidate.id === entryId);
  return entry === undefined
    ? undefined
    : { pinned: entry.pinned === true, done: entry.status === 'done' };
};

export function DesktopSharedSidebarHost({
  client = ipcCanopyClient,
  testIds = DESKTOP_SHARED_SIDEBAR_TEST_IDS,
  onSnapshot,
  onRefreshMeasured,
  worktreeDiffStatsStyle = 'short',
}: DesktopSharedSidebarHostProps): JSX.Element | null {
  const model = useSidebarWorkspaces();
  const activity = useDesktopSidebarActivityHost(client);
  const groupsByScope = useSidebarItemGroupsStore((state) => state.byScope);
  const orderByScope = useSidebarItemGroupsStore((state) => state.orderByScope);
  useEffect(
    () =>
      window.api.sidebarItemGroups?.onChanged((scope) => {
        void useSidebarItemGroupsStore
          .getState()
          .hydrate(scope)
          .catch((error: unknown) =>
            reportRendererConsoleError('Sidebar item groups refresh failed', {
              error,
            }),
          );
      }),
    [],
  );
  const [sharedWithMeExpanded, setSharedWithMeExpanded] = useState(true);
  // Context scoping (CAN-2954): the shared list hides rows owned by another
  // context once the org-projects flag is on, and an organization with no
  // rows explains itself instead of rendering nothing.
  const workspaceContextState = useWorkspaceContextStore(
    useShallow((state) => state.state),
  );
  const orgProjectsEnabled = useCanopyOrgProjectsEnabled();
  // Link to cloud project (CAN-5190) needs the account's project identity.
  const projectIdentityAvailable = useCanopyProjectIdentityAvailable();
  // Move to organization is offered from Personal only, and only once the
  // member belongs to an organization; `canMoveToOrganization` adds the
  // per-project checks.
  const workspaceMoveToOrganization =
    orgProjectsEnabled &&
    workspaceContextState.context.kind === 'personal' &&
    workspaceContextState.organizations.length > 0;
  const scopingContext = model.scopingContext;
  // Native background clones as the shared pending project rows (CAN-3591).
  // The progress pill and modal keep reporting the same jobs.
  const pendingProjects = useDesktopPendingProjects(scopingContext);
  const chatsWorkspaceState = useOrgDefaultChatsWorkspace(scopingContext);
  const chatsWorkspace = chatsWorkspaceState.workspace;
  // Lets a collapsed Chats section keep its selected chat's row.
  const chatsSectionHasSelectedRow =
    useSelectedCoworkEntryId(chatsWorkspace?.id) !== null;
  // The default cowork project renders in the Chats section, not Projects, so
  // it must not appear in the Projects visibility list — the same exclusion the
  // legacy section makes.
  const filterWorkspaceOptions = useMemo(
    () =>
      model.filterWorkspaceOptions.filter(
        (option) => !isDefaultCoworkWorkspaceId(option.id),
      ),
    [model.filterWorkspaceOptions],
  );
  // Any hidden project keeps the header control (and its dot) on screen:
  // nothing else in the sidebar reports that a filter is active.
  const projectsFiltered = useMemo(
    () =>
      filterWorkspaceOptions.some((option) =>
        model.hiddenWorkspaceIds.includes(option.id),
      ),
    [filterWorkspaceOptions, model.hiddenWorkspaceIds],
  );
  // The legacy Projects header carries "Import session…" only while a single
  // project owns that header; with more than one, each row has its own menu
  // and the entry would be ambiguous.
  //
  // Derived from `visibleProjects` — the RENDERED list — which is what the
  // legacy header counts. `sortedProjects` also contains projects hidden
  // automatically for being empty, and counting those made one rendered
  // project look like two and took the entry away.
  const soleVisibleProject = useMemo(() => {
    const listed = model.visibleProjects.filter(
      (project) => !isDefaultCoworkWorkspaceId(project.id),
    );
    return listed.length === 1 ? listed[0] : null;
  }, [model.visibleProjects]);
  const scopingOrganizationName =
    scopingContext?.kind === 'organization'
      ? workspaceContextLabel(
          scopingContext,
          workspaceContextState.organizations,
          'this organization',
        )
      : null;
  const [snapshot, setSnapshot] = useState<SessionViewModel | null>(null);
  const [snapshotFailures, setSnapshotFailures] = useState(0);
  // Branch Info stays desktop's git-aware dialog (rename, base branch, repo
  // membership) rather than the shared label-only sheet; the surface hands
  // the request here and renders nothing of its own.
  const [branchInfoTarget, setBranchInfoTarget] = useState<{
    readonly workspaceId: string;
    readonly worktreeId: string;
    /** Open straight into the label field (the row's Set label action). */
    readonly labelEdit?: boolean;
  } | null>(null);
  const branchInfoProject = branchInfoTarget
    ? model.sortedProjects.find(
        (project) => project.id === branchInfoTarget.workspaceId,
      )
    : undefined;
  const branchInfoWorktree =
    branchInfoProject && branchInfoProject.type !== 'cowork'
      ? branchInfoProject.worktrees.find(
          (worktree) => worktree.id === branchInfoTarget?.worktreeId,
        )
      : undefined;
  // Worktree removal confirms the way the legacy row did: Delete on a row
  // with no local work runs at once; anything else (and every Archive) opens
  // desktop's confirmation with the branch-handling choice. Chat surfaces
  // request that same confirmation for a worktree through a window event.
  const [removalConfirm, setRemovalConfirm] = useState<{
    readonly target: WorktreeArchiveConfirmationTarget;
    readonly mode: WorktreeRemovalMode;
    readonly requestedDeleteBranch?: boolean;
  } | null>(null);
  const splitLockedWorktrees = useGitHubStore(
    (state) => state.splitLockedWorktrees,
  );
  const removalInputs = (
    workspaceId: string,
    worktreeId: string,
  ): {
    readonly project: SidebarItem;
    readonly worktree: WorktreeData;
    readonly deleteAction: DeleteAction;
    readonly stats: DiffStats | undefined;
    readonly hasLocalWork: boolean;
    readonly hasLineChanges: boolean;
    readonly archiveInProgress: boolean;
    readonly splitLocked: boolean;
    readonly retentionDays: number;
  } | null => {
    const project = model.sortedProjects.find(
      (item) => item.id === workspaceId,
    );
    if (!project || project.type === 'cowork') return null;
    const worktree = project.worktrees.find((item) => item.id === worktreeId);
    if (!worktree) return null;
    const key = createDiffStatsKey(workspaceId, worktreeId);
    const stats = model.diffStats[key];
    const hasLineChanges =
      stats !== undefined && stats.insertions + stats.deletions > 0;
    const archiveInProgress = model.archivingWorktrees.has(key);
    return {
      project,
      worktree,
      deleteAction: getDeleteAction({
        isDone: worktree.status === 'done',
        hasActiveSession: model.activeSessionWorktreeKeys.has(key),
        isArchiveInProgress: archiveInProgress,
        isPendingGitSetup: worktree.setupPhase === 'git-pending',
        isRunningSetup: model.setupRunningWorktrees.has(key),
        isTearingDown: model.tearingDownWorktrees.has(key),
        stats,
        hasUncommittedChanges: model.uncommittedChanges[key],
        hasCommitsAhead: model.commitsAhead[key],
        hasUnpushedCommits: model.hasUnpushedCommits[key],
      }),
      stats,
      hasLocalWork:
        model.uncommittedChanges[key] === true ||
        hasLineChanges ||
        model.commitsAhead[key] === true ||
        model.hasUnpushedCommits[key] === true,
      hasLineChanges,
      archiveInProgress,
      splitLocked: splitLockedWorktrees.has(key),
      retentionDays: resolveArchiveRetentionDays(
        project.type,
        project.archiveRetentionDays ?? undefined,
      ),
    };
  };
  const requestRemoval = (
    workspaceId: string,
    worktreeId: string,
    label: string,
    mode: WorktreeRemovalMode,
    source: 'row' | 'external',
    requestedDeleteBranch?: boolean,
  ): boolean => {
    const inputs = removalInputs(workspaceId, worktreeId);
    if (!inputs) return false;
    // An external request (App Advisor's `worktree.archive`) is promised a
    // confirmation dialog, so it always gets one, opened on the branch choice
    // as the legacy row did: the dialog shows a blocked state for a disabled
    // or in-flight removal, and a clean worktree is never removed without the
    // user confirming. Only a direct row gesture takes the silent paths below.
    const external = source === 'external';
    if (
      !external &&
      (inputs.deleteAction === 'disabled' || inputs.archiveInProgress)
    ) {
      return true;
    }
    if (!external && mode === 'delete' && inputs.deleteAction === 'delete') {
      model.onArchiveWorktree(workspaceId, worktreeId, {
        deleteWithoutRetentionIfMissing: true,
      });
      return true;
    }
    setRemovalConfirm({
      target: {
        workspaceId,
        workspaceName: inputs.project.name,
        worktreeId,
        worktreeName: label,
        worktreeCreatedAt: inputs.worktree.createdAt,
        branchName: inputs.worktree.branchName,
      },
      mode,
      ...(external && requestedDeleteBranch !== undefined
        ? { requestedDeleteBranch }
        : {}),
    });
    return true;
  };
  const worktreeBatchRemovalFacts = (
    workspaceId: string,
    worktreeId: string,
  ): WorktreeBatchRemovalFacts | undefined => {
    const inputs = removalInputs(workspaceId, worktreeId);
    if (!inputs) return undefined;
    const key = createDiffStatsKey(workspaceId, worktreeId);
    // The single-row menu's reasons, so the two can't drift apart.
    const blockedReason = worktreeRemovalBlockedReason({
      removalInProgress: inputs.archiveInProgress,
      removalLockedBySplitPr: inputs.splitLocked,
      hasActiveSession: inputs.deleteAction === 'disabled',
    });
    return {
      localWork: {
        ...(inputs.hasLineChanges && inputs.stats
          ? {
              insertions: inputs.stats.insertions,
              deletions: inputs.stats.deletions,
            }
          : {}),
        uncommitted: model.uncommittedChanges[key] === true,
        unpushed:
          model.hasUnpushedCommits[key] === true ||
          model.commitsAhead[key] === true,
      },
      ...(blockedReason === undefined ? {} : { blockedReason }),
    };
  };
  const [batchRemovalState, setBatchRemovalState] =
    useState<WorktreeBatchRemovalUiState | null>(null);
  useCurrentUiStateReporter(
    'worktree.batchRemovalDialog',
    batchRemovalState === null ? null : { ...batchRemovalState },
  );
  const [workEntryBatchState, setWorkEntryBatchState] =
    useState<SidebarBatchRemovalUiState | null>(null);
  // The App Advisor nav reports its own dialog under its own key, so this
  // rail closing never clears the nav's open dialog, or the reverse.
  useCurrentUiStateReporter(
    'workEntry.batchRemovalDialog',
    workEntryBatchState === null ? null : { ...workEntryBatchState },
  );
  const requestRemovalRef = useRef(requestRemoval);
  requestRemovalRef.current = requestRemoval;
  useEffect(
    () =>
      subscribeToWorktreeArchiveConfirmationRequests((request) => {
        const project = model.sortedProjects.find(
          (item) => item.id === request.projectId,
        );
        if (!project || project.type === 'cowork') return false;
        const worktree = project.worktrees.find(
          (item) => item.id === request.worktreeId,
        );
        if (!worktree) return false;
        return requestRemovalRef.current(
          request.projectId,
          request.worktreeId,
          worktree.label?.trim() || worktree.branchName,
          request.lockAfterArchive === true ? 'archive' : 'delete',
          'external',
          request.requestedDeleteBranch,
        );
      }),
    [model.sortedProjects],
  );
  const removalConfirmInputs = removalConfirm
    ? removalInputs(
        removalConfirm.target.workspaceId,
        removalConfirm.target.worktreeId,
      )
    : null;
  const removalIdentityMatches =
    removalConfirm !== null &&
    removalConfirmInputs !== null &&
    removalConfirmInputs.project.name === removalConfirm.target.workspaceName &&
    removalConfirmInputs.worktree.createdAt ===
      removalConfirm.target.worktreeCreatedAt &&
    removalConfirmInputs.worktree.branchName ===
      removalConfirm.target.branchName;
  const branchInfoKey = branchInfoTarget
    ? createDiffStatsKey(
        branchInfoTarget.workspaceId,
        branchInfoTarget.worktreeId,
      )
    : null;
  // Collapsing the whole Projects group. The shared surface has always been
  // able to do this, but only behind an opt-in the desktop host never passed,
  // so the shared rail had no way to put the list away while the legacy rail
  // did. Backed by the SAME store key the legacy section uses, so the choice
  // is one setting rather than one per rail, and it survives a reload.
  const projectsCollapsed = useSidebarStore((s) => s.codeSectionCollapsed);
  const setProjectsCollapsed = useSidebarStore(
    (s) => s.setCodeSectionCollapsed,
  );
  // The projects whose header gets desktop's context menu: the ones the host
  // has rows for (not cowork, not catalog placeholders).
  const contextMenuWorkspaceIds = useMemo(
    (): ReadonlySet<string> =>
      new Set(
        model.sortedProjects
          .filter((project) => project.type !== 'cowork')
          .map((project) => project.id),
      ),
    [model.sortedProjects],
  );
  // Projects pinned to the top of the list: their headers carry the pin mark.
  const pinnedWorkspaceIds = useMemo(
    (): ReadonlySet<string> =>
      new Set(
        model.sortedProjects
          .filter((project) => project.pinned === true)
          .map((project) => project.id),
      ),
    [model.sortedProjects],
  );
  // The rows the rail should actually render. Without this the menu was pure
  // bookkeeping: hiding a project lit the header dot but left the row on
  // screen, because `SidebarSurface` admits every workspace when
  // `visibleWorkspaceIds` is undefined. The snapshot carries its own
  // `workspace.hidden` flag too, but that is rebuilt from preferences only
  // when something stales the snapshot, and saving a preference does not — so
  // the filter is applied from the store that just changed.
  //
  // Built from `snapshot.workspaces`, because that is the exact collection the
  // surface partitions and it is keyed by `localId`. Deriving it from the
  // host's own project list instead produced an id space the surface does not
  // use, and the allow-list then admitted nothing at all.
  //
  // The legacy rule for a deferred (temporary) workspace applies here too: it
  // lists only while it has visible content, read from the store, which is
  // what the archived-container purge refreshes.
  const deferredEmptyWorkspaceIds = useMemo(
    (): ReadonlySet<string> =>
      new Set(
        model.sortedProjects
          .filter(
            (project) =>
              project.alwaysShow === false &&
              !hasVisibleWorkspaceContent(project),
          )
          .map((project) => project.id),
      ),
    [model.sortedProjects],
  );
  // An empty deferred workspace moves to the Hidden disclosure, as the legacy
  // list's `hiddenProjects` did, rather than leaving the rail with no way back.
  const storeProjects = useProjectsStore((state) => state.projects);
  // Early access: rows take the name of the chat that started them (labels
  // the user set still win); the second line stays the worktree's name.
  const earlyAccess = useLabsExperimentEnabled('sidebar');
  const worktreeRowNamings = useWorktreeRowNamings(earlyAccess);
  const rowNamingFor = (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ): WorktreeRowNaming =>
    worktreeRowNamings[`${workspaceLocalId}/${worktreeLocalId}`] ??
    DEFAULT_ROW_NAMING;
  const localSurfaceSnapshot = useMemo((): SessionViewModel | null => {
    if (!snapshot) return snapshot;
    const projected = deferEmptyWorkspaces(
      overlaySidebarItemGroups(
        overlayStorePresentation(snapshot, storeProjects, pinnedWorkspaceIds),
        groupsByScope,
        orderByScope,
      ),
      deferredEmptyWorkspaceIds,
    );
    if (
      !chatsWorkspaceState.pending ||
      !chatsWorkspace ||
      scopingContext?.kind !== 'organization' ||
      projected.workspaces.some(
        (workspace) => workspace.localId === chatsWorkspace?.id,
      )
    ) {
      return projected;
    }
    return {
      ...projected,
      workspaces: [
        {
          localId: chatsWorkspace.id,
          name: chatsWorkspace.name,
          type: 'cowork',
          layout: 'flat',
          color: chatsWorkspace.color,
          order: chatsWorkspace.order,
          owner: {
            type: 'organization',
            organizationId: scopingContext.organizationId,
            projectId: 'pending-default-chats',
          },
        },
        ...projected.workspaces,
      ],
    };
  }, [
    snapshot,
    deferredEmptyWorkspaceIds,
    storeProjects,
    pinnedWorkspaceIds,
    groupsByScope,
    orderByScope,
    chatsWorkspace,
    chatsWorkspaceState.pending,
    scopingContext,
  ]);
  const cloudSidebar = useCloudCoworkSidebar();
  const cloudRows = cloudSidebar.status === 'online' ? cloudSidebar.rows : null;
  const surfaceSnapshot = useMemo(
    (): SessionViewModel | null =>
      localSurfaceSnapshot && cloudRows
        ? {
            ...localSurfaceSnapshot,
            ...appendCloudSidebarRows(localSurfaceSnapshot, cloudRows),
          }
        : localSurfaceSnapshot,
    [localSurfaceSnapshot, cloudRows],
  );
  const cloudRowKind = useCallback(
    (localId: string): CloudSidebarRowKind => {
      const project = cloudRows?.workspaces.find(
        (workspace) => workspace.localId === localId,
      );
      if (project === undefined) return 'task';
      return project.type === 'cowork' ? 'cowork' : 'git';
    },
    [cloudRows],
  );
  const visibleWorkspaceIds = useMemo((): ReadonlySet<string> => {
    const hidden = new Set(model.hiddenWorkspaceIds);
    return new Set(
      (surfaceSnapshot?.workspaces ?? [])
        .map((workspace) => workspace.localId)
        .filter((localId) => !hidden.has(localId)),
    );
  }, [surfaceSnapshot?.workspaces, model.hiddenWorkspaceIds]);
  // The rows' live attention state, from the same model derivation the
  // legacy rail rendered. Published to `useDesktopRowLiveKeysStore` (a small
  // external store, not React Context) so each row reads only its own
  // derived attention through a per-row selector. This isolates PUBLISHES to
  // that store: when `setDesktopRowLiveKeys` fires, only a row whose own
  // derived attention actually changed re-renders as a direct result of that
  // publish. It does not isolate rows from an ordinary React re-render of
  // this host/the surface above them (a snapshot refresh, any other store
  // this host subscribes to) — every row still re-renders once for that,
  // same as before this store existed. In the common case (something changes
  // on one row) every row therefore renders once, and the changed row renders
  // twice (once for the host's own re-render, once for the store publish);
  // see `desktopWorktreeRowOverrides`.
  const rowLiveKeys = useMemo(
    (): DesktopWorktreeRowLiveKeys => ({
      statusByKey: model.worktreeStatusMap,
      streaming: model.streamingWorktreeKeys,
      awaitingApproval: model.awaitingApprovalKeys,
      pendingQuestion: model.pendingQuestionWorktreeKeys,
      toolApproval: model.toolApprovalWorktreeKeys,
      unread: model.unreadWorktreeKeys,
      pipelineRunning: model.pipelineRunningWorktreeKeys,
      pipelineUnseen: model.unseenPipelineWorktreeKeys,
      pipelineUnseenFailed: model.unseenFailedPipelineWorktreeKeys,
      pipelinePaused: model.pipelinePausedWorktreeKeys,
      backgroundTasks: model.backgroundTaskCounts,
    }),
    [
      model.worktreeStatusMap,
      model.streamingWorktreeKeys,
      model.awaitingApprovalKeys,
      model.pendingQuestionWorktreeKeys,
      model.toolApprovalWorktreeKeys,
      model.unreadWorktreeKeys,
      model.pipelineRunningWorktreeKeys,
      model.unseenPipelineWorktreeKeys,
      model.unseenFailedPipelineWorktreeKeys,
      model.pipelinePausedWorktreeKeys,
      model.backgroundTaskCounts,
    ],
  );
  useEffect(() => {
    setDesktopRowLiveKeys(rowLiveKeys);
  }, [rowLiveKeys]);
  // The published store is a module-level singleton outliving this
  // component's own lifetime, so a remount (the shape an account/session
  // change takes) must not let its first render see the PREVIOUS mount's
  // last-published keys before this mount's own effect above republishes.
  useEffect(() => resetDesktopRowLiveKeys, []);
  const refreshState = useRef<{
    client: CanopyClient;
    active: boolean;
    inFlight: boolean;
    pending: boolean;
  } | null>(null);
  const onSnapshotRef = useRef(onSnapshot);
  const onRefreshMeasuredRef = useRef(onRefreshMeasured);
  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
    onRefreshMeasuredRef.current = onRefreshMeasured;
  });
  // Share/invite: the row action and the App Advisor's request both open the
  // invite modal for one worktree; an exclusive request for another closes it.
  const sharedContainerInviteVisible = useSharedContainerEntryPointVisible();
  const sharedWorktrees = useSharedContainersStore(
    (state) => state.sharedWorktrees,
  );
  const [inviteTarget, setInviteTarget] = useState<{
    readonly workspaceId: string;
    readonly worktreeId: string;
  } | null>(null);
  const inviteScopingContext = useSidebarScopingContext();
  const inviteScopingContextKey =
    inviteScopingContext === undefined
      ? null
      : serializeWorkspaceContext(inviteScopingContext);
  const previousInviteScopingContextRef = useRef(inviteScopingContext);
  const inviteContextTransitionRef = useRef<WorkspaceContext | undefined>(
    undefined,
  );
  const previousInviteScopingContext = previousInviteScopingContextRef.current;
  const contextChangedThisRender =
    previousInviteScopingContext !== undefined &&
    inviteScopingContext !== undefined &&
    serializeWorkspaceContext(previousInviteScopingContext) !==
      inviteScopingContextKey;
  const previousContextForInvite = contextChangedThisRender
    ? previousInviteScopingContext
    : inviteContextTransitionRef.current;
  useEffect(() => {
    const previousContext = previousInviteScopingContextRef.current;
    previousInviteScopingContextRef.current = inviteScopingContext;
    if (
      previousContext === undefined ||
      inviteScopingContext === undefined ||
      serializeWorkspaceContext(previousContext) === inviteScopingContextKey
    ) {
      return;
    }
    inviteContextTransitionRef.current = previousContext;
  }, [inviteScopingContext, inviteScopingContextKey]);
  useEffect(() => {
    if (!sharedContainerInviteVisible) return undefined;
    return subscribeToSharedContainerInviteRequests(
      (request) => {
        if (request.containerType !== 'CODE_WORKTREE') return false;
        const project = model.sortedProjects.find(
          (item) => item.id === request.projectId,
        );
        if (
          !project ||
          project.type === 'cowork' ||
          !project.worktrees.some(
            (worktree) => worktree.id === request.worktreeId,
          )
        ) {
          return false;
        }
        inviteContextTransitionRef.current = undefined;
        setInviteTarget({
          workspaceId: request.projectId,
          worktreeId: request.worktreeId,
        });
        return true;
      },
      (request) => {
        setInviteTarget((current) =>
          current &&
          (current.workspaceId !== request.projectId ||
            current.worktreeId !== request.worktreeId ||
            request.containerType !== 'CODE_WORKTREE')
            ? null
            : current,
        );
      },
    );
  }, [model.sortedProjects, sharedContainerInviteVisible]);
  const inviteWorktree = inviteTarget
    ? ((): WorktreeData | undefined => {
        const project = model.sortedProjects.find(
          (item) => item.id === inviteTarget.workspaceId,
        );
        return project && project.type !== 'cowork'
          ? project.worktrees.find(
              (worktree) => worktree.id === inviteTarget.worktreeId,
            )
          : undefined;
      })()
    : undefined;
  // The Chats collapse is a preference on desktop, not the catch-all's flag.
  const chatsSectionCollapsed = useSidebarStore(
    (state) => state.chatsSectionCollapsed,
  );
  const setChatsSectionCollapsed = useSidebarStore(
    (state) => state.setChatsSectionCollapsed,
  );
  const activePage = useNavigationStore((state) => state.activePage);
  const homeWorkspaceId = useHomeComposerStore((state) => state.workspaceId);
  const activeChatProjectId = useStandaloneChatStore(
    (state) => state.activeChatProjectId,
  );
  const activeWorkEntryId = useStandaloneChatStore(
    (state) => state.activeWorkEntryId,
  );
  const pendingReveal = useProjectsStore(
    (state) => state.pendingScrollToWorktree,
  );
  const archivedByWorkspace = useArchivedContainersStore(
    (state) => state.byWorkspace,
  );
  const archivedProjectId = useArchivedContainersStore(
    (state) => state.viewer?.workspaceId ?? state.overview?.workspaceId,
  );
  const loadedArchivedWorkspaces = useArchivedContainersStore(
    (state) => state.loadedWorkspaces,
  );
  const splitPrFeatureEnabled = useCanopyDesktopPrSplitEnabled();
  const { splitPrEnabled, splitPrThresholdLines } =
    useSplitPrGatingPreferences();
  // Split PR eligibility and blockers read the live PR status, as the legacy
  // row's `useSplitPrReadiness` did; subscribing here re-derives the menu when
  // a poll lands.
  const prStatuses = useGitHubStore((state) => state.prStatuses);
  // Launch reads the worktree's scripts and whether its launch already runs,
  // from an index of active runs that carries no script output.
  const appliedProjectWorktreeScripts = useProjectsStore(
    (state) => state.appliedProjectWorktreeScripts,
  );
  const activeScriptRuns = useScriptsStore(
    useShallow((state) => indexActiveScriptRuns(state.runs)),
  );
  // Worktrees whose menu offers Stop running scripts: a run still running,
  // not one already stopping.
  const stoppableScriptWorktreeKeys = useScriptsStore(
    useShallow((state) => worktreesWithStoppableScripts(state.runs)),
  );
  const stoppableScriptWorktrees = useMemo(
    () => new Set(stoppableScriptWorktreeKeys),
    [stoppableScriptWorktreeKeys],
  );
  // Every code worktree's launch script, resolved once per project or script
  // change rather than per row per render (the legacy adapter memoized each
  // row's the same way).
  const launchEntries = useMemo((): ReadonlyMap<string, ScriptEntry> => {
    const entries = new Map<string, ScriptEntry>();
    for (const project of model.sortedProjects) {
      if (project.type === 'cowork') continue;
      for (const worktree of project.worktrees) {
        const entry = resolveWorktreeLaunchEntry(
          project,
          worktree.id,
          appliedProjectWorktreeScripts,
        );
        if (entry) entries.set(worktreeKey(project.id, worktree.id), entry);
      }
    }
    return entries;
  }, [model.sortedProjects, appliedProjectWorktreeScripts]);
  const launchEntryFor = (
    workspaceId: string,
    worktreeId: string,
  ): ScriptEntry | undefined =>
    launchEntries.get(worktreeKey(workspaceId, worktreeId));
  const isLaunchRunning = (workspaceId: string, worktreeId: string): boolean =>
    isWorktreeLaunchActiveInIndex(
      launchEntryFor(workspaceId, worktreeId),
      activeScriptRuns,
      worktreeKey(workspaceId, worktreeId),
    );
  const splitPrStores = {
    ...splitPrReadinessStoreAccessors,
    getPrStatus: (
      workspaceId: string,
      worktreeId: string,
    ): WorktreePrStatus | null | undefined =>
      prStatuses[worktreeKey(workspaceId, worktreeId)],
    getGatingPreferences: (): {
      splitPrEnabled: boolean;
      splitPrThresholdLines: number;
    } => ({ splitPrEnabled, splitPrThresholdLines }),
  };
  const spaceNotificationProps = useSpaceNotificationSidebarProps();
  const capabilities = useMemo<CanopyCapabilities>(
    () => ({
      ...client.capabilities,
      workspaceCreation: 'full',
      workspaceReordering: true,
      worktreeReordering: true,
      itemGrouping: true,
      worktreePinning: true,
      workspaceSettings: 'full',
      worktreeRemoval: 'archive',
      // Desktop keeps both transitions: Delete retains the container for the
      // retention window, Archive locks it until the user deletes it.
      worktreeRetention: 'archive-or-delete',
      worktreeSplitPr: splitPrFeatureEnabled,
      worktreeBranchGrouping: model.branchGroupingEnabled,
      worktreeRepositoryAttachment: true,
      workspaceMoveToOrganization,
    }),
    [
      client.capabilities,
      model.branchGroupingEnabled,
      splitPrFeatureEnabled,
      workspaceMoveToOrganization,
    ],
  );
  const refresh = useCallback(async (): Promise<void> => {
    const state = refreshState.current;
    if (!state?.active || state.client !== client) return;
    if (state.inFlight) {
      state.pending = true;
      return;
    }
    state.inFlight = true;
    try {
      do {
        state.pending = false;
        const startedAt = performance.now();
        try {
          const next = await client.query('session.snapshot', {});
          if (!state.active) return;
          if (state.pending) continue;
          setSnapshot(next);
          onSnapshotRef.current?.(next);
          onRefreshMeasuredRef.current?.(performance.now() - startedAt);
        } catch (error) {
          if (!state.active) return;
          // Keep the native path available while a snapshot is unavailable.
          reportRendererConsoleError('Shared sidebar snapshot refresh failed', {
            error,
          });
          if (!state.pending) setSnapshotFailures((count) => count + 1);
        }
      } while (state.active && state.pending);
    } finally {
      state.inFlight = false;
    }
  }, [client]);

  useEffect(() => {
    const state = { client, active: true, inFlight: false, pending: false };
    refreshState.current = state;
    const unsubscribe = client.subscribe('session.snapshot-stale', () => {
      void refresh();
    });
    void refresh();
    return (): void => {
      state.active = false;
      unsubscribe();
    };
  }, [client, refresh]);
  // Until a first snapshot lands the rail shows "Loading projects", and the
  // only other re-pull is a stale event that may never come. Retry a failed
  // initial load with capped backoff so a transient failure cannot leave the
  // rail loading forever.
  useEffect(() => {
    if (snapshot || snapshotFailures === 0) return;
    const delayMs = Math.min(1_000 * 2 ** (snapshotFailures - 1), 30_000);
    const timer = setTimeout(() => void refresh(), delayMs);
    return (): void => clearTimeout(timer);
  }, [snapshot, snapshotFailures, refresh]);
  // The legacy rail re-rendered from the projects store directly; the shared
  // rail reads the session snapshot, so a structural store change (a
  // workspace or worktree added, removed, or re-flagged) re-pulls it rather
  // than waiting for a main-side invalidation that may not exist for it.
  // Pin and hide stay in the key even though `overlayStorePresentation` shows
  // them at once: the pin handler persists without notifying the snapshot, so
  // this re-pull is what keeps the snapshot itself current.
  const projectsStructureKey = useMemo(
    () =>
      model.sortedProjects
        .map((project) =>
          [
            project.id,
            project.type,
            project.alwaysShow === false ? 'temp' : '',
            project.type === 'cowork'
              ? ''
              : project.worktrees
                  .map(
                    (worktree) =>
                      `${worktree.id}${worktree.pinned === true ? '*' : ''}${
                        worktree.hidden === true ? '~' : ''
                      }${worktree.status === 'done' ? '!' : ''}${
                        worktree.branchGroupingOverride ?? ''
                      }>${worktree.branchGroupingParentWorktreeId ?? ''}`,
                  )
                  .join(','),
          ].join(':'),
        )
        .join('|'),
    [model.sortedProjects],
  );
  const projectsStructureKeyRef = useRef(projectsStructureKey);
  useEffect(() => {
    if (projectsStructureKeyRef.current === projectsStructureKey) return;
    projectsStructureKeyRef.current = projectsStructureKey;
    void refresh();
  }, [projectsStructureKey, refresh]);

  // On the Orchestrator page (docked in this window) its own sidebar row is
  // the selection, so no project row is.
  const appAdvisorDocked = useAppAdvisorStore(
    (s) => s.open && s.layout === 'docked',
  );
  const selection = useMemo<SidebarSelection>(() => {
    if (appAdvisorDocked) return null;
    if (activePage === 'main') {
      return parseDesktopWorktreeSelection(model.selectedWorktreeKey);
    }
    if (activePage === 'chat' && activeWorkEntryId) {
      // A cloud task is a worktree row in the shared list (CAN-6099).
      return isWebCoreScope(activeChatProjectId)
        ? {
            kind: 'worktree',
            workspaceLocalId: activeChatProjectId,
            worktreeLocalId: activeWorkEntryId,
          }
        : { kind: 'standalone-chat', standaloneChatId: activeWorkEntryId };
    }
    return activeChatProjectId
      ? { kind: 'workspace', workspaceLocalId: activeChatProjectId }
      : null;
  }, [
    activeChatProjectId,
    activePage,
    activeWorkEntryId,
    appAdvisorDocked,
    model.selectedWorktreeKey,
  ]);
  const selectionActions = useMemo<DesktopSelectionActions>(
    () => ({
      navigate: useNavigationStore.getState().navigate,
      openStandaloneChat: (workspaceId, chatId): void => {
        openCoworkWorkEntryFromSidebar(workspaceId, chatId);
      },
      selectWorkspace: (workspaceId): void => {
        selectCoworkWorkspaceFromSidebar(workspaceId);
      },
      selectWorktree: model.onSelectWorktree,
    }),
    [model.onSelectWorktree],
  );
  // Rows the list shows as cloud-backed, keyed `<workspace>/<worktree>`:
  // the snapshot's own and the web core's appended to it.
  const cloudWorktreeKeys = useMemo(
    (): ReadonlySet<string> =>
      new Set(
        (surfaceSnapshot?.worktrees ?? [])
          .filter((worktree) => worktree.backend === 'cloud')
          .map(
            (worktree) => `${worktree.workspaceLocalId}/${worktree.localId}`,
          ),
      ),
    [surfaceSnapshot?.worktrees],
  );
  const isStoreWorktree = (workspaceId: string, worktreeId: string): boolean =>
    model.sortedProjects.some(
      (project) =>
        project.id === workspaceId &&
        project.type !== 'cowork' &&
        project.worktrees.some((worktree) => worktree.id === worktreeId),
    );
  // Snapshot rows the store does not hold, by local id (the key the surface's
  // per-row capability lookup uses).
  const nonStoreWorktreeIds = useMemo(
    (): ReadonlySet<string> =>
      new Set(
        (snapshot?.worktrees ?? [])
          .filter(
            (worktree) =>
              !model.sortedProjects.some(
                (project) =>
                  project.id === worktree.workspaceLocalId &&
                  project.type !== 'cowork' &&
                  project.worktrees.some(
                    (item) => item.id === worktree.localId,
                  ),
              ),
          )
          .map((worktree) => worktree.localId),
      ),
    [snapshot?.worktrees, model.sortedProjects],
  );
  const createLocalWorktree = async (
    workspaceId: string,
    groupId: string | undefined,
  ): Promise<WorktreeCreateResult> => {
    const created = groupId
      ? await useProjectsStore.getState().createWorktree(workspaceId, {
          sidebarItemGroupId: groupId,
          onRegistered: (worktree): void =>
            model.onSelectWorktree(workspaceId, worktree.id),
        })
      : await model.onCreateWorktree(workspaceId);
    if (
      !created &&
      useProjectsStore.getState().pendingWorkspaceRepair?.workspaceId ===
        workspaceId
    )
      return { status: 'pending' };
    if (!created) {
      const error = inlineFailureText(
        useProjectsStore.getState().worktreeError,
      );
      if (error && summarizeCommandFailure(error).summary !== '')
        throw new WorktreeCreationNoticeError(error);
      throw new Error('Worktree could not be created. Try again.');
    }
    return { status: 'completed', worktreeId: created.id };
  };
  const handleSelect = useCallback(
    (next: SidebarSelection): void => {
      // Choosing a row leaves the Orchestrator page, even the row that was
      // selected before it opened.
      const appAdvisor = useAppAdvisorStore.getState();
      if (appAdvisor.open && appAdvisor.layout === 'docked') {
        appAdvisor.closeDialog();
      }
      if (snapshot) {
        routeDesktopSidebarSelection(next, snapshot, selectionActions);
      }
    },
    [selectionActions, snapshot],
  );

  // Catalog placeholders are not workspaces — `partitionWorkspaces` drops them
  // — so on this path the host, not the shared list, has to render them. The
  // native `SidebarWorkspacesSection` is not mounted when the shared sidebar
  // is on, and the surface would otherwise show an organization's catalog as
  // an empty list (CAN-2955).
  const additionalRows = (
    <>
      {model.setupDialog}
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
      <CloudCoworkOfflineRow model={cloudSidebar} />
      <SharedContainerSidebarSection
        expanded={sharedWithMeExpanded}
        onExpandedChange={setSharedWithMeExpanded}
      />
    </>
  );

  if (!snapshot) {
    return (
      <div
        className="group/section min-h-px"
        data-testid="sidebar-section-code"
      >
        <DelayedLoadingPlaceholder slowNote="Still loading projects…">
          <SidebarRailSkeleton
            testId="sidebar-section-code-loading"
            rowStatusPlacement={earlyAccess ? 'leading' : 'trailing'}
          />
        </DelayedLoadingPlaceholder>
      </div>
    );
  }
  return (
    <>
      <SidebarSurface
        // Drawer SHAPE — this mounts inside the rail's own scroll area and must
        // fill it rather than become a second fixed-width column. But the rail
        // is a mouse-and-keyboard surface, so it takes rail SIZING: without the
        // explicit pointer, `variant` alone forced 44px touch rows on desktop.
        variant="drawer"
        context={scopingContext}
        renderContextEmptyState={({ chatsListed }) => (
          <SidebarContextEmptyState
            chatsListed={chatsListed}
            organizationName={scopingOrganizationName ?? 'this organization'}
            organizationId={
              scopingContext?.kind === 'organization'
                ? scopingContext.organizationId
                : undefined
            }
          />
        )}
        additionalRows={additionalRows}
        pendingProjects={pendingProjects}
        linkedPersonalWorkspaceIds={model.linkedPersonalWorkspaceIds}
        pointer="fine"
        // This host nests the surface INSIDE `AppSidebar`, which already renders
        // the rail's New Task entry point and its More menu. Default `'full'`
        // chrome would contribute a second set directly above the Projects
        // header — and with no `onCreateTask` to supply, that second New Task
        // button renders permanently disabled. `'navigation-only'` suppresses
        // exactly those two controls and leaves rows, the Workspaces header and
        // the served nav keys untouched. Remove this when the shared surface
        // takes over the whole rail and there is no native set to duplicate.
        chrome="navigation-only"
        // AppSidebar owns the rail's scroll viewport, its custom scrollbar, the
        // sticky-rail sync and the selected-item pin. A second scroll container
        // here would capture the sticky headers and double the row indent.
        scrollOwner="host"
        snapshot={surfaceSnapshot ?? snapshot}
        selection={selection}
        activity={activity}
        projectListRetainedWorkspaceIds={[
          archivedProjectId,
          activePage === 'chat' ? activeChatProjectId : null,
          activePage === 'home' ? homeWorkspaceId : null,
          ...Array.from(model.recentlyAddedProjectIds),
        ]}
        capabilities={capabilities}
        contentState={
          (surfaceSnapshot ?? snapshot).workspaces.length ||
          scopingContext?.kind === 'organization'
            ? 'ready'
            : 'empty'
        }
        worktreeDiffStatsStyle={worktreeDiffStatsStyle}
        // Live row state from the renderer stores, run inside each row. This
        // isolates re-renders caused by the live-keys store PUBLISHING a new
        // value — a row whose own derived attention is unchanged skips that
        // particular re-render. It does not make rows immune to an ordinary
        // parent re-render (this host or the surface above it re-rendering
        // for any other reason still re-renders every row once).
        useWorktreeRowOverrides={useDesktopWorktreeRowOverrides}
        // The runs behind a row's pipeline badge, from the renderer's run
        // store (the same list the legacy row's popover showed). Falls back
        // to a stable shared empty array, not a fresh `[]` literal — see
        // `EMPTY_PIPELINE_POPOVER_ENTRIES`.
        getPipelinePopoverEntries={(worktreeId, workspaceId) =>
          usePipelineRunsStore.getState().pipelineSummariesByWorktree[
            createDiffStatsKey(workspaceId, worktreeId)
          ] ?? EMPTY_PIPELINE_POPOVER_ENTRIES
        }
        // Keeps an open popover live: a run's job list or status can change
        // (or a new run start) while the row's own aggregate pipelineStatus
        // badge does not, so a `getState()`-only read would leave the open
        // popover showing a stale list until it is closed and reopened.
        subscribePipelinePopoverEntries={(
          _worktreeId,
          _workspaceId,
          onChange,
        ) => usePipelineRunsStore.subscribe(onChange)}
        onSelect={handleSelect}
        onWorktreeIntent={(projectId, worktreeId, phase, source): void => {
          // Cloud rows read through their own path, not the local chat store.
          if (
            !shouldPrefetchWorktreeChat(
              projectId,
              worktreeId,
              cloudWorktreeKeys,
            )
          )
            return;
          const target: ChatPrefetchTarget = {
            kind: 'worktree',
            projectId,
            worktreeId,
          };
          if (phase === 'start') noteChatIntent(target, source);
          else endChatIntent(target);
        }}
        {...spaceNotificationProps}
        onOpenCreateWorkspaceOverride={() => {
          useNavigationStore.getState().openAddWorkspaceModal();
          return true;
        }}
        onOpenWorkspaceSettingsOverride={(workspaceId) => {
          // A cloud project opens the shared settings its capabilities allow.
          if (isWebCoreScope(workspaceId)) return false;
          model.onOpenSettings(workspaceId);
          return true;
        }}
        // Only cloud projects reach these: a local project's settings are
        // the desktop's own modal, opened by the override above.
        onUpdateWorkspace={async (workspaceId, patch) => {
          if (!isWebCoreScope(workspaceId) || cloudSidebar.status !== 'online')
            throw new Error("Couldn't save the project. Try again.");
          await cloudSidebar.updateProject(workspaceId, patch);
        }}
        onDeleteWorkspace={async (workspaceId) => {
          if (!isWebCoreScope(workspaceId) || cloudSidebar.status !== 'online')
            throw new Error("Couldn't delete the project. Try again.");
          await cloudSidebar.deleteProject(workspaceId);
        }}
        workspaceDangerCopy={(workspaceId) =>
          isWebCoreScope(workspaceId) ? CLOUD_PROJECT_DANGER_COPY : undefined
        }
        onConfirmWorktreeRemovalOverride={(
          workspaceId,
          worktreeId,
          label,
          mode,
        ) =>
          requestRemoval(
            workspaceId,
            worktreeId,
            label,
            mode ?? 'delete',
            'row',
          )
        }
        // Branch grouping input, as the legacy section built it: the diff-stats
        // base branch, falling back to the tracked base so a fresh "Branch
        // from" worktree groups at once. Pinned rows keep their parent here;
        // the sections paint them flat (a pinned row leads the section) while
        // the menu and depth badges keep the true structure.
        getBranchGrouping={(workspace) => {
          const project = model.sortedProjects.find(
            (item) => item.id === workspace.localId,
          );
          if (!project || project.type === 'cowork') return undefined;
          const baseBranchByWorktreeId = new Map<
            string,
            string | null | undefined
          >();
          const defaultBranches = new Set<string>();
          for (const worktree of project.worktrees) {
            const key = createDiffStatsKey(project.id, worktree.id);
            baseBranchByWorktreeId.set(
              worktree.id,
              key in model.baseBranches
                ? model.baseBranches[key]
                : resolveTrackedBaseBranchFallback(project.type, worktree),
            );
            const defaultBranch = model.defaultBranches[key]?.trim();
            if (defaultBranch) defaultBranches.add(defaultBranch);
          }
          const overrideByWorktreeId = new Map<
            string,
            'group' | 'ungroup' | null | undefined
          >();
          const retainedParentByWorktreeId = new Map<
            string,
            string | null | undefined
          >();
          for (const worktree of project.worktrees) {
            retainedParentByWorktreeId.set(
              worktree.id,
              worktree.branchGroupingParentWorktreeId,
            );
            overrideByWorktreeId.set(
              worktree.id,
              worktree.branchGroupingOverride,
            );
          }
          return {
            defaultBranches,
            groupingEnabled: model.branchGroupingEnabled,
            baseBranchByWorktreeId,
            overrideByWorktreeId,
            retainedParentByWorktreeId,
          };
        }}
        isWorkspacePinned={(workspaceId) => pinnedWorkspaceIds.has(workspaceId)}
        // Desktop's dialog is git-aware and reads the projects store, so it
        // takes only the rows the store holds; any other row (a cloud session
        // projected into the rail) keeps the shared sheet.
        onBranchInfoRequestedOverride={(workspaceId, worktreeId) => {
          if (!isStoreWorktree(workspaceId, worktreeId)) return false;
          setBranchInfoTarget({ workspaceId, worktreeId });
          return true;
        }}
        // Setup and teardown runs live in the renderer's stores, not in the
        // snapshot; rows read them here so "Running teardown" shows.
        // A row the store has let go of (its archive is in flight) leaves the
        // rail at once, as it did on the legacy list, even while the snapshot
        // still carries it. Rows the store never listed (cloud catalog rows,
        // cloud sessions) are left to the snapshot.
        isWorktreeListed={(workspaceId, worktreeId) =>
          // The teardown label shows first: the store keeps the row through
          // it, and lets go only once the removal is committed.
          isSnapshotWorktreeListed(model.sortedProjects, {
            workspaceLocalId: workspaceId,
            localId: worktreeId,
            backend: cloudWorktreeKeys.has(`${workspaceId}/${worktreeId}`)
              ? 'cloud'
              : undefined,
          })
        }
        isWorktreeShared={(workspaceId, worktreeId) =>
          Boolean(sharedWorktrees[sharedWorktreeKey(workspaceId, worktreeId)])
        }
        getWorktreeSetupPhase={(workspaceId, worktreeId) => {
          const key = createDiffStatsKey(workspaceId, worktreeId);
          if (model.tearingDownWorktrees.has(key)) return 'running-teardown';
          if (model.setupRunningWorktrees.has(key)) return 'running-setup';
          return undefined;
        }}
        // From the removal click until the store lets the row go (teardown
        // included), the row is muted and inert with no Delete chip, as the
        // legacy row did.
        isWorktreeRemovalInProgress={(workspaceId, worktreeId) => {
          const key = createDiffStatsKey(workspaceId, worktreeId);
          return (
            model.archivingWorktrees.has(key) ||
            model.tearingDownWorktrees.has(key)
          );
        }}
        // Share (invite a teammate) sits after Branch info, as on the legacy
        // row, whenever shared containers are available to this account.
        getWorktreeExtraMenuItems={(workspaceId, worktreeId) =>
          sharedContainerInviteVisible &&
          isStoreWorktree(workspaceId, worktreeId)
            ? [
                {
                  key: 'invite',
                  label: 'Share',
                  icon: <ShareIcon />,
                  onSelect: (): void => {
                    inviteContextTransitionRef.current = undefined;
                    setInviteTarget({
                      workspaceId,
                      worktreeId,
                    });
                  },
                  testId: 'worktree-actions-menu-invite',
                },
              ]
            : []
        }
        // Delete's menu tooltip names the project's retention window, as the
        // legacy row's did.
        worktreeRetentionDaysFor={(workspaceId) => {
          const project = model.sortedProjects.find(
            (item) => item.id === workspaceId,
          );
          return project && project.type !== 'cowork'
            ? resolveArchiveRetentionDays(
                project.type,
                project.archiveRetentionDays ?? undefined,
              )
            : undefined;
        }}
        // Launch runs the worktree's launch script; while it runs the row's
        // id becomes its stop control, both as on the legacy row.
        isLaunchAvailable={(worktreeId, workspaceId) =>
          launchEntryFor(workspaceId, worktreeId) !== undefined
        }
        isLaunchRunning={(worktreeId, workspaceId) =>
          isLaunchRunning(workspaceId, worktreeId)
        }
        onLaunchWorktree={(workspaceId, worktreeId) => {
          const launchEntry = launchEntryFor(workspaceId, worktreeId);
          if (!launchEntry || isLaunchRunning(workspaceId, worktreeId)) return;
          runWorktreeLaunch(workspaceId, worktreeId, launchEntry);
        }}
        hasRunningScripts={(worktreeId, workspaceId) =>
          stoppableScriptWorktrees.has(worktreeKey(workspaceId, worktreeId))
        }
        onStopRunningScripts={(workspaceId, worktreeId) => {
          void stopWorktreeScripts(workspaceId, worktreeId);
        }}
        renderWorktreeIdSlot={({ workspace, worktree, pinnedSurface }) =>
          contextMenuWorkspaceIds.has(workspace.localId) ? (
            <WorktreeLaunchIdSlot
              projectId={workspace.localId}
              worktreeId={worktree.localId}
              testId={pinnedTestId('worktree-row-stop-launch', pinnedSurface)}
            />
          ) : undefined
        }
        deriveWorktreeRowLabel={({ workspace, worktree }) =>
          contextMenuWorkspaceIds.has(workspace.localId)
            ? rowNamingFor(workspace.localId, worktree.localId).title
            : undefined
        }
        // Desktop's own Dispatch Pipeline dialog: it lists the pipelines and
        // picks the working directory (project root or a child repo).
        onDispatchPipelineRequested={model.onDispatchPipeline}
        // Every desktop row mutation persists through the projects store, so a
        // row the store does not hold (a cloud session projected into the
        // rail) offers only what needs no store row. The surface drops the
        // hover shortcuts of the rows removed here. A non-store row can never
        // be a temporary multi-repo project, so Split project (below) only
        // ever applies to the store-backed rows that survive this filter.
        // Split project is desktop-only (the portal wire carries no temporary
        // multi-repo state), so the host adds it after Add repository.
        transformWorktreeMenuItems={(
          { workspace, worktree, pinnedSurface },
          incomingItems,
        ) => {
          const items = isStoreWorktree(workspace.localId, worktree.localId)
            ? incomingItems
            : incomingItems.filter((item) =>
                NON_STORE_ROW_MENU_KEYS.has(item.key),
              );
          const project = model.sortedProjects.find(
            (item) => item.id === workspace.localId,
          );
          if (project?.type !== 'multi-repo' || project.temporary !== true) {
            return items;
          }
          const stored = project.worktrees.find(
            (item) => item.id === worktree.localId,
          );
          if (!stored) return items;
          const key = createDiffStatsKey(project.id, stored.id);
          const { disabled, tooltip } = getSplitWorkspaceMenuState({
            hasActiveSession: model.activeSessionWorktreeKeys.has(key),
            hasActivePipelines:
              model.pipelineRunningWorktreeKeys.has(key) ||
              model.pipelinePausedWorktreeKeys.has(key),
            isDone: stored.status === 'done',
            isPendingGitSetup: stored.setupPhase === 'git-pending',
            isRunningSetup: model.setupRunningWorktrees.has(key),
          });
          return insertWorktreeMenuItemAfter(
            items,
            {
              key: 'split-workspace',
              label: 'Split project',
              icon: <SplitIcon />,
              onSelect: (): void =>
                model.onSplitTemporaryWorkspace(project.id, stored.id),
              disabled,
              tooltip,
              testId: pinnedTestId(
                'worktree-actions-menu-split-workspace',
                pinnedSurface,
              ),
            },
            'add-repository',
          );
        }}
        onSetLabelRequestedOverride={(workspaceId, worktreeId) => {
          if (!isStoreWorktree(workspaceId, worktreeId)) return false;
          setBranchInfoTarget({ workspaceId, worktreeId, labelEdit: true });
          return true;
        }}
        // Reorder persists through the store too, so such a row is not
        // sortable. Keyed by local id, as the surface resolves it.
        capabilitiesFor={(localId) =>
          isWebCoreScope(localId)
            ? cloudSidebarRowCapabilities(capabilities, cloudRowKind(localId))
            : nonStoreWorktreeIds.has(localId)
              ? {
                  ...capabilities,
                  worktreeReordering: false,
                  itemGrouping: false,
                }
              : capabilities
        }
        itemGroupCommandsFor={(workspaceId) => {
          const project = model.sortedProjects.find(
            (project) => project.id === workspaceId,
          );
          if (!project || project.type === 'cowork') return undefined;
          const scope = { workspaceLocalId: workspaceId };
          const store = useSidebarItemGroupsStore.getState();
          const report = (error: unknown): void =>
            useGitHubStore
              .getState()
              .addToast(
                error instanceof Error
                  ? error.message
                  : 'Group changes could not be saved. Try again.',
                'error',
              );
          return {
            create: (itemId): ReturnType<typeof store.create> =>
              store.create({ scope, itemId }),
            update: (groupId, patch): Promise<void> =>
              store.update({ scope, groupId, ...patch }).catch(report),
            ungroup: (groupId): void => {
              void store.ungroup({ scope, groupId }).catch(report);
            },
            moveItem: (itemId, drop): void => {
              const latest = useProjectsStore
                .getState()
                .projects.find((project) => project.id === workspaceId);
              if (
                latest &&
                latest.type !== 'cowork' &&
                latest.worktrees.find((row) => row.id === itemId)?.pinned
              ) {
                const pins = latest.worktrees.filter(
                  (row) => row.pinned && !row.hidden,
                );
                const remainder = pins.filter((row) => row.id !== itemId);
                const index = drop.before
                  ? remainder.findIndex((row) => row.id === drop.before)
                  : drop.after
                    ? remainder.findIndex((row) => row.id === drop.after) + 1
                    : -1;
                const target = index >= 0 ? pins[index]?.id : undefined;
                if (target)
                  void useProjectsStore
                    .getState()
                    .reorderWorktrees(workspaceId, itemId, target)
                    .catch(report);
                return;
              }
              void store
                .moveItem({
                  scope,
                  itemId,
                  groupId: drop.groupId,
                  ...(drop.before
                    ? { before: drop.before }
                    : drop.after
                      ? { after: drop.after }
                      : {}),
                })
                .catch(report);
            },
            moveGroup: (groupId, drop): void => {
              void store
                .moveGroup({
                  scope,
                  groupId,
                  ...(drop.before
                    ? { before: drop.before }
                    : drop.after
                      ? { after: drop.after }
                      : {}),
                })
                .catch(report);
            },
          };
        }}
        onGroupError={(_workspaceId, error): void => {
          const navigation = useNavigationStore.getState();
          const archive = useArchivedContainersStore.getState();
          const shared = useSharedContainerReplicasStore.getState();
          // WorktreeErrorNotice sits over every page in the main frame; only
          // the overlays that cover that frame can hide it, and a covered
          // notice cannot own the visible failure.
          const archiveCoversNotice = [archive.viewer, archive.overview].some(
            (entry) =>
              entry !== null &&
              entry.workspaceId !== APP_ADVISOR_PROJECT_ID &&
              !isCoworkChatTarget(entry.workspaceId),
          );
          if (
            error instanceof WorktreeCreationNoticeError &&
            inlineFailureText(useProjectsStore.getState().worktreeError) ===
              error.message &&
            !navigation.settingsOpen &&
            !useSidebarPageHandoffStore.getState().coversMainShell &&
            !archiveCoversNotice &&
            shared.viewer === null &&
            !shared.pastSharesOpen
          )
            return;
          useGitHubStore
            .getState()
            .addToast(
              error instanceof Error
                ? error.message
                : 'Group changes could not be saved. Try again.',
              'error',
            );
        }}
        onCreateWorktree={(workspaceId, groupId) => {
          if (isWebCoreScope(workspaceId))
            return cloudSidebar.status === 'online'
              ? cloudSidebar.createTask(workspaceId)
              : Promise.reject(new Error('Cloud chats are offline.'));
          return createLocalWorktree(workspaceId, groupId);
        }}
        onCreateBranchWorktree={model.onCreateBranchWorktree}
        onArchiveWorktree={(workspaceId, worktreeId) => {
          model.onArchiveWorktree(workspaceId, worktreeId);
        }}
        onRemoveWorktreeInBatch={removeDesktopWorktreeInBatch}
        getWorktreeBatchRemovalFacts={worktreeBatchRemovalFacts}
        worktreeBatchBranchChoice
        onWorktreeBatchRemovalStateChange={setBatchRemovalState}
        onRemoveWorkEntryInBatch={removeDesktopWorkEntryInBatch}
        getWorkEntryBatchRemovalFacts={desktopWorkEntryBatchRemovalFacts}
        getWorkEntryBulkState={desktopWorkEntryBulkState}
        onSetWorkEntryPinned={setDesktopWorkEntryPinned}
        onSetWorkEntryStatus={setDesktopWorkEntryStatus}
        workEntryRetentionDaysFor={(workspaceId) =>
          resolveArchiveRetentionDays(
            'cowork',
            model.sortedProjects.find((project) => project.id === workspaceId)
              ?.archiveRetentionDays ?? undefined,
          )
        }
        onWorkEntryBatchRemovalStateChange={setWorkEntryBatchState}
        onUpdateWorktree={(workspaceId, worktreeId, patch) => {
          if (patch.hidden !== undefined) {
            model.onSetWorktreeHidden(workspaceId, worktreeId, patch.hidden);
          }
          if (patch.pinned !== undefined) {
            void useProjectsStore
              .getState()
              .setWorktreePinned(workspaceId, worktreeId, patch.pinned);
          }
        }}
        chatsSectionCollapsed={chatsSectionCollapsed}
        // Early access: Chats rows show their last-activity age.
        showChatActivityAge={earlyAccess}
        chatsRowStatusPlacement={earlyAccess ? 'leading' : 'trailing'}
        compactListDisclosures={earlyAccess}
        hideWorkspaceCounts={earlyAccess}
        worktreeRowGap={earlyAccess ? 'hairline' : undefined}
        compactWorktreeHoverActions={earlyAccess}
        sentenceCaseMenuLabels={earlyAccess}
        worktreeHoverPreview={earlyAccess}
        onChatsSectionCollapsedChange={setChatsSectionCollapsed}
        // Desktop's cowork row toggled on its name and opened chats from its
        // entries; keep that so a header click never leaves the page.
        workspaceNameTogglesCollapse
        // The rail's sticky band (More stays a sibling above): the Projects
        // header, the selected-row pin hosts, and the workspace header slot,
        // in the flow after the Chats section as the legacy section had it.
        renderProjectsBand={(header) => (
          <StickyWorkspaceControls workspaceHeader={header} />
        )}
        onWorkspaceCollapsedChange={(workspaceId, collapsed) => {
          if (isWebCoreScope(workspaceId)) {
            if (cloudSidebar.status === 'online')
              cloudSidebar.setCollapsed(workspaceId, collapsed);
            return;
          }
          // Read the store directly: the Chats catch-all is not in the
          // model's project lists, and its collapse persists the same way.
          const project = useProjectsStore
            .getState()
            .projects.find((item) => item.id === workspaceId);
          if (project?.collapsed !== collapsed)
            model.onToggleCollapsed(workspaceId);
        }}
        onReorderWorkspaces={(activeId, overId) =>
          routeSidebarReorder(activeId, overId, {
            local: model.onReorderProjects,
            ...(cloudSidebar.status === 'online'
              ? {
                  cloud: (active: string, over: string): void =>
                    cloudSidebar.reorder(
                      active,
                      over,
                      cloudSidebar.rows.workspaces
                        .filter((workspace) =>
                          snapshotWorkspaceMatchesContext(
                            workspace,
                            scopingContext,
                          ),
                        )
                        .map((workspace) => workspace.localId),
                    ),
                }
              : {}),
          })
        }
        onReorderWorktrees={model.onReorderWorktrees}
        branchGroupingEnabled={model.branchGroupingEnabled}
        onSetBranchGroupingOverride={model.onSetBranchGroupingOverride}
        // Split PR's gate, from the same live PR status the legacy row read:
        // eligibility first (open single-repo PR over the threshold), then the
        // blockers that keep an eligible Split PR visible but disabled.
        getSplitPrEligibilityInputs={(workspaceId, worktreeId) => {
          const workspace = model.sortedProjects.find(
            (item) => item.id === workspaceId,
          );
          const inputs = deriveSplitPrEligibilityInputs({
            prStatus: splitPrStores.getPrStatus(workspaceId, worktreeId),
            diffStats: splitPrStores.getDiffStats(workspaceId, worktreeId),
            splitPrEnabled,
            thresholdLines: splitPrThresholdLines,
            isSingleRepo: workspace?.type === 'single-repo',
          });
          return { ...inputs, prState: knownPrState(inputs.prState) };
        }}
        getSplitPrBlockers={(workspaceId, worktreeId) => {
          const workspace = model.sortedProjects.find(
            (item) => item.id === workspaceId,
          );
          return gatherSplitPrReadinessInputs(
            workspaceId,
            worktreeId,
            workspace?.type === 'single-repo',
            splitPrStores,
          ).blockers.map((blocker) => SPLIT_PR_BLOCKER_COPY[blocker]);
        }}
        onSplitPrRequested={(workspaceId, worktreeId) => {
          model.onSelectWorktree(workspaceId, worktreeId);
          useActivityStore
            .getState()
            .openSplitPreflight(workspaceId, worktreeId);
        }}
        isAddRepositoryAvailable={() => true}
        onMoveWorkspaceToOrganizationRequested={openMoveToOrganizationModal}
        isWorkspaceMoveToOrganizationAvailable={canMoveToOrganization}
        hasActiveWorktreeSession={(workspaceId, worktreeId) =>
          model.activeSessionWorktreeKeys.has(`${workspaceId}/${worktreeId}`)
        }
        // The legacy row's rule for showing Delete on a row that is not done:
        // clean (no line changes, nothing uncommitted, ahead, or unpushed) or
        // created moments ago with its stats still loading. Removal already in
        // flight hides the chip rather than greying it.
        isDirectRemovalAvailable={(workspaceId, worktreeId) => {
          const key = createDiffStatsKey(workspaceId, worktreeId);
          if (model.archivingWorktrees?.has(key)) return false;
          const project = model.sortedProjects.find(
            (item) => item.id === workspaceId,
          );
          if (!project || project.type === 'cowork') return false;
          const worktree = project.worktrees.find(
            (item) => item.id === worktreeId,
          );
          if (!worktree) return false;
          return canShowStandaloneDeleteButton({
            isDone: worktree.status === 'done',
            isPendingGitSetup: worktree.setupPhase === 'git-pending',
            isRunningSetup: model.setupRunningWorktrees.has(key),
            isTearingDown: model.tearingDownWorktrees.has(key),
            stats: model.diffStats[key],
            hasUncommittedChanges: model.uncommittedChanges[key],
            hasCommitsAhead: model.commitsAhead[key],
            hasUnpushedCommits: model.hasUnpushedCommits[key],
            isFreshWorktree: isWorktreeFresh(worktree.createdAt),
          });
        }}
        // The project header's right-click menu (its hover "…" opens the same
        // one): the legacy header's rows, verbatim, so the ids and order the
        // suite pins survive the rail swap. Pin leads every sidebar item menu.
        isWorkspaceContextMenuAvailable={(workspaceId) =>
          contextMenuWorkspaceIds.has(workspaceId)
        }
        renderWorkspaceContextMenuItems={({ workspace, close }) => {
          const project = model.sortedProjects.find(
            (item) => item.id === workspace.localId,
          );
          if (!project || project.type === 'cowork') return null;
          const createWorktreeDisabled =
            project.type === 'multi-repo' && project.repos.length === 0;
          // The action rows take the action-menu rows (small text, tertiary
          // icons); the sort group keeps its own rows and checks.
          return (
            <>
              <ActionMenuRowStyle>
                <SidebarPinMenuItem
                  testId="workspace-toggle-pin-menu-item"
                  pinned={project.pinned === true}
                  onToggle={(pinned): void => {
                    close();
                    void useProjectsStore
                      .getState()
                      .setWorkspacePinned(project.id, pinned);
                  }}
                />
                <DropdownMenuItem
                  data-testid="workspace-new-task-menu-item"
                  disabled={createWorktreeDisabled}
                  title={createWorktreeDisabled ? 'Add repos first' : undefined}
                  onClick={(): void => {
                    if (createWorktreeDisabled) return;
                    close();
                    void model.onCreateWorktree(project.id);
                  }}
                >
                  <DropdownMenuItemIcon>
                    <AssignmentAddIcon />
                  </DropdownMenuItemIcon>
                  <span className="truncate">New task</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="workspace-settings-menu-item"
                  onClick={(): void => {
                    close();
                    model.onOpenSettings(project.id);
                  }}
                >
                  <DropdownMenuItemIcon>
                    <SettingsIcon />
                  </DropdownMenuItemIcon>
                  <span className="truncate">Project settings</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="workspace-import-session-menu-item"
                  onClick={(): void => {
                    close();
                    useCloudConnectGateStore
                      .getState()
                      .requestConnect({}, () => {
                        openImportSessionModal(project.id);
                      });
                  }}
                >
                  <DropdownMenuItemIcon>
                    <DownloadIcon />
                  </DropdownMenuItemIcon>
                  <span className="truncate">Import session…</span>
                </DropdownMenuItem>
                {workspaceMoveToOrganization &&
                canMoveToOrganization(project.id) ? (
                  <DropdownMenuItem
                    data-testid="workspace-move-to-organization-menu-item"
                    onClick={(): void => {
                      close();
                      openMoveToOrganizationModal(project.id);
                    }}
                  >
                    <DropdownMenuItemIcon>
                      <BuildingIcon size="xl" />
                    </DropdownMenuItemIcon>
                    <span className="truncate">Move to org…</span>
                  </DropdownMenuItem>
                ) : null}
                {projectIdentityAvailable === true &&
                canLinkCloudProject(project.id) ? (
                  <DropdownMenuItem
                    data-testid="workspace-link-cloud-project-menu-item"
                    onClick={(): void => {
                      close();
                      void openLinkCloudProjectModal(project.id);
                    }}
                  >
                    <DropdownMenuItemIcon>
                      <LinkIcon size="xl" />
                    </DropdownMenuItemIcon>
                    <span className="truncate">Link to cloud…</span>
                  </DropdownMenuItem>
                ) : null}
              </ActionMenuRowStyle>
              <SidebarSortMenuItems
                mode={project.itemSortMode}
                testIdPrefix="workspace-item-sort"
                label="Sort tasks by"
                onSelect={(mode): void => {
                  close();
                  void useProjectsStore
                    .getState()
                    .setWorkspaceItemSortMode(project.id, mode);
                }}
              />
            </>
          );
        }}
        onAddRepositoryRequested={model.onAddRepoToWorktreeAdhoc}
        // The Chats section's HEADER is the shared one; only its rows are
        // desktop's, because desktop's Chats bucket holds multi-chat Work
        // Entries and the portal wire carries flat chats. That divergence is a
        // wire-model decision, not a UI gap, and is explicitly out of this
        // campaign's scope — so the seam is the rows and nothing else.
        // The "+" and the overflow menu the desktop Chats header has always
        // carried. The controls themselves are the shared surface's; these are
        // only the actions behind them, which are desktop-specific (a Work Entry
        // rather than a flat chat; a session import that runs through the cloud
        // connect gate).
        onCreateChatsSectionChat={() => {
          openNewCoworkTaskFromSidebar(
            defaultCoworkWorkspaceIdForContext(scopingContext),
            { pending: chatsWorkspaceState.pending },
          );
        }}
        // The Projects header's overflow menu. Sort order and session import are
        // ordinary parity; the visibility list is the one that has to be here,
        // because hiding a project is the only sidebar state the rows cannot
        // report, and without this control it cannot be undone.
        workspacesSectionCollapsible
        workspacesSectionInitiallyCollapsed={projectsCollapsed}
        onWorkspacesSectionCollapsedChange={setProjectsCollapsed}
        visibleWorkspaceIds={visibleWorkspaceIds}
        workspacesSectionFiltered={projectsFiltered}
        // Keep the "+" on screen while a project is hidden, as the legacy
        // section did.
        addWorkspaceRevealed={model.hiddenWorkspaceIds.length > 0}
        addWorkspaceButtonDataAttrs={{
          'data-onboarding-anchor': 'workspace-add',
        }}
        renderWorkspacesSectionMenuItems={(closeMenu) => (
          <>
            <SidebarSortMenuItems
              mode={model.projectSortMode}
              testIdPrefix="sidebar-projects-sort"
              label="Sort projects by"
              onSelect={(mode) => {
                model.onSetProjectSortMode(mode);
                // Picking a sort mode is a command, not a multi-select: dismiss
                // the menu and hand focus back, as the Chats header does.
                closeMenu();
              }}
              divider={false}
              dividerAfter={Boolean(soleVisibleProject)}
            />
            {soleVisibleProject && (
              <ActionMenuRowStyle>
                <DropdownMenuItem
                  data-testid="workspace-import-session-menu-item"
                  onClick={(): void => {
                    closeMenu();
                    useCloudConnectGateStore
                      .getState()
                      .requestConnect({}, () =>
                        openImportSessionModal(soleVisibleProject.id),
                      );
                  }}
                >
                  <DropdownMenuItemIcon>
                    <DownloadIcon />
                  </DropdownMenuItemIcon>
                  <span className="truncate">Import session…</span>
                </DropdownMenuItem>
              </ActionMenuRowStyle>
            )}
            <SidebarProjectVisibilityMenuItems
              options={filterWorkspaceOptions}
              hiddenWorkspaceIds={model.hiddenWorkspaceIds}
              onChange={model.onFilterChange}
            />
          </>
        )}
        chatsSectionPending={chatsWorkspaceState.pending}
        renderChatsSectionMenuItems={() => (
          <DesktopChatsSectionMenuItems item={chatsWorkspace} />
        )}
        renderChatsSectionRows={({ collapsed, workEntryMultiSelect }) => (
          <DesktopChatsSectionRows
            item={chatsWorkspace}
            collapsed={collapsed}
            workEntryMultiSelect={workEntryMultiSelect}
            // An organization's empty Chats reads like its empty Projects
            // list (CAN-3550).
            listsNoneFoundWhenEmpty={scopingContext?.kind === 'organization'}
          />
        )}
        chatsSectionHasSelectedRow={chatsSectionHasSelectedRow}
        // Main's count, so the "+" does not flicker while the list loads.
        chatsSectionEmpty={(chatsWorkspace?.workEntryCount ?? 0) === 0}
        renderCoworkWorkspace={({ workspace, workEntryMultiSelect }) => {
          const item = model.sortedProjects.find(
            (project) => project.id === workspace.localId,
          );
          return item?.type === 'cowork' ? (
            <SidebarCoworkWorkspaceRow
              item={item}
              workEntryMultiSelect={workEntryMultiSelect}
              // The shared list's DndContext hosts the row's sortable, so it
              // drags under the same rule as the legacy list.
              disableDrag={
                !canDragSidebarRow(model.projectSortMode, item.pinned === true)
              }
              isTourAnchor={
                model.visibleProjects.find(
                  (project) => project.type === 'cowork',
                )?.id === item.id
              }
              onMoveToOrganizationRequested={
                workspaceMoveToOrganization && canMoveToOrganization(item.id)
                  ? openMoveToOrganizationModal
                  : undefined
              }
            />
          ) : null;
        }}
        archivedCount={(workspaceId) =>
          desktopArchivedCount(model.sortedProjects, workspaceId)
        }
        renderArchivedSection={(workspaceId) =>
          // Archived local items only; a cloud project has none here.
          isWebCoreScope(workspaceId) ? null : (
            <DesktopArchivedNavLink
              workspaceId={workspaceId}
              fallbackCount={
                desktopArchivedCount(model.sortedProjects, workspaceId) ?? 0
              }
            />
          )
        }
        archivedEntries={(workspaceId) =>
          loadedArchivedWorkspaces[workspaceId]
            ? (archivedByWorkspace[workspaceId] ?? []).map((entry) => ({
                id: entry.id,
                title: entry.label ?? entry.branchName ?? entry.id,
                timestamp: new Date(entry.archivedAt).toLocaleString(),
                locked: entry.lockedAt !== undefined,
              }))
            : undefined
        }
        onLoadArchived={(workspaceId) =>
          useArchivedContainersStore.getState().loadForWorkspace(workspaceId)
        }
        onViewArchived={(workspaceId, worktreeId) =>
          useArchivedContainersStore
            .getState()
            .openViewer(workspaceId, worktreeId)
        }
        onRestoreArchived={(workspaceId, worktreeId) => {
          void useArchivedContainersStore
            .getState()
            .restore(workspaceId, worktreeId);
        }}
        onDeleteArchived={(workspaceId, worktreeId) => {
          const remove = (): void => {
            void useArchivedContainersStore
              .getState()
              .deletePermanently(workspaceId, worktreeId)
              .then((ok) =>
                // CAN-5338: offer the discard when the deletion can't finish.
                ok
                  ? undefined
                  : offerRetainedArchiveDiscard(
                      workspaceId,
                      worktreeId,
                      remove,
                    ),
              );
          };
          remove();
        }}
        renderArchivedActions={(workspaceId, entry) => {
          const summary = archivedByWorkspace[workspaceId]?.find(
            (candidate) => candidate.id === entry.id,
          );
          return summary ? (
            <ArchivedContainerActionsMenu
              summary={summary}
              testIdPrefix={`archived-worktree-${entry.id}`}
            />
          ) : null;
        }}
        pendingRevealTarget={
          activePage !== 'kanban' && pendingReveal
            ? {
                workspaceLocalId: pendingReveal.projectId,
                worktreeLocalId: pendingReveal.worktreeId,
              }
            : null
        }
        onWorktreeRowElement={(workspaceId, worktreeId, element) => {
          if (
            element &&
            activePage !== 'kanban' &&
            pendingReveal?.projectId === workspaceId &&
            pendingReveal.worktreeId === worktreeId
          ) {
            useProjectsStore.getState().clearPendingScrollToWorktree();
          }
        }}
        // "Shared with me" follows Projects inside the rail, as it did on the
        // legacy section. It stays desktop's: its rows are local replicas of
        // someone else's worktree or Cowork project (accept clones them onto
        // this machine), and the portal wire carries no shared containers.
        // Rendered once, above, via `additionalRows` — do not also pass it
        // through `trailingSections` here, or it mounts twice.
        testIds={testIds}
      />
      {branchInfoTarget &&
        branchInfoProject &&
        branchInfoProject.type !== 'cowork' &&
        branchInfoWorktree &&
        branchInfoKey && (
          <WorktreeBranchInfoDialog
            open
            worktree={branchInfoWorktree}
            projectId={branchInfoProject.id}
            isMultiRepo={branchInfoProject.type === 'multi-repo'}
            repoBranches={model.repoBranches[branchInfoKey]}
            configRepos={
              branchInfoProject.type === 'multi-repo'
                ? branchInfoProject.repos
                : undefined
            }
            hasBranchBeenPushed={model.hasBranchBeenPushed[branchInfoKey]}
            baseBranch={
              branchInfoProject.type === 'multi-repo'
                ? undefined
                : model.baseBranches[branchInfoKey]
            }
            baseBranchExistsLocally={
              branchInfoProject.type === 'multi-repo'
                ? undefined
                : model.baseBranchExistsLocally[branchInfoKey]
            }
            baseBranchExistsInRemote={
              branchInfoProject.type === 'multi-repo'
                ? undefined
                : model.baseBranchExistsInRemote[branchInfoKey]
            }
            branchMutationsDisabled={
              branchInfoWorktree.setupPhase === 'git-pending' ||
              model.setupRunningWorktrees.has(branchInfoKey)
            }
            onAddRepoToWorktree={(worktreeId, repoId): void | Promise<void> =>
              model.onAddRepoToWorktree(
                branchInfoProject.id,
                worktreeId,
                repoId,
              )
            }
            onRemoveRepoFromWorktree={(
              worktreeId,
              repoId,
            ): void | Promise<void> =>
              model.onRemoveRepoFromWorktree(
                branchInfoProject.id,
                worktreeId,
                repoId,
              )
            }
            onClose={(): void => setBranchInfoTarget(null)}
            pendingLabelEdit={branchInfoTarget.labelEdit === true}
            onPendingLabelEditConsumed={(): void =>
              setBranchInfoTarget((current) =>
                current ? { ...current, labelEdit: false } : current,
              )
            }
          />
        )}
      {inviteTarget && inviteWorktree && (
        <InviteTeammateModal
          projectId={inviteTarget.workspaceId}
          worktreeId={inviteTarget.worktreeId}
          containerType="CODE_WORKTREE"
          containerName={
            inviteWorktree.label?.trim() || inviteWorktree.branchName
          }
          {...(previousContextForInvite
            ? { previousContext: previousContextForInvite }
            : {})}
          onClose={(): void => {
            inviteContextTransitionRef.current = undefined;
            setInviteTarget(null);
          }}
        />
      )}
      <DesktopMoveToOrganizationDialog />
      <DesktopLinkCloudProjectDialog />
      {removalConfirm && removalConfirmInputs && (
        <WorktreeRemovalConfirmDialog
          target={removalConfirm.target}
          labels={getWorktreeDeleteLabels(
            removalConfirm.mode,
            removalConfirmInputs.retentionDays,
            removalConfirm.target.branchName,
          )}
          hasLocalWork={removalConfirmInputs.hasLocalWork}
          hasLineChanges={removalConfirmInputs.hasLineChanges}
          stats={removalConfirmInputs.stats}
          archiveInProgress={removalConfirmInputs.archiveInProgress}
          blocked={
            removalConfirmInputs.deleteAction === 'disabled' ||
            removalConfirmInputs.splitLocked ||
            !removalIdentityMatches
          }
          requestedDeleteBranch={removalConfirm.requestedDeleteBranch}
          onCancel={(): void => setRemovalConfirm(null)}
          onConfirm={(deleteBranch): void => {
            const { target, mode } = removalConfirm;
            setRemovalConfirm(null);
            model.onArchiveWorktree(target.workspaceId, target.worktreeId, {
              deleteBranch,
              expectedBranchName: target.branchName,
              ...(mode === 'archive' ? { lockAfterArchive: true } : {}),
              ...(mode === 'delete'
                ? { deleteWithoutRetentionIfMissing: true }
                : {}),
            });
          }}
        />
      )}
    </>
  );
}
