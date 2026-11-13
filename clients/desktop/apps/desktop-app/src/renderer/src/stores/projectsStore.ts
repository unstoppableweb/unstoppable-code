import {
  resolveClientAppError,
  reportClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { createWorktreeCreationActions } from './projectsStore.worktreeCreation';
import { toAppError } from '@canopy/protocol/app-errors';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { formatWorktreePrepareFailure } from '@canopy/ui-shared';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import { offerLifecycleJournalQuarantine } from '@canopy/app-state';
import { create } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';
import {
  getScriptCommand,
  getScriptDevServerPattern,
  getScriptInteractive,
  getScriptShellDefinition,
  shouldRefreshDiscoveryAfterScriptLifecycle,
} from '@canopy/desktop-shared/scripts';
import type {
  ProjectLifecycleScriptName,
  ScriptOverrides,
} from '@canopy/desktop-shared/scripts';
import type { HookOverrides } from '@canopy/desktop-shared/hooks';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import type {
  ActivitySectionId,
  AdhocExistingWorktreeCombineRequest,
  AdhocExistingWorktreeCombineResponse,
  AdhocMultiRepoCombineRequest,
  AdhocMultiRepoCombineResponse,
  ApplyRecommendedPluginsResponse,
  ChatTabPluginSelections,
  CreateOrgMemberCodeProjectRequest,
  CreateOrgMemberCodeProjectResult,
  CreateOrgMemberMultiRepoProjectRequest,
  CreateOrgMemberMultiRepoProjectResult,
  DependentBaseBranchUpdate,
  DiffStats,
  DiffStatsBatchResponseItem,
  HookChatPluginDependencyItem,
  InspectRecommendedPluginsResponse,
  MultiRepoSidebarItem,
  RecommendedPluginItem,
  RepoBranchInfo,
  RepoSelection,
  ScriptRunResponse,
  SidebarItem,
  SidebarSortMode,
  SidebarItemsLoadWarning,
  SidebarItemsSaveOptions,
  SingleRepoSidebarItem,
  SplitTemporaryWorkspaceCompleteEvent,
  SplitTemporaryWorkspaceResponse,
  SplitTemporaryWorkspaceSelection,
  WorkspaceDriftSummary,
  WorkspaceType,
  WorkspaceReferenceRepoStatus,
  WorkspaceReferenceRepoStatusEvent,
  WorkspaceRepoData,
  WorkspaceWorktreeRepairIssue,
  WorktreeData,
  WorktreeBranchChangedEvent,
  WorkspaceWorktreesUpdatedEvent,
  WorktreeDiscoveryEvent,
  WorktreeEffectiveOverrides,
  WorktreeGitFailedEvent,
  WorktreeGitReadyEvent,
  WorktreeNeedsRepairEvent,
  WorktreeHealthCheckResponse,
  WorktreeHealthIssue,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types';
import { useChatStore } from './chatStore';
import { useOllamaConnectionBannerStore } from './ollamaConnectionBannerStore';
import { markStartPageSuppressed } from '@/lib/panels/start-page-suppression';
import {
  awaitPendingRemovalHoldForE2e,
  useArchivedContainersStore,
} from './archivedContainersStore';
import {
  requestLoadedChangedFilesRefresh,
  requestChangedFilesRefresh,
  clearWorktreeActivity,
} from './changedFilesRefreshRuntime';
import { useFileListStore } from './fileListStore';
import { shareUnchangedProjects } from './projects-structural-sharing';
import { useGitHubStore } from './githubStore';
import { useHooksStore } from './hooksStore';
import { usePipelineRunsStore } from './pipelineRunsStore';
import {
  applyProjectMetadataChanges,
  buildDiffStatsChangeSignature,
  buildDiffStatsState,
  collectRefreshableWorktrees,
  collectRemoteCleanDiffStatTransitions,
  computeNextDiffStatsPollState,
  createDiffStatsKey,
  detectProjectMetadataChanges,
  DIFF_STATS_BACKGROUND_BATCH_LIMIT,
  DIFF_STATS_RECENT_ACTIVITY_WINDOW_MS,
  emptyDiffStatsState,
  getSidebarStatsRequestMode,
  invalidateChangedFileLists,
  planScheduledDiffStatsBatch,
  pruneDiffStatsState,
  registerPrPolling,
  stabilizeDiffStatsState,
  type DiffStatsState,
  type RefreshableWorktreeRef,
} from './projectsStore.diffStats';
import {
  getWorktreeDiffStatsActivityAtMs,
  initialPersistedDiffStatsState,
  markWorktreeDiffStatsActivityKey,
  pruneWorktreeDiffStatsRuntime,
  updatePersistedDiffStatsState,
  worktreeDiffStatsActivityAtMs,
  worktreeDiffStatsPollStates,
} from './projectsStore.diffStatsRuntime';
import {
  createFastDiffStatsQueue,
  type FastDiffStatsEnqueueOptions,
} from './projectsStore.fastDiffStatsQueue';
import {
  hasActiveWorkspaceLifecycleRun,
  isScriptRunActive,
  useScriptsStore,
} from './scriptsStore';
import {
  createProjectScriptDescriptor,
  createWorkspaceRootScriptDescriptor,
  createWorkspaceRepoScriptDescriptor,
} from '@/lib/scriptDescriptors';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import { resolveSidebarSortMode } from '@/lib/sidebar-ordering';
import {
  assertWorktreeRemovalAdmitted,
  throwIfArchiveRefused,
} from '@/lib/worktreeRemovalAdmission';
import {
  computeWorktreeGroups,
  flattenVisibleWorktreeGroupOrder,
  resolveTrackedBaseBranchFallback,
} from '@/components/worktree/worktree-grouping';
import { useBranchGroupingPreferenceStore } from './branchGroupingPreferenceStore';
import {
  applySingleRepoWorktreeSourceScripts,
  createAppliedProjectWorktreeScriptsKey,
  getSingleRepoWorktreeEffectiveScripts,
  type AppliedProjectWorktreeScripts,
} from '@/lib/projectWorktreeScripts';
import {
  applySingleRepoWorktreeSourceHooks,
  createAppliedProjectWorktreeHooksKey,
  type AppliedProjectWorktreeHooks,
} from '@/lib/projectWorktreeHooks';
import type { EditableScripts } from '@/lib/editableScripts';
import type { EditableHooks } from '@/lib/editableHooks';

interface PendingTaskBranchNaming {
  text: string;
  chatId?: string;
  selectedRepoId?: string;
}

export class TeardownFailedError extends Error {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly repoId?: string;
  readonly repoName?: string;
  readonly output: string;
  readonly timedOut: boolean;
  /** Per-action branch choice carried across retry/without-teardown handling. */
  deleteBranch?: boolean;
  /** Confirmed branch identity carried across retry/without-teardown handling. */
  expectedBranchName?: string;
  /** Archive retention choice carried across retry/without-teardown handling. */
  lockAfterArchive?: boolean;
  /** Missing-worktree delete choice carried across retry/without-teardown handling. */
  deleteWithoutRetentionIfMissing?: boolean;

  constructor(fields: {
    projectId: string;
    worktreeId: string;
    repoId?: string;
    repoName?: string;
    output: string;
    timedOut: boolean;
  }) {
    super('Teardown script failed');
    this.name = 'TeardownFailedError';
    this.projectId = fields.projectId;
    this.worktreeId = fields.worktreeId;
    this.repoId = fields.repoId;
    this.repoName = fields.repoName;
    this.output = fields.output;
    this.timedOut = fields.timedOut;
  }
}

interface PendingWorkspaceRepair {
  workspaceId: string;
  workspaceName: string;
  id: string;
  branchName: string;
  repairIssues: WorkspaceWorktreeRepairIssue[];
  existingBranch?: string;
  trackedRepoBaseBranches?: Record<string, string>;
}

export interface ArchiveWorktreeOptions {
  /** Explicit local branch choice from the unmerged-branch confirmation. */
  deleteBranch?: boolean;
  /** Immutable branch identity displayed by the confirmation dialog. */
  expectedBranchName?: string;
  /** Commit the retained archive with retention locking already enabled. */
  lockAfterArchive?: boolean;
  /**
   * Ask main to delete without retention only if it confirms the worktree is
   * still missing. Main retains normally if the path has been recreated.
   */
  deleteWithoutRetentionIfMissing?: boolean;
  /**
   * Called once the row has left the sidebar, after teardown and before
   * main's removal. Renderer-only: never sent to main. A rejection after it
   * still restores the row.
   */
  onUiRemoved?: () => void;
}

/**
 * State for the post-create / post-source-apply install prompt that asks
 * the user whether to install missing skill/plugin refs declared in chat
 * hook actions on the new worktree.
 */
export interface PendingHookChatPluginInstallPrompt {
  projectId: string;
  worktreeId: string;
  /** Display label for the worktree branch / target (passed through to the dialog). */
  worktreeLabel: string;
  items: HookChatPluginDependencyItem[];
}

/**
 * State for the post-create / scope-change recommendation prompt that asks
 * the user whether to install/select source-controlled `canopy.json.plugins`
 * recommendations. Mirrors `PendingHookChatPluginInstallPrompt` shape so the
 * lifecycle (set / dismiss / apply) stays consistent across both prompts.
 */
export interface PendingRecommendedPluginPrompt {
  projectId: string;
  worktreeId: string;
  /** When set, the recommendation comes from a child repo's `canopy.json`. */
  repoId?: string;
  /** Human-readable label for the inspected scope (passed through to the dialog). */
  scopeLabel: string;
  items: RecommendedPluginItem[];
  requirements: InspectRecommendedPluginsResponse['requirements'];
}

interface WorkspaceDriftEntry {
  key: string;
  summary: WorkspaceDriftSummary;
}

function normalizePausedHookKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.filter((key) => key.length > 0))).sort();
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function getCurrentDiffStatsState(
  state: Pick<
    ProjectsState,
    | 'diffStats'
    | 'commitsAhead'
    | 'baseBranches'
    | 'defaultBranches'
    | 'uncommittedChanges'
    | 'hasRemoteTracking'
    | 'hasOriginRemote'
    | 'hasBranchBeenPushed'
    | 'hasUnpushedCommits'
    | 'hasUnpulledCommits'
    | 'repoBranches'
    | 'baseBranchExistsLocally'
    | 'baseBranchExistsInRemote'
  >,
): DiffStatsState {
  return {
    diffStats: state.diffStats,
    commitsAhead: state.commitsAhead,
    baseBranches: state.baseBranches,
    defaultBranches: state.defaultBranches,
    uncommittedChanges: state.uncommittedChanges,
    hasRemoteTracking: state.hasRemoteTracking,
    hasOriginRemote: state.hasOriginRemote,
    hasBranchBeenPushed: state.hasBranchBeenPushed,
    hasUnpushedCommits: state.hasUnpushedCommits,
    hasUnpulledCommits: state.hasUnpulledCommits,
    repoBranches: state.repoBranches,
    baseBranchExistsLocally: state.baseBranchExistsLocally,
    baseBranchExistsInRemote: state.baseBranchExistsInRemote,
  };
}

function diffStatsStateHasEntries(state: DiffStatsState): boolean {
  return (
    Object.keys(state.diffStats).length > 0 ||
    Object.keys(state.commitsAhead).length > 0 ||
    Object.keys(state.baseBranches).length > 0 ||
    Object.keys(state.defaultBranches).length > 0 ||
    Object.keys(state.uncommittedChanges).length > 0 ||
    Object.keys(state.hasRemoteTracking).length > 0 ||
    Object.keys(state.hasOriginRemote).length > 0 ||
    Object.keys(state.hasBranchBeenPushed).length > 0 ||
    Object.keys(state.hasUnpushedCommits).length > 0 ||
    Object.keys(state.hasUnpulledCommits).length > 0 ||
    Object.keys(state.repoBranches).length > 0 ||
    Object.keys(state.baseBranchExistsLocally).length > 0 ||
    Object.keys(state.baseBranchExistsInRemote).length > 0
  );
}

function mergeDiffStatsStateForKeys(
  previous: DiffStatsState,
  partial: DiffStatsState,
  keys: Set<string>,
  diffOnlyKeys: ReadonlySet<string> = new Set(),
): DiffStatsState {
  const next: DiffStatsState = {
    diffStats: { ...previous.diffStats },
    commitsAhead: { ...previous.commitsAhead },
    baseBranches: { ...previous.baseBranches },
    defaultBranches: { ...previous.defaultBranches },
    uncommittedChanges: { ...previous.uncommittedChanges },
    hasRemoteTracking: { ...previous.hasRemoteTracking },
    hasOriginRemote: { ...previous.hasOriginRemote },
    hasBranchBeenPushed: { ...previous.hasBranchBeenPushed },
    hasUnpushedCommits: { ...previous.hasUnpushedCommits },
    hasUnpulledCommits: { ...previous.hasUnpulledCommits },
    repoBranches: { ...previous.repoBranches },
    baseBranchExistsLocally: { ...previous.baseBranchExistsLocally },
    baseBranchExistsInRemote: { ...previous.baseBranchExistsInRemote },
  };

  keys.forEach((key) => {
    delete next.diffStats[key];
    if (diffOnlyKeys.has(key)) {
      return;
    }
    delete next.commitsAhead[key];
    delete next.baseBranches[key];
    delete next.defaultBranches[key];
    delete next.uncommittedChanges[key];
    delete next.hasRemoteTracking[key];
    delete next.hasOriginRemote[key];
    delete next.hasBranchBeenPushed[key];
    delete next.hasUnpushedCommits[key];
    delete next.hasUnpulledCommits[key];
    delete next.repoBranches[key];
    delete next.baseBranchExistsLocally[key];
    delete next.baseBranchExistsInRemote[key];
  });

  return {
    diffStats: { ...next.diffStats, ...partial.diffStats },
    commitsAhead: { ...next.commitsAhead, ...partial.commitsAhead },
    baseBranches: { ...next.baseBranches, ...partial.baseBranches },
    defaultBranches: { ...next.defaultBranches, ...partial.defaultBranches },
    uncommittedChanges: {
      ...next.uncommittedChanges,
      ...partial.uncommittedChanges,
    },
    hasRemoteTracking: {
      ...next.hasRemoteTracking,
      ...partial.hasRemoteTracking,
    },
    hasOriginRemote: { ...next.hasOriginRemote, ...partial.hasOriginRemote },
    hasBranchBeenPushed: {
      ...next.hasBranchBeenPushed,
      ...partial.hasBranchBeenPushed,
    },
    hasUnpushedCommits: {
      ...next.hasUnpushedCommits,
      ...partial.hasUnpushedCommits,
    },
    hasUnpulledCommits: {
      ...next.hasUnpulledCommits,
      ...partial.hasUnpulledCommits,
    },
    repoBranches: { ...next.repoBranches, ...partial.repoBranches },
    baseBranchExistsLocally: {
      ...next.baseBranchExistsLocally,
      ...partial.baseBranchExistsLocally,
    },
    baseBranchExistsInRemote: {
      ...next.baseBranchExistsInRemote,
      ...partial.baseBranchExistsInRemote,
    },
  };
}

/**
 * Why a worktree is being scrolled into view. `created` flows survive the
 * asynchronous post-creation reflow (base-branch nesting is seeded synchronously
 * and diff-stats land later), so the consumer re-asserts the scroll across a
 * short settle window. `selected` flows act on a stable layout and scroll once.
 */
export type PendingWorktreeScrollReason = 'created' | 'selected';

export interface PendingWorktreeScroll {
  projectId: string;
  worktreeId: string;
  reason: PendingWorktreeScrollReason;
}

export interface ProjectsState {
  projects: SidebarItem[];
  isLoading: boolean;
  hasHydratedProjects: boolean;
  /** Whether the latest inventory read succeeded; includes silent refreshes. */
  projectInventoryStatus: 'unhydrated' | 'loading' | 'ready' | 'error';
  /** Last successful server list, before optimistic archive suppression. */
  projectInventorySnapshot: {
    projects: readonly SidebarItem[];
    startedAt: number;
  } | null;
  projectLoadWarningKeys: Set<string>;
  failedWorkspaceIds: Set<string>;
  appliedProjectWorktreeScripts: AppliedProjectWorktreeScripts;
  appliedProjectWorktreeHooks: AppliedProjectWorktreeHooks;
  diffStats: Record<string, DiffStats>;
  commitsAhead: Record<string, boolean>;
  baseBranches: Record<string, string | null>;
  /** Repo default branch per worktree key, used for sidebar branch-grouping. */
  defaultBranches: Record<string, string | null>;
  uncommittedChanges: Record<string, boolean>;
  hasRemoteTracking: Record<string, boolean>;
  hasOriginRemote: Record<string, boolean>;
  hasBranchBeenPushed: Record<string, boolean>;
  hasUnpushedCommits: Record<string, boolean>;
  hasUnpulledCommits: Record<string, boolean>;
  repoBranches: Record<string, RepoBranchInfo[]>;
  baseBranchExistsLocally: Record<string, boolean>;
  baseBranchExistsInRemote: Record<string, boolean>;
  workspaceDrift: Record<string, WorkspaceDriftSummary>;
  discoveryLoading: Set<string>;
  creatingWorktreeForProject: Set<string>;
  /**
   * Workspace ids currently hidden from the workspace/worktree list via the
   * filter dropdown. Persisted through the `worktreeFilterHiddenWorkspaceIds`
   * preference. Owned here (not per-component) so both the legacy
   * `WorktreeManager` aside and the unified sidebar's "Code Workspaces"
   * section stay in sync from a single source of truth.
   */
  hiddenWorkspaceIds: string[];
  /**
   * Applies the persisted hidden-workspace filter on the projects-load path.
   * Does not persist (the value already came from preferences).
   */
  hydrateHiddenWorkspaceIds: (ids: string[]) => void;
  /**
   * Workspace ids that were added at runtime and should briefly pulse + scroll
   * into view in the sidebar list. Owned here (not per-component) so the
   * unified sidebar's "Code Workspaces" rows can render the highlight even
   * though the detection used to live in `WorktreeManager`. The first hydrated
   * snapshot is captured as a baseline without pulsing; each subsequent new id
   * pulses for ~4s.
   */
  recentlyAddedProjectIds: ReadonlySet<string>;
  /**
   * Diffs the current `projects` against the last observed id set and, for any
   * newly added workspace, adds it to {@link recentlyAddedProjectIds} and
   * schedules its removal after the pulse window. Idempotent and safe to call
   * from a `projects`-watching effect. No-ops until projects have hydrated.
   */
  detectRecentlyAddedProjects: () => void;
  /** Clears all outstanding recently-added highlight timers (unmount cleanup). */
  clearRecentlyAddedProjectTimers: () => void;
  /**
   * Replaces the hidden-workspace filter and fire-and-forget persists it to
   * the `worktreeFilterHiddenWorkspaceIds` preference.
   */
  setHiddenWorkspaceIds: (ids: string[]) => void;
  /**
   * Workspace/worktree pair that should be scrolled into view in the sidebar
   * list/kanban on its next render, plus why. `created` is set by
   * `finalizeCreatedWorktree`
   * for every creation flow (workspace +, worktree-list +, CreateTaskModal);
   * `selected` is set by selection/navigation entry points. The list view
   * consumes and clears this via `clearPendingScrollToWorktree` after
   * scrolling.
   */
  pendingScrollToWorktree: PendingWorktreeScroll | null;
  /**
   * Request that the worktree list/kanban scrolls the given workspace/worktree
   * pair into view on its next render. Use for navigation entry points (toasts,
   * in-app links, restored selections) where the target may be off-screen.
   * The scroll uses `block/inline: 'nearest'` so already-visible items are
   * not disturbed. Defaults to the `selected` reason (single, gentle scroll).
   */
  requestScrollToWorktree: (
    projectId: string,
    worktreeId: string,
    reason?: PendingWorktreeScrollReason,
  ) => void;
  clearPendingScrollToWorktree: () => void;
  tearingDownWorktrees: Set<string>;
  /** Worktrees whose archive/delete lifecycle is currently in progress. */
  archivingWorktrees: Set<string>;
  pendingWorkspaceRepair: PendingWorkspaceRepair | null;
  workspaceRepairPending: boolean;
  pendingHookChatPluginInstallPrompt: PendingHookChatPluginInstallPrompt | null;
  /**
   * Inspect a worktree's hook chat plugin dependencies and, if any refs are
   * missing locally, set `pendingHookChatPluginInstallPrompt` so the install
   * dialog can show both installable and unavailable dependencies. No-op when
   * the inspection returns no items.
   */
  inspectHookChatPluginDependencies: (
    projectId: string,
    worktreeId: string,
    worktreeLabel?: string,
  ) => Promise<void>;
  /** Dismiss the install prompt without installing anything. */
  dismissPendingHookChatPluginInstallPrompt: () => void;
  pendingRecommendedPluginPrompt: PendingRecommendedPluginPrompt | null;
  /**
   * Inspect `canopy.json.plugins` recommendations for the given scope.
   * Drops the result when `promptItems` is empty, otherwise sets
   * `pendingRecommendedPluginPrompt` so the dialog can render. The store
   * tracks dismissed scope keys (via `Ask me later`) in a module-scoped set
   * so repeated re-scopes within a session do not re-fire the dialog;
   * callers can pass `force: true` to bypass that check (used by the
   * settings panel's `Suggest again` action).
   */
  inspectRecommendedPlugins: (
    projectId: string,
    worktreeId: string,
    options?: { repoId?: string; label?: string; force?: boolean },
  ) => Promise<void>;
  /**
   * Apply a user's selections from the prompt or settings panel.
   * - `selectedKeys` are installed (if missing) and selected by default.
   * - `optOutKeys` are persisted into `recommendedPluginOptOutKeys`.
   * - `clearOptOutKeys` are removed from `recommendedPluginOptOutKeys`
   *   without selecting them (powers `Suggest again`).
   *
   * On success, calls `loadProjects({ silent: true })` so renderer state
   * picks up the new `defaultPluginSelections` / `recommendedPluginOptOutKeys`,
   * then dismisses `pendingRecommendedPluginPrompt` when
   * `dismissPromptOnSuccess` is true (set by the dialog flow; the settings
   * panel passes false). Returns the per-item results so callers can render
   * error states for rows whose install failed.
   */
  applyRecommendedPlugins: (args: {
    projectId: string;
    worktreeId: string;
    repoId?: string;
    selectedKeys: string[];
    optOutKeys: string[];
    clearOptOutKeys?: string[];
    dismissPromptOnSuccess?: boolean;
  }) => Promise<ApplyRecommendedPluginsResponse>;
  /**
   * Dismiss the recommendation prompt. When `remember: true`, records the
   * current scope key in the dismissed-set so the prompt does not re-fire
   * for this scope until the renderer reloads. Without `remember`, the
   * prompt is simply hidden but can re-fire on the next inspection.
   */
  dismissPendingRecommendedPluginPrompt: (options?: {
    remember?: boolean;
  }) => void;
  worktreeError: InlineFailure | null;
  clearWorktreeError: () => void;
  branchRenameRequest: { projectId: string; worktreeId: string } | null;
  requestBranchRename: (projectId: string, worktreeId: string) => void;
  clearBranchRenameRequest: () => void;
  /** Required refreshes reject on failure; ordinary hydration preserves its retry behavior. */
  loadProjects: (options?: {
    silent?: boolean;
    requireSuccess?: boolean;
  }) => Promise<void>;
  branchInfoRequest: { projectId: string; worktreeId: string } | null;
  requestBranchInfo: (projectId: string, worktreeId: string) => void;
  clearBranchInfoRequest: () => void;
  saveProjects: (
    items?: SidebarItem[],
    options?: SidebarItemsSaveOptions,
  ) => Promise<void>;
  browseForRepo: () => Promise<RepoSelection | null>;
  addLocalRepo: (
    repoPath: string,
    options?: { activate?: boolean },
  ) => Promise<{ id: string; type: WorkspaceType } | null>;
  addRemoteRepo: (
    remoteUrl: string,
    destinationDir: string,
    options?: {
      /** Track the clone as a clone job the sidebar can take over. */
      jobId?: string;
    },
  ) => Promise<string | null>;
  initLocalRepo: (name: string) => Promise<string | null>;
  /**
   * Create (or resume, or link) the member's own Code project in an
   * organization (CAN-3534). Reloads the sidebar once the project is on this
   * computer; a refusal or failure changes nothing here.
   */
  createOrgMemberCodeProject: (
    request: CreateOrgMemberCodeProjectRequest,
  ) => Promise<CreateOrgMemberCodeProjectResult>;
  /** A member's multi-repo organization project from Add project (CAN-3546). */
  createOrgMemberMultiRepoProject: (
    request: CreateOrgMemberMultiRepoProjectRequest,
  ) => Promise<CreateOrgMemberMultiRepoProjectResult>;
  removeProject: (projectId: string) => Promise<void>;
  createWorktree: (
    projectId: string,
    options?: CreateWorktreeOptions,
  ) => Promise<
    { id: string; setupPhase?: 'git-pending' | 'git-ready' } | undefined
  >;
  registerCreatedWorkspaceWorktree: (
    projectId: string,
    created: CreatedWorktreeRegistration,
    options?: Pick<CreateWorktreeOptions, 'select' | 'onRegistered'>,
  ) => Promise<WorktreeData | null>;
  archiveWorktree: (
    projectId: string,
    worktreeId: string,
    options?: ArchiveWorktreeOptions,
  ) => Promise<void>;
  /**
   * Drops a worktree that main already removed, and the temporary project
   * the removal left empty when main reports one.
   */
  reconcileArchivedWorktree: (
    projectId: string,
    worktreeId: string,
    options?: { removedTemporaryWorkspaceId?: string },
  ) => Promise<void>;
  forceArchiveWorktree: (
    projectId: string,
    worktreeId: string,
    options?: ArchiveWorktreeOptions,
  ) => Promise<void>;
  toggleCollapsed: (projectId: string) => Promise<void>;
  reorderProjects: (
    activeProjectId: string,
    overProjectId: string,
  ) => Promise<void>;
  reorderWorktrees: (
    projectId: string,
    activeWorktreeId: string,
    overWorktreeId: string,
  ) => Promise<void>;
  reorderActivitySections: (
    projectId: string,
    newOrder: ActivitySectionId[],
  ) => Promise<void>;
  getBaseBranch: (
    projectId: string,
    worktreeId: string,
  ) => string | null | undefined;
  refreshDiffStats: () => Promise<void>;
  /**
   * One adaptive scheduler tick: refreshes the foreground worktree every call
   * and only the currently-due background worktrees (per-worktree backoff,
   * bounded batch size). This is the periodic polling entry point; use
   * `refreshDiffStats` for a forced full sweep after user actions that can
   * affect many worktrees at once.
   */
  refreshDiffStatsScheduled: () => Promise<void>;
  /**
   * Refresh diff stats for a single worktree only, skipping the network
   * `git fetch`. Used by the immediate post-action refresh so it stays bounded
   * to local git reads for the acted-on worktree instead of sweeping (and
   * fetching) every worktree app-wide.
   */
  refreshWorktreeDiffStats: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
  /**
   * Refresh one worktree and report whether fresh diff stats were applied.
   * Use this for safety gates that must fail closed when status is unavailable.
   */
  refreshWorktreeDiffStatsVerified: (
    projectId: string,
    worktreeId: string,
  ) => Promise<boolean>;
  /**
   * Refresh diff stats for a single worktree and allow the backend to fetch
   * remotes first. Used when a remote parent branch may have advanced outside
   * the local worktree, such as after a child PR is merged into it.
   */
  refreshWorktreeDiffStatsFromRemote: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
  /**
   * Refresh diff stats for multiple worktrees in one remote-fetching batch.
   * Used when several parent worktrees may have advanced together so their
   * shared generation guard does not invalidate earlier responses.
   */
  refreshWorktreesDiffStatsFromRemote: (
    worktrees: RefreshableWorktreeRef[],
  ) => Promise<void>;
  /**
   * Put a worktree at the front of the fast diff-stats queue for a quick,
   * scoped, local-only refresh (used by file-save, agent-turn-with-changes,
   * and new-uncommitted-files triggers).
   */
  fastRefreshWorktreeDiffStats: (
    projectId: string,
    worktreeId: string,
    options?: FastDiffStatsEnqueueOptions,
  ) => void;
  retryWorktreeHealthCheck: (
    projectId: string,
    worktreeId: string,
  ) => Promise<WorktreeHealthCheckResponse>;
  refreshWorkspaceDrift: (items?: SidebarItem[]) => Promise<void>;
  workspaceReferenceRepoStatus: Record<
    string,
    WorkspaceReferenceRepoStatus | null
  >;
  /**
   * Per-worktree pending branch-naming entries. Keyed by `${projectId}/${worktreeId}`.
   * Populated when a Create Task pipeline / chat / plan handler enqueues a task on a
   * `git-pending` worktree (the worktree directory does not exist yet, so
   * `scheduleTaskBranchNaming` cannot probe it). Drained from the
   * `worktree:git-ready` handler.
   */
  pendingTaskBranchNamings: Record<string, PendingTaskBranchNaming>;
  enqueuePendingTaskBranchNaming: (
    projectId: string,
    worktreeId: string,
    text: string,
    options?: { chatId?: string; selectedRepoId?: string },
  ) => void;
  clearPendingTaskBranchNaming: (projectId: string, worktreeId: string) => void;
  /**
   * Subscribe to `worktree:git-ready` and `worktree:git-failed` IPC events.
   * Wired once at boot before recovery resolves so events from the very first
   * Phase B in a fresh session are not missed.
   */
  subscribeToWorktreeGitLifecycleEvents: () => () => void;
  subscribeToWorkspaceReferenceRepoEvents: () => () => void;
  setWorktreeStatus: (
    projectId: string,
    worktreeId: string,
    status?: WorktreeData['status'],
  ) => void;
  setAppliedProjectWorktreeScripts: (
    projectId: string,
    worktreeId: string,
    loadedSourceScripts: EditableScripts,
    sourceScripts: EditableScripts,
  ) => void;
  setAppliedProjectWorktreeHooks: (
    projectId: string,
    worktreeId: string,
    loadedSourceHooks: EditableHooks,
    sourceHooks: EditableHooks,
  ) => void;
  subscribeToDiscoveryEvents: () => () => void;
  retriggerDiscovery: (
    projectId: string,
    worktreeId: string,
    pluginSelections?: ChatTabPluginSelections,
  ) => Promise<void>;
  createWorkspace: (name: string) => Promise<string>;
  importWorkspaceFromRepo: (repoPath: string) => Promise<string>;
  repairPendingWorkspaceWorktree: (restoreClaudeMd: boolean) => Promise<void>;
  cancelPendingWorkspaceRepair: () => Promise<void>;
  setupWorkspace: (workspaceId: string, worktreeId: string) => Promise<void>;
  launchWorkspace: (workspaceId: string, worktreeId: string) => Promise<void>;
  teardownWorkspace: (workspaceId: string, worktreeId: string) => Promise<void>;
  addRepoToWorkspace: (
    workspaceId: string,
    repoPath: string,
    addToSourceControl?: boolean,
  ) => Promise<void>;
  removeRepoFromWorkspace: (
    workspaceId: string,
    repoId: string,
  ) => Promise<void>;
  addRepoToWorktree: (
    workspaceId: string,
    worktreeId: string,
    repoId: string,
  ) => Promise<void>;
  removeRepoFromWorktree: (
    workspaceId: string,
    worktreeId: string,
    repoId: string,
  ) => Promise<void>;
  /**
   * Combine an existing worktree with another workspace's repo set into an
   * adhoc multi-repo destination workspace. On success, reloads projects,
   * selects the destination worktree, and returns the response so callers
   * (typically `AddRepoToWorktreeModal` via `chatStore`) can migrate chat /
   * file tabs without re-running identity matching. On error, sets
   * `worktreeError` and returns `undefined`.
   */
  combineWorktreeWithWorkspace: (
    request: AdhocMultiRepoCombineRequest,
  ) => Promise<AdhocMultiRepoCombineResponse | undefined>;
  combineWorktreeWithExistingWorktree: (
    request: AdhocExistingWorktreeCombineRequest,
  ) => Promise<AdhocExistingWorktreeCombineResponse | undefined>;
  /**
   * Split a temporary multi-repo workspace worktree back into per-repo
   * single-repo worktrees. Mirrors `archiveWorktree`'s optimistic UI
   * removal/rollback for the source worktree, then reloads projects so the
   * destination workspaces and worktrees appear. Throws on failure so the
   * hosting modal can surface the error inline.
   */
  splitTemporaryWorkspaceWorktree: (
    projectId: string,
    worktreeId: string,
    selections: Record<string, SplitTemporaryWorkspaceSelection>,
    rootAction?: 'archive' | 'delete',
    destructiveApprovalToken?: string,
    previewRevision?: string,
  ) => Promise<SplitTemporaryWorkspaceResponse>;
  updateBranchName: (
    projectId: string,
    worktreeId: string,
    newBranchName: string,
    repoId?: string,
  ) => void;
  setTrackedBaseBranch: (
    projectId: string,
    worktreeId: string,
    baseBranch: string | null,
    repoId?: string,
    presence?: { existsLocally: boolean; existsInRemote: boolean },
  ) => Promise<void>;
  setWorktreeLastKnownPrStatus: (
    projectId: string,
    worktreeId: string,
    status: WorktreePrStatus | null,
  ) => void;
  applyDependentBaseBranchUpdates: (
    updates: DependentBaseBranchUpdate[],
  ) => void;
  markWorktreePipelineExecutionsSeen: (
    projectId: string,
    worktreeId: string,
    executionIds: string[],
  ) => Promise<void>;
  pruneStaleSeenPipelineExecutionIds: (
    activeExecutionIdsByWorktree: Record<string, Set<string>>,
  ) => Promise<void>;
  clearWorktreeSeenPipelineExecutions: (
    projectId: string,
    worktreeId: string,
    executionIds: string[],
  ) => Promise<void>;
  setWorktreePausedHookKeys: (
    projectId: string,
    worktreeId: string,
    pausedHookKeys: string[],
  ) => Promise<void>;
  setWorktreeHidden: (
    projectId: string,
    worktreeId: string,
    hidden: boolean,
  ) => Promise<void>;
  /**
   * Set or clear a worktree's custom display label. An empty/undefined label
   * clears it so the branch display name is used again. Optimistic with
   * rollback on error.
   */
  setWorktreeLabel: (
    projectId: string,
    worktreeId: string,
    label: string | undefined,
  ) => Promise<void>;
  setWorktreeBranchGroupingOverride: (
    projectId: string,
    worktreeId: string,
    override: 'group' | 'ungroup' | null,
  ) => Promise<void>;
  /**
   * Pin or unpin a worktree within its workspace's sidebar section (CAN-1074).
   * Optimistic with rollback on error.
   */
  setWorktreePinned: (
    projectId: string,
    worktreeId: string,
    pinned: boolean,
  ) => Promise<void>;
  /**
   * Pin or unpin a workspace within the top-level Projects section
   * (CAN-1074). Optimistic with rollback on error.
   */
  setWorkspacePinned: (workspaceId: string, pinned: boolean) => Promise<void>;
  /**
   * Choose how a workspace orders its child rows (worktrees or Work Entries):
   * `'manual'` (drag-and-drop, default) or `'last-updated'`. Optimistic with
   * rollback on error.
   */
  setWorkspaceItemSortMode: (
    workspaceId: string,
    mode: SidebarSortMode,
  ) => Promise<void>;
}

const registeredForPrPolling = new Set<string>();
const prevCanopyJsonHash = new Map<string, string | undefined>();
const inFlightArchives = new Map<string, Promise<void>>();
const archiveSuppressedWorktreeKeys = new Set<string>();
const archiveSuppressedChatActivityKeys = new Set<string>();
const activeArchiveSuppressedLoadFilters = new Set<Set<string>>();
let projectsLoadGeneration = 0;
const projectsLoadCompletionResolvers = new Map<
  number,
  (error?: Error) => void
>();

interface E2eProjectsLoadBarrier {
  claimed: boolean;
  reached: Promise<void>;
  resolveReached: () => void;
  release: Promise<void>;
  resolveRelease: () => void;
  completed: Promise<void>;
  resolveCompleted: () => void;
}

interface E2eProjectsTestApi {
  holdNextLoadAfterRead: () => void;
  /**
   * Resolves when the reload has applied. With `requireSuccess` a failed read
   * rejects; without it (callers that do not await) it always resolves.
   */
  loadProjects: (options?: { requireSuccess?: boolean }) => Promise<void>;
  waitForHeldLoad: () => Promise<void>;
  releaseHeldLoad: () => Promise<void>;
}

type FirstProjectsLoadErrorKind =
  | 'error'
  | 'type-error'
  | 'range-error'
  | 'syntax-error'
  | 'non-error'
  | 'unknown';

declare global {
  interface Window {
    __canopyProjectsTestApi?: E2eProjectsTestApi;
  }
}

let firstProjectsLoadDocumentId: string | undefined;
let firstProjectsLoadRendererSequence = 0;

function classifyFirstProjectsLoadRendererError(error: unknown): {
  errorKind: FirstProjectsLoadErrorKind;
  errorCode?: string;
} {
  try {
    const errorKind: FirstProjectsLoadErrorKind =
      error instanceof TypeError
        ? 'type-error'
        : error instanceof RangeError
          ? 'range-error'
          : error instanceof SyntaxError
            ? 'syntax-error'
            : error instanceof Error
              ? 'error'
              : error === null ||
                  [
                    'string',
                    'number',
                    'boolean',
                    'bigint',
                    'undefined',
                  ].includes(typeof error)
                ? 'non-error'
                : 'unknown';
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
      return { errorKind };
    }
    const code: unknown = 'code' in error ? error.code : undefined;
    const allowedCodes = new Set([
      'ENOENT',
      'EACCES',
      'EPERM',
      'EIO',
      'ETIMEDOUT',
      'ECONNRESET',
      'ERR_IPC_CHANNEL_CLOSED',
    ]);
    return {
      errorKind,
      ...(typeof code === 'string'
        ? { errorCode: allowedCodes.has(code) ? code : 'unknown' }
        : {}),
    };
  } catch {
    return { errorKind: 'unknown' };
  }
}

function observeFirstProjectsLoadRenderer(
  stage: string,
  details: () => Record<string, unknown>,
): void {
  if (!__CANOPY_E2E__) return;
  try {
    const api = window.api;
    const report: unknown = Reflect.get(api, 'e2eReportFirstProjectsLoad');
    const isActive: unknown = Reflect.get(api, 'e2eIsFirstProjectsLoadActive');
    const isReporter = (
      value: unknown,
    ): value is (stage: string, details: Record<string, unknown>) => unknown =>
      typeof value === 'function';
    const isActivityReader = (value: unknown): value is () => boolean =>
      typeof value === 'function';
    const isThenable = (value: unknown): value is PromiseLike<unknown> =>
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      'then' in value &&
      typeof value.then === 'function';
    if (!isReporter(report) || !isActivityReader(isActive) || !isActive())
      return;
    firstProjectsLoadDocumentId ??=
      globalThis.crypto?.randomUUID?.() ?? 'document-unavailable';
    const result = report(stage, {
      documentId: firstProjectsLoadDocumentId,
      rendererSequence: ++firstProjectsLoadRendererSequence,
      rendererTimeMs: globalThis.performance?.now?.(),
      ...details(),
    });
    if (isThenable(result)) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    /* E2E observation must never enter the product error path. */
  }
}

function projectFirstProjectsLoadLists(
  groups: ReadonlyArray<readonly SidebarItem[]>,
): Array<Record<string, unknown>> {
  let remainingWorkspaceIds = 8;
  let remainingWorktreeIds = 32;
  let remainingWorkspaceInspections = 16;
  let remainingWorktreeInspections = 64;
  return groups.map((items) => {
    const workspaceIds: string[] = [];
    const worktreeIds: string[] = [];
    let invalidIdCount = 0;
    let workspaceInspectedCount = 0;
    let worktreeInspectedCount = 0;
    let worktreeOmittedCount = 0;
    let worktreeOmittedCountAvailable = true;
    const safeId = (value: unknown): value is string =>
      typeof value === 'string' &&
      value.length <= 128 &&
      /^[a-z0-9._-]+$/i.test(value);
    try {
      for (
        let index = 0;
        index < items.length &&
        remainingWorkspaceIds > 0 &&
        remainingWorkspaceInspections > 0;
        index++
      ) {
        workspaceInspectedCount++;
        remainingWorkspaceInspections--;
        let item: SidebarItem | undefined;
        try {
          item = items[index];
        } catch {
          invalidIdCount++;
          continue;
        }
        if (!item) continue;
        if (safeId(item.id)) {
          workspaceIds.push(item.id);
          remainingWorkspaceIds--;
        } else {
          invalidIdCount++;
        }
        const worktrees = 'worktrees' in item ? item.worktrees : [];
        const inspectedBeforeItem = worktreeInspectedCount;
        for (
          let worktreeIndex = 0;
          worktreeIndex < worktrees.length &&
          remainingWorktreeIds > 0 &&
          remainingWorktreeInspections > 0;
          worktreeIndex++
        ) {
          worktreeInspectedCount++;
          remainingWorktreeInspections--;
          let id: unknown;
          try {
            id = worktrees[worktreeIndex]?.id;
          } catch {
            invalidIdCount++;
            continue;
          }
          if (safeId(id)) {
            worktreeIds.push(id);
            remainingWorktreeIds--;
          } else {
            invalidIdCount++;
          }
        }
        worktreeOmittedCount += Math.max(
          0,
          worktrees.length - (worktreeInspectedCount - inspectedBeforeItem),
        );
      }
    } catch {
      invalidIdCount++;
      worktreeOmittedCountAvailable = false;
    }
    const workspaceOmittedCount = Math.max(
      0,
      items.length - workspaceInspectedCount,
    );
    if (workspaceOmittedCount > 0) worktreeOmittedCountAvailable = false;
    return {
      itemCount: items.length,
      workspaceIds,
      worktreeIds,
      invalidIdCount,
      workspaceInspectedCount,
      workspaceOmittedCount,
      worktreeInspectedCount,
      ...(worktreeOmittedCountAvailable ? { worktreeOmittedCount } : {}),
      worktreeOmittedCountAvailable,
      worktreeCountAvailable: false,
      truncated:
        workspaceOmittedCount > 0 ||
        worktreeOmittedCount > 0 ||
        remainingWorkspaceIds === 0 ||
        remainingWorktreeIds === 0,
    };
  });
}

function projectFirstProjectsLoadWarnings(
  warnings: SidebarItemsLoadWarning[] | undefined,
  remainingWorkspaceIds: number,
): Record<string, unknown> {
  const warningIdentities: Array<{
    workspaceId?: string;
    code: SidebarItemsLoadWarning['code'];
  }> = [];
  const allowedCodes = new Set<SidebarItemsLoadWarning['code']>([
    'invalid-canopy-json',
    'workspace-load-failed',
  ]);
  const safeId = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.length <= 128 &&
    /^[a-z0-9._-]+$/i.test(value);
  let warningInspectedCount = 0;
  let invalidIdCount = 0;
  const warningCount = warnings?.length ?? 0;
  try {
    for (
      let index = 0;
      index < warningCount &&
      warningInspectedCount < 16 &&
      warningIdentities.length < 8;
      index++
    ) {
      warningInspectedCount++;
      const warning = warnings?.[index];
      if (!warning || !allowedCodes.has(warning.code)) continue;
      const identity: {
        workspaceId?: string;
        code: SidebarItemsLoadWarning['code'];
      } = { code: warning.code };
      if (remainingWorkspaceIds > 0 && safeId(warning.workspaceId)) {
        identity.workspaceId = warning.workspaceId;
        remainingWorkspaceIds--;
      } else if (!safeId(warning.workspaceId)) {
        invalidIdCount++;
      }
      warningIdentities.push(identity);
    }
  } catch {
    invalidIdCount++;
  }
  return {
    warningCount,
    warningIdentities,
    warningInspectedCount,
    warningOmittedCount: Math.max(0, warningCount - warningInspectedCount),
    invalidWarningIdCount: invalidIdCount,
    warningTruncated:
      warningCount > warningInspectedCount || warningIdentities.length >= 8,
  };
}

let e2eProjectsLoadBarrier: E2eProjectsLoadBarrier | null = null;

async function waitAtE2eProjectsLoadBarrier(): Promise<E2eProjectsLoadBarrier | null> {
  if (!__CANOPY_E2E__) return null;
  const barrier = e2eProjectsLoadBarrier;
  if (!barrier || barrier.claimed) return null;
  barrier.claimed = true;
  barrier.resolveReached();
  await barrier.release;
  return barrier;
}

function resolveProjectsLoadsThrough(generation: number, error?: Error): void {
  projectsLoadCompletionResolvers.forEach((resolve, pendingGeneration) => {
    if (pendingGeneration > generation) return;
    projectsLoadCompletionResolvers.delete(pendingGeneration);
    resolve(error);
  });
}

/** Duration a freshly added workspace stays in the recently-added pulse set. */
const RECENTLY_ADDED_PULSE_MS = 4000;
// Module-scoped tracking for the recently-added workspace pulse. Held here (not
// in Zustand state) so timers survive individual `set` calls: adding a second
// workspace must not strand the first workspace's pulse timer. Mirrors the
// refs that previously lived in `WorktreeManager`.
let recentlyAddedBaselineIds = new Set<string>();
let recentlyAddedBaselineCaptured = false;
const recentlyAddedHighlightTimers = new Map<string, number>();

/**
 * Module-scoped set of recommendation-prompt scope keys that the user has
 * dismissed via `Ask me later`. Lives outside Zustand state so the dismissal
 * survives modal opens within the renderer session but resets when the
 * renderer reloads (intentional — fresh sessions get a fresh prompt).
 *
 * Scope keys:
 *   `${projectId}:${worktreeId}` — workspace-root or single-repo inspection
 *   `${projectId}:${worktreeId}:${repoId}` — child-repo scoped inspection
 */
const dismissedRecommendedPluginScopeKeys = new Set<string>();

function buildRecommendedPluginScopeKey(
  projectId: string,
  worktreeId: string,
  repoId?: string,
): string {
  return repoId
    ? `${projectId}:${worktreeId}:${repoId}`
    : `${projectId}:${worktreeId}`;
}

function clearDismissedRecommendedPluginScopesForWorktree(
  projectId: string,
  worktreeId: string,
): void {
  const rootScopeKey = buildRecommendedPluginScopeKey(projectId, worktreeId);
  const repoScopePrefix = `${rootScopeKey}:`;
  dismissedRecommendedPluginScopeKeys.forEach((scopeKey: string): void => {
    if (scopeKey === rootScopeKey || scopeKey.startsWith(repoScopePrefix)) {
      dismissedRecommendedPluginScopeKeys.delete(scopeKey);
    }
  });
}

function normalizeItemOrder(items: SidebarItem[]): SidebarItem[] {
  return items.map((item, index) => ({
    ...item,
    order: index,
  }));
}

function createArchiveSuppressedWorktreeKey(
  projectId: string,
  worktreeId: string,
  createdAt?: string,
): string {
  return `${projectId}/${worktreeId}/${createdAt ?? '*'}`;
}

function markArchiveSuppressedWorktree(
  projectId: string,
  worktreeId: string,
  createdAt?: string,
): void {
  const key = createArchiveSuppressedWorktreeKey(
    projectId,
    worktreeId,
    createdAt,
  );
  archiveSuppressedWorktreeKeys.add(key);
  archiveSuppressedChatActivityKeys.add(key);
  activeArchiveSuppressedLoadFilters.forEach((filterKeys) => {
    filterKeys.add(key);
  });
}

function unmarkArchiveSuppressedWorktree(
  projectId: string,
  worktreeId: string,
  createdAt?: string,
  options: { clearActiveLoadFilters?: boolean } = {},
): void {
  const key = createArchiveSuppressedWorktreeKey(
    projectId,
    worktreeId,
    createdAt,
  );
  archiveSuppressedWorktreeKeys.delete(key);
  archiveSuppressedChatActivityKeys.delete(key);
  if (options.clearActiveLoadFilters) {
    activeArchiveSuppressedLoadFilters.forEach((filterKeys) => {
      filterKeys.delete(key);
    });
  }
}

function clearArchiveSuppressedChatActivity(
  projectId: string,
  worktreeId: string,
  createdAt?: string,
): void {
  archiveSuppressedChatActivityKeys.delete(
    createArchiveSuppressedWorktreeKey(projectId, worktreeId, createdAt),
  );
}

function isArchiveSuppressedWorktree(
  projectId: string,
  worktree: WorktreeData,
  suppressedKeys: Set<string>,
): boolean {
  return (
    suppressedKeys.has(
      createArchiveSuppressedWorktreeKey(
        projectId,
        worktree.id,
        worktree.createdAt,
      ),
    ) ||
    suppressedKeys.has(
      createArchiveSuppressedWorktreeKey(projectId, worktree.id),
    )
  );
}

export function isWorktreeArchiveSuppressedForChatActivity(
  projectId: string,
  worktreeId: string,
): boolean {
  const prefix = `${projectId}/${worktreeId}/`;
  return Array.from(archiveSuppressedChatActivityKeys).some((key) =>
    key.startsWith(prefix),
  );
}

function filterArchiveSuppressedWorktrees(
  items: SidebarItem[],
  suppressedKeys: Set<string>,
): SidebarItem[] {
  if (suppressedKeys.size === 0) {
    return items;
  }

  let changed = false;
  const filtered = items.map((item) => {
    if (item.type === 'cowork') {
      return item;
    }

    const worktrees = item.worktrees.filter(
      (worktree) =>
        !isArchiveSuppressedWorktree(item.id, worktree, suppressedKeys),
    );
    if (worktrees.length === item.worktrees.length) {
      return item;
    }
    changed = true;
    return { ...item, worktrees };
  });

  return changed ? filtered : items;
}

function filterVisibleWorkspaceItems(items: SidebarItem[]): SidebarItem[] {
  // Archive & Retention: a temporary workspace whose last worktree was
  // archived stays visible while it still owns archived containers, so the
  // sidebar's Archived subgroup remains reachable. Main's
  // `archived-containers:changed` push refetches sidebar items, dropping the
  // row once its last container expires or is permanently deleted.
  return items.filter((item) => !isRetiredTemporaryWorkspace(item));
}

function reorderVisibleWorktrees(
  worktrees: WorktreeData[],
  activeWorktreeId: string,
  overWorktreeId: string,
): WorktreeData[] {
  const visibleWorktrees = worktrees.filter((worktree) => !worktree.hidden);
  const oldIndex = visibleWorktrees.findIndex(
    (worktree) => worktree.id === activeWorktreeId,
  );
  const newIndex = visibleWorktrees.findIndex(
    (worktree) => worktree.id === overWorktreeId,
  );

  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
    return worktrees;
  }

  const reorderedVisibleWorktrees = arrayMove(
    visibleWorktrees,
    oldIndex,
    newIndex,
  );
  let visibleIndex = 0;

  return worktrees.map((worktree) => {
    if (worktree.hidden) {
      return worktree;
    }

    const nextWorktree = reorderedVisibleWorktrees[visibleIndex];
    visibleIndex += 1;

    return nextWorktree ?? worktree;
  });
}

function flattenCurrentWorktreeGrouping(
  project: SingleRepoSidebarItem | MultiRepoSidebarItem,
  state: Pick<ProjectsState, 'baseBranches' | 'defaultBranches'>,
): WorktreeData[] {
  const visibleWorktrees = project.worktrees.filter(
    (worktree) => !worktree.hidden,
  );
  const flattenHiddenWorktrees =
    project.alwaysShow === false &&
    visibleWorktrees.length === 0 &&
    project.worktrees.length > 0;
  const renderedWorktrees = flattenHiddenWorktrees
    ? project.worktrees
    : visibleWorktrees;
  const baseBranchByWorktreeId = new Map<string, string | null | undefined>();
  const defaultBranchNames = new Set<string>();

  for (const worktree of project.worktrees) {
    const key = createDiffStatsKey(project.id, worktree.id);
    baseBranchByWorktreeId.set(
      worktree.id,
      key in state.baseBranches
        ? state.baseBranches[key]
        : resolveTrackedBaseBranchFallback(project.type, worktree),
    );
    const defaultBranch = state.defaultBranches[key]?.trim();
    if (defaultBranch) {
      defaultBranchNames.add(defaultBranch);
    }
  }

  const grouping = computeWorktreeGroups({
    worktrees: renderedWorktrees,
    baseBranchByWorktreeId,
    defaultBranchNames,
    groupingEnabled: useBranchGroupingPreferenceStore.getState().enabled,
  });
  return flattenVisibleWorktreeGroupOrder(project.worktrees, grouping, {
    includeHidden: flattenHiddenWorktrees,
  });
}

function createWorkspaceDriftKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${projectId}/${worktreeId}`;
}

function createProjectLoadWarningKey(warning: SidebarItemsLoadWarning): string {
  return JSON.stringify([
    warning.code,
    warning.workspaceId,
    warning.code === 'invalid-canopy-json' ? warning.filePath : null,
    warning.reason,
  ]);
}

function mergeLoadedProjectsWithLastGoodState(
  loadedProjects: SidebarItem[],
  previousProjects: SidebarItem[],
  warnings: SidebarItemsLoadWarning[],
): SidebarItem[] {
  const failedWorkspaceIds = new Set(
    warnings.map((warning) => warning.workspaceId),
  );
  if (failedWorkspaceIds.size === 0 || previousProjects.length === 0) {
    return loadedProjects;
  }

  const loadedWorkspaceIds = new Set(
    loadedProjects.map((project) => project.id),
  );
  const preservedProjects = previousProjects.filter(
    (project) =>
      failedWorkspaceIds.has(project.id) && !loadedWorkspaceIds.has(project.id),
  );
  if (preservedProjects.length === 0) {
    return loadedProjects;
  }

  const previousOrderById = new Map(
    [...previousProjects]
      .sort((left, right) => left.order - right.order)
      .map((project, index) => [project.id, index]),
  );
  const newProjectOrderOffset = previousOrderById.size;

  return [...loadedProjects, ...preservedProjects].sort((left, right) => {
    const leftOrder =
      previousOrderById.get(left.id) ?? newProjectOrderOffset + left.order;
    const rightOrder =
      previousOrderById.get(right.id) ?? newProjectOrderOffset + right.order;
    return leftOrder - rightOrder;
  });
}

function updateWorktreeLastKnownPrStatus(
  items: SidebarItem[],
  projectId: string,
  worktreeId: string,
  status: WorktreePrStatus | null,
): SidebarItem[] {
  return items.map((item) => {
    if (item.id !== projectId || item.type === 'cowork') {
      return item;
    }

    return {
      ...item,
      worktrees: item.worktrees.map((worktree) =>
        worktree.id === worktreeId
          ? { ...worktree, lastKnownPrStatus: status }
          : worktree,
      ),
    };
  });
}

function clearWorktreePrStateForBranchChange(
  items: SidebarItem[],
  projectId: string,
  worktreeId: string,
  branchName?: string,
): SidebarItem[] {
  return items.map((item) => {
    if (item.id !== projectId || item.type === 'cowork') {
      return item;
    }

    return {
      ...item,
      worktrees: item.worktrees.map((worktree) => {
        if (worktree.id !== worktreeId) {
          return worktree;
        }

        const nextWorktree = {
          ...worktree,
          ...(branchName !== undefined ? { branchName } : {}),
          lastKnownPrStatus: null,
        };
        delete nextWorktree.status;
        return nextWorktree;
      }),
    };
  });
}

function applyDependentBaseBranchUpdatesToItems(
  items: SidebarItem[],
  updates: DependentBaseBranchUpdate[],
): SidebarItem[] {
  if (updates.length === 0) {
    return items;
  }

  const updatesByWorktree = new Map<string, DependentBaseBranchUpdate[]>();
  for (const update of updates) {
    const key = createDiffStatsKey(update.projectId, update.worktreeId);
    updatesByWorktree.set(key, [...(updatesByWorktree.get(key) ?? []), update]);
  }

  return items.map((item) => {
    if (item.type === 'cowork') {
      return item;
    }

    return {
      ...item,
      worktrees: item.worktrees.map((worktree) => {
        const worktreeUpdates = updatesByWorktree.get(
          createDiffStatsKey(item.id, worktree.id),
        );
        if (!worktreeUpdates || worktreeUpdates.length === 0) {
          return worktree;
        }

        let nextWorktree = worktree;
        for (const update of worktreeUpdates) {
          if (update.repoId) {
            const currentBase =
              nextWorktree.trackedRepoBaseBranches?.[update.repoId];
            if (currentBase === update.nextBaseBranch) {
              continue;
            }
            if (currentBase !== update.previousBaseBranch) {
              continue;
            }
            nextWorktree = {
              ...nextWorktree,
              trackedRepoBaseBranches: {
                ...(nextWorktree.trackedRepoBaseBranches ?? {}),
                [update.repoId]: update.nextBaseBranch,
              },
              ...(update.branchGroupingParentWorktreeId
                ? {
                    branchGroupingParentWorktreeId:
                      update.branchGroupingParentWorktreeId,
                  }
                : {}),
            };
            continue;
          }

          if (nextWorktree.trackedBaseBranch === update.nextBaseBranch) {
            continue;
          }
          if (nextWorktree.trackedBaseBranch !== update.previousBaseBranch) {
            continue;
          }
          nextWorktree = {
            ...nextWorktree,
            trackedBaseBranch: update.nextBaseBranch,
            ...(update.branchGroupingParentWorktreeId
              ? {
                  branchGroupingParentWorktreeId:
                    update.branchGroupingParentWorktreeId,
                }
              : {}),
          };
        }

        return nextWorktree;
      }),
    };
  });
}

function applyDependentBaseBranchUpdatesToDiffStatsState(
  state: Pick<
    ProjectsState,
    | 'baseBranches'
    | 'repoBranches'
    | 'baseBranchExistsLocally'
    | 'baseBranchExistsInRemote'
  >,
  updates: DependentBaseBranchUpdate[],
): Pick<
  ProjectsState,
  | 'baseBranches'
  | 'repoBranches'
  | 'baseBranchExistsLocally'
  | 'baseBranchExistsInRemote'
> {
  let nextBaseBranches = state.baseBranches;
  let nextRepoBranches = state.repoBranches;
  let nextBaseBranchExistsLocally = state.baseBranchExistsLocally;
  let nextBaseBranchExistsInRemote = state.baseBranchExistsInRemote;

  const ensureBaseBranchesCopy = (): Record<string, string | null> => {
    if (nextBaseBranches === state.baseBranches) {
      nextBaseBranches = { ...state.baseBranches };
    }
    return nextBaseBranches;
  };
  const ensureRepoBranchesCopy = (): Record<string, RepoBranchInfo[]> => {
    if (nextRepoBranches === state.repoBranches) {
      nextRepoBranches = { ...state.repoBranches };
    }
    return nextRepoBranches;
  };
  const ensureBaseBranchExistsLocallyCopy = (): Record<string, boolean> => {
    if (nextBaseBranchExistsLocally === state.baseBranchExistsLocally) {
      nextBaseBranchExistsLocally = { ...state.baseBranchExistsLocally };
    }
    return nextBaseBranchExistsLocally;
  };
  const ensureBaseBranchExistsInRemoteCopy = (): Record<string, boolean> => {
    if (nextBaseBranchExistsInRemote === state.baseBranchExistsInRemote) {
      nextBaseBranchExistsInRemote = { ...state.baseBranchExistsInRemote };
    }
    return nextBaseBranchExistsInRemote;
  };

  for (const update of updates) {
    const key = createDiffStatsKey(update.projectId, update.worktreeId);

    if (update.repoId) {
      const repoBranches = nextRepoBranches[key];
      if (!repoBranches) {
        continue;
      }

      let changed = false;
      const patchedRepoBranches = repoBranches.map((repoBranch) => {
        if (repoBranch.repoId !== update.repoId) {
          return repoBranch;
        }
        if (
          repoBranch.baseBranch !== update.previousBaseBranch &&
          repoBranch.baseBranch !== update.nextBaseBranch
        ) {
          return repoBranch;
        }
        const nextRepoBranch = {
          ...repoBranch,
          baseBranch: update.nextBaseBranch,
          baseBranchExistsInRemote: true,
        };
        changed =
          changed ||
          nextRepoBranch.baseBranch !== repoBranch.baseBranch ||
          nextRepoBranch.baseBranchExistsInRemote !==
            repoBranch.baseBranchExistsInRemote;
        return nextRepoBranch;
      });

      if (changed) {
        ensureRepoBranchesCopy()[key] = patchedRepoBranches;
      }
      continue;
    }

    const currentBaseBranch = nextBaseBranches[key];
    if (
      currentBaseBranch !== undefined &&
      currentBaseBranch !== update.previousBaseBranch &&
      currentBaseBranch !== update.nextBaseBranch
    ) {
      continue;
    }

    if (currentBaseBranch !== update.nextBaseBranch) {
      ensureBaseBranchesCopy()[key] = update.nextBaseBranch;
    }
    if (nextBaseBranchExistsInRemote[key] !== true) {
      ensureBaseBranchExistsInRemoteCopy()[key] = true;
    }
    if (nextBaseBranchExistsLocally[key] !== true) {
      ensureBaseBranchExistsLocallyCopy()[key] = false;
    }
  }

  return {
    baseBranches: nextBaseBranches,
    repoBranches: nextRepoBranches,
    baseBranchExistsLocally: nextBaseBranchExistsLocally,
    baseBranchExistsInRemote: nextBaseBranchExistsInRemote,
  };
}

function mergePersistedPrStatuses(
  items: SidebarItem[],
  prStatuses: Record<string, WorktreePrStatus | null>,
): SidebarItem[] {
  return items.map((item) => {
    if (item.type === 'cowork') {
      return item;
    }

    return {
      ...item,
      worktrees: item.worktrees.map((worktree) => {
        const key = createDiffStatsKey(item.id, worktree.id);
        if (!Object.prototype.hasOwnProperty.call(prStatuses, key)) {
          return worktree;
        }

        return {
          ...worktree,
          lastKnownPrStatus: prStatuses[key] ?? null,
        };
      }),
    };
  });
}

function updateWorktreeSeenPipelineExecutionIds(
  items: SidebarItem[],
  projectId: string,
  worktreeId: string,
  executionIds: string[],
  mode: 'add' | 'remove',
): SidebarItem[] {
  if (executionIds.length === 0) {
    return items;
  }

  const executionIdSet = new Set(
    executionIds.filter((executionId) => executionId.length > 0),
  );
  if (executionIdSet.size === 0) {
    return items;
  }

  let changed = false;
  const updatedItems = items.map((item) => {
    if (item.id !== projectId || item.type === 'cowork') {
      return item;
    }

    return {
      ...item,
      worktrees: item.worktrees.map((worktree) => {
        if (worktree.id !== worktreeId) {
          return worktree;
        }

        const currentIds = worktree.seenPipelineExecutionIds ?? [];
        if (mode === 'add') {
          const nextIds = Array.from(
            new Set([...currentIds, ...Array.from(executionIdSet)]),
          );
          if (
            nextIds.length === currentIds.length &&
            nextIds.every((id, index) => id === currentIds[index])
          ) {
            return worktree;
          }
          changed = true;
          return {
            ...worktree,
            seenPipelineExecutionIds: nextIds,
          };
        }

        if (currentIds.length === 0) {
          return worktree;
        }

        const nextIds = currentIds.filter((id) => !executionIdSet.has(id));
        if (nextIds.length === currentIds.length) {
          return worktree;
        }
        if (nextIds.length === 0) {
          changed = true;
          const nextWorktree = { ...worktree };
          delete nextWorktree.seenPipelineExecutionIds;
          return nextWorktree;
        }
        changed = true;
        return {
          ...worktree,
          seenPipelineExecutionIds: nextIds,
        };
      }),
    };
  });

  return changed ? updatedItems : items;
}

function pruneStaleSeenPipelineExecutionIds(
  items: SidebarItem[],
  activeExecutionIdsByWorktree: Record<string, Set<string>>,
): SidebarItem[] {
  let changed = false;

  const updatedItems = items.map((item) => {
    if (item.type === 'cowork') {
      return item;
    }

    return {
      ...item,
      worktrees: item.worktrees.map((worktree) => {
        const currentIds = worktree.seenPipelineExecutionIds ?? [];
        if (currentIds.length === 0) {
          return worktree;
        }

        const activeIds =
          activeExecutionIdsByWorktree[`${item.id}/${worktree.id}`] ??
          new Set<string>();
        const nextIds = currentIds.filter((id) => activeIds.has(id));
        if (
          nextIds.length === currentIds.length &&
          nextIds.every((id, index) => id === currentIds[index])
        ) {
          return worktree;
        }

        changed = true;
        if (nextIds.length === 0) {
          const nextWorktree = { ...worktree };
          delete nextWorktree.seenPipelineExecutionIds;
          return nextWorktree;
        }

        return {
          ...worktree,
          seenPipelineExecutionIds: nextIds,
        };
      }),
    };
  });

  return changed ? updatedItems : items;
}

function formatProjectLoadWarningMessage(
  warning: SidebarItemsLoadWarning,
): string {
  if (warning.code === 'invalid-canopy-json') {
    return `Could not refresh project "${warning.workspaceName}" because ${warning.filePath} is invalid: ${warning.reason}. Fix canopy.json and reload projects. Showing the last loaded data when available.`;
  }
  return `Could not refresh project "${warning.workspaceName}": ${warning.reason}. Showing the last loaded data when available.`;
}

function omitAppliedProjectWorktreeScriptsForPrefix(
  entries: AppliedProjectWorktreeScripts,
  prefix: string,
): AppliedProjectWorktreeScripts {
  const nextEntries: AppliedProjectWorktreeScripts = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(prefix)) {
      nextEntries[key] = value;
    }
  }
  return nextEntries;
}

function omitAppliedProjectWorktreeScriptsForKey(
  entries: AppliedProjectWorktreeScripts,
  keyToRemove: string,
): AppliedProjectWorktreeScripts {
  const nextEntries: AppliedProjectWorktreeScripts = {};
  for (const [key, value] of Object.entries(entries)) {
    if (key !== keyToRemove) {
      nextEntries[key] = value;
    }
  }
  return nextEntries;
}

function omitAppliedProjectWorktreeHooksForPrefix(
  entries: AppliedProjectWorktreeHooks,
  prefix: string,
): AppliedProjectWorktreeHooks {
  const nextEntries: AppliedProjectWorktreeHooks = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(prefix)) {
      nextEntries[key] = value;
    }
  }
  return nextEntries;
}

function omitAppliedProjectWorktreeHooksForKey(
  entries: AppliedProjectWorktreeHooks,
  keyToRemove: string,
): AppliedProjectWorktreeHooks {
  const nextEntries: AppliedProjectWorktreeHooks = {};
  for (const [key, value] of Object.entries(entries)) {
    if (key !== keyToRemove) {
      nextEntries[key] = value;
    }
  }
  return nextEntries;
}

type CreatedWorktreeRegistration = {
  id: string;
  branchName: string;
  createdAt?: string;
  trackedBaseBranch?: string | null;
  trackedRepoBaseBranches?: Record<string, string>;
  effectiveScripts?: ScriptOverrides;
  effectiveHooks?: HookOverrides;
  worktreeEffective?: WorktreeEffectiveOverrides;
  /**
   * Two-phase creation marker forwarded from the IPC response. When
   * `'git-pending'`, the renderer renders a "setting up" pill on the row
   * and queues subsequent chat/pipeline work until a `worktree:git-ready`
   * event arrives. Defaults to `'git-ready'` for back-compat with the
   * synchronous repair path and any callers that haven't been updated.
   */
  setupPhase?: 'git-pending' | 'git-ready';
};

export interface CreateWorktreeOptions {
  sidebarItemGroupId?: string;
  baseWorktreeId?: string;
  baseBranch?: string;
  select?: boolean;
  existingBranch?: string;
  branchName?: string;
  suggestedBranch?: string;
  /** Skip automatic start-page opening because creation already has a prompt. */
  suppressStartPage?: boolean;
  /**
   * Fires synchronously after the new row has entered renderer state and the
   * default selection, when enabled, has been applied, but before persistence
   * and post-create refreshes finish. UI entry points use this milestone to
   * reveal the usable worktree without waiting on the remainder of setup.
   */
  onRegistered?: (worktree: WorktreeData) => void;
}

export async function finalizeCreatedWorktree(
  projectId: string,
  created: CreatedWorktreeRegistration,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
  options: Pick<
    CreateWorktreeOptions,
    'select' | 'onRegistered' | 'suppressStartPage'
  > & {
    eagerChat?: boolean;
  } = {},
): Promise<WorktreeData | null> {
  if (options.suppressStartPage) {
    markStartPageSuppressed(`${projectId}/${created.id}`);
  }
  const lifecycleKey = createWorktreeLifecycleKey(projectId, created.id);
  const bufferedFailedEvent = bufferedWorktreeGitFailedEvents.get(lifecycleKey);
  if (bufferedFailedEvent) {
    bufferedWorktreeGitFailedEvents.delete(lifecycleKey);
  }

  const bufferedReadyEvent = bufferedWorktreeGitReadyEvents.get(lifecycleKey);
  if (bufferedReadyEvent) {
    bufferedWorktreeGitReadyEvents.delete(lifecycleKey);
  }

  const existingProject = get().projects.find(
    (project) => project.id === projectId,
  );
  const existingWorktree =
    existingProject && existingProject.type !== 'cowork'
      ? existingProject.worktrees.find(
          (candidate) => candidate.id === created.id,
        )
      : undefined;
  const existingWorktreeEffective =
    existingProject && existingProject.type !== 'cowork'
      ? existingProject.worktreeEffective?.[created.id]
      : undefined;
  const worktree: WorktreeData = {
    ...existingWorktree,
    id: created.id,
    branchName:
      bufferedReadyEvent?.branchName ??
      existingWorktree?.branchName ??
      created.branchName,
    // Preserve the backend reservation timestamp so deferred Phase B freshness
    // checks still match after the renderer saves the pending row.
    createdAt:
      created.createdAt ??
      existingWorktree?.createdAt ??
      new Date().toISOString(),
    setupPhase:
      bufferedReadyEvent || bufferedFailedEvent
        ? 'git-ready'
        : (existingWorktree?.setupPhase ?? created.setupPhase ?? 'git-ready'),
    ...(bufferedFailedEvent?.healthIssue
      ? { healthIssue: bufferedFailedEvent.healthIssue }
      : {}),
    ...(created.trackedBaseBranch != null
      ? { trackedBaseBranch: created.trackedBaseBranch }
      : {}),
    ...(created.trackedRepoBaseBranches
      ? { trackedRepoBaseBranches: created.trackedRepoBaseBranches }
      : {}),
  };
  if (bufferedReadyEvent) {
    delete worktree.healthIssue;
  }

  const updatedProjects = get().projects.map((project) => {
    if (project.id !== projectId || project.type === 'cowork') {
      return project;
    }

    const worktreeEffective =
      bufferedReadyEvent?.worktreeEffective ??
      getCreatedWorktreeEffective(created) ??
      existingWorktreeEffective;
    const nextWorktrees = project.worktrees.some(
      (candidate) => candidate.id === worktree.id,
    )
      ? project.worktrees.map((candidate) =>
          candidate.id === worktree.id ? worktree : candidate,
        )
      : // Mirrors main: a new worktree leads the persisted manual order.
        [worktree, ...project.worktrees];

    if (worktreeEffective) {
      return {
        ...project,
        collapsed: false,
        worktrees: nextWorktrees,
        worktreeEffective: {
          ...(project.worktreeEffective ?? {}),
          [worktree.id]: worktreeEffective,
        },
      };
    }

    return {
      ...project,
      collapsed: false,
      worktrees: nextWorktrees,
    };
  });

  // Seed the resolved base branch immediately so a "Branch from" worktree shows
  // its base branch and nests under its parent right away, without waiting for
  // the first diff-stats refresh (which only lands after git setup completes).
  // The branch name itself stays the default "New Task" label until renamed.
  const seededBaseBranch = worktree.trackedBaseBranch;
  set({
    projects: updatedProjects,
    pendingScrollToWorktree: {
      projectId,
      worktreeId: worktree.id,
      reason: 'created',
    },
    ...(seededBaseBranch
      ? {
          baseBranches: {
            ...get().baseBranches,
            [createDiffStatsKey(projectId, worktree.id)]: seededBaseBranch,
          },
        }
      : {}),
  });
  if (options.select !== false) {
    if (options.eagerChat && !existingWorktree && !bufferedFailedEvent) {
      useChatStore
        .getState()
        .selectWorktree(projectId, worktree.id, { newlyCreated: true });
    } else {
      useChatStore.getState().selectWorktree(projectId, worktree.id);
    }
  }
  options.onRegistered?.(worktree);
  if (bufferedFailedEvent) {
    set({
      worktreeError: worktreeGitFailedNotice(
        bufferedFailedEvent,
        get().projects,
      ),
    });
  }
  await get().saveProjects(updatedProjects);
  if (worktree.setupPhase !== 'git-pending') {
    await get().refreshDiffStats();
    // Workspace drift measures how far a worktree's checkout has diverged
    // from its source. A `git-pending` reservation has no checkout yet (its
    // directory does not exist), so drift for it is meaningless — and because
    // this fans an IPC + git computation out across EVERY existing worktree
    // in the workspace, awaiting it here is exactly the multi-second "frozen
    // on Home" stall the new-worktree Home send hit on real repos (Task H1;
    // test fixtures with 0–1 worktrees barely felt it, which is why earlier
    // rounds could not reproduce it). Deferred to the git-ready event, which
    // fires the same refresh once the checkout actually exists — mirroring
    // the diff-stats gate above and below.
    await get().refreshWorkspaceDrift(updatedProjects);
  }
  if (worktree.setupPhase !== 'git-pending') {
    // After a fresh worktree is registered, check whether any chat hook
    // actions reference shareable plugins/skills that aren't installed
    // locally yet. The inspector returns nothing actionable when there are
    // no chat hooks at all, so this is cheap when unused.
    void get().inspectHookChatPluginDependencies(
      projectId,
      worktree.id,
      worktree.branchName,
    );
    // Same for source-controlled `canopy.json.plugins` recommendations.
    // The inspector returns nothing actionable when no recommendations are
    // declared, so this is also cheap when unused.
    void get().inspectRecommendedPlugins(projectId, worktree.id);
  }
  const trailingFailedEvent = bufferedWorktreeGitFailedEvents.get(lifecycleKey);
  if (trailingFailedEvent) {
    bufferedWorktreeGitFailedEvents.delete(lifecycleKey);
    applyWorktreeGitFailedEvent(trailingFailedEvent, get, set);
    const finalProject = get().projects.find(
      (project) => project.id === projectId,
    );
    return (
      (finalProject && finalProject.type !== 'cowork'
        ? finalProject.worktrees.find(
            (candidate) => candidate.id === worktree.id,
          )
        : undefined) ?? null
    );
  }

  const trailingReadyEvent = bufferedWorktreeGitReadyEvents.get(lifecycleKey);
  if (trailingReadyEvent) {
    bufferedWorktreeGitReadyEvents.delete(lifecycleKey);
    void applyWorktreeGitReadyEvent(trailingReadyEvent, get, set);
  }
  return worktree;
}

function markWorktreeGitReady(
  worktree: WorktreeData,
  branchName: string,
): WorktreeData {
  const nextWorktree = {
    ...worktree,
    setupPhase: 'git-ready' as const,
    branchName,
  };
  delete nextWorktree.healthIssue;
  return nextWorktree;
}

function markWorktreeGitFailed(
  worktree: WorktreeData,
  healthIssue: WorktreeHealthIssue | undefined,
): WorktreeData {
  return {
    ...worktree,
    setupPhase: 'git-ready',
    ...(healthIssue ? { healthIssue } : {}),
  };
}

function hasWorktreeRow(
  projects: SidebarItem[],
  projectId: string,
  worktreeId: string,
): boolean {
  return projects.some(
    (project) =>
      project.id === projectId &&
      project.type !== 'cowork' &&
      project.worktrees.some((worktree) => worktree.id === worktreeId),
  );
}

function getCreatedWorktreeEffective(created: {
  effectiveScripts?: ScriptOverrides;
  effectiveHooks?: HookOverrides;
  worktreeEffective?: WorktreeEffectiveOverrides;
}): WorktreeEffectiveOverrides | undefined {
  if (created.worktreeEffective) {
    return created.worktreeEffective;
  }

  if (
    created.effectiveScripts === undefined &&
    created.effectiveHooks === undefined
  ) {
    return undefined;
  }

  return {
    ...(created.effectiveScripts !== undefined
      ? { effectiveScripts: created.effectiveScripts }
      : {}),
    ...(created.effectiveHooks !== undefined
      ? { effectiveHooks: created.effectiveHooks }
      : {}),
  };
}

function applyWorktreeGitReadyEvent(
  event: WorktreeGitReadyEvent,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): boolean {
  const { projectId, worktreeId, branchName } = event;
  if (!hasWorktreeRow(get().projects, projectId, worktreeId)) {
    // The main-process lifecycle event is authoritative even when a concurrent
    // project refresh has temporarily omitted the just-reserved row. Release
    // setup-gated work immediately; the buffered event and silent reload below
    // will reconcile the sidebar row independently.
    void usePipelineRunsStore
      .getState()
      .flushPendingForWorktree(projectId, worktreeId);
    return false;
  }

  set({
    projects: get().projects.map((project) => {
      if (project.id !== projectId || project.type === 'cowork') {
        return project;
      }
      const updatedProject = {
        ...project,
        worktrees: project.worktrees.map((wt) =>
          wt.id === worktreeId ? markWorktreeGitReady(wt, branchName) : wt,
        ),
      };

      if (!event.worktreeEffective) {
        return updatedProject;
      }

      return {
        ...updatedProject,
        worktreeEffective: {
          ...(project.worktreeEffective ?? {}),
          [worktreeId]: event.worktreeEffective,
        },
      };
    }),
  });
  useChatStore.getState().refreshWorktreeTabDiscoveries(projectId, worktreeId);
  // Phase B just fetched/resolved the source ref before creating the checkout.
  // Reuse that fresh local state instead of starting another network fetch at
  // the exact Git-ready/setup-script boundary.
  void get().refreshWorktreeDiffStats(projectId, worktreeId);
  // Drift was deferred from the pending-creation finalize (see
  // finalizeCreatedWorktree) because the checkout did not exist yet — refresh
  // it now that git setup has landed (fire-and-forget, mirrors diff stats).
  void get().refreshWorkspaceDrift();
  void get().inspectHookChatPluginDependencies(
    projectId,
    worktreeId,
    branchName,
  );
  void get().inspectRecommendedPlugins(projectId, worktreeId);

  drainPendingTaskBranchNaming(projectId, worktreeId, get);

  void usePipelineRunsStore
    .getState()
    .flushPendingForWorktree(projectId, worktreeId);
  return true;
}

function applyWorktreeBranchChangedEvent(
  event: WorktreeBranchChangedEvent,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): void {
  const key = createDiffStatsKey(event.projectId, event.worktreeId);
  if (event.repoId) {
    const currentRepoBranches = get().repoBranches[key];
    if (currentRepoBranches) {
      set({
        repoBranches: {
          ...get().repoBranches,
          [key]: currentRepoBranches.map((repoBranch) =>
            repoBranch.repoId === event.repoId
              ? { ...repoBranch, branch: event.branchName }
              : repoBranch,
          ),
        },
      });
    }
  }

  if (!event.repoId || event.repoId === WORKSPACE_ROOT_REPO_ID) {
    set({
      projects: clearWorktreePrStateForBranchChange(
        get().projects,
        event.projectId,
        event.worktreeId,
        event.branchName,
      ),
    });
  } else {
    set({
      projects: clearWorktreePrStateForBranchChange(
        get().projects,
        event.projectId,
        event.worktreeId,
      ),
    });
  }

  useGitHubStore
    .getState()
    .clearWorktreePrStatus(event.projectId, event.worktreeId);
  void get().refreshWorktreeDiffStatsFromRemote(
    event.projectId,
    event.worktreeId,
  );
  void requestLoadedChangedFilesRefresh(event.projectId, event.worktreeId);
  void useGitHubStore
    .getState()
    .requestFastRefresh(event.projectId, event.worktreeId);
}

function applyWorkspaceWorktreeUpdatedEvent(
  event: WorkspaceWorktreesUpdatedEvent,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): boolean {
  const updatedWorktrees = event.worktrees;
  if (updatedWorktrees) {
    let applied = false;
    const projects = filterArchiveSuppressedWorktrees(
      get().projects.map((project) => {
        if (project.id !== event.workspaceId || project.type === 'cowork') {
          return project;
        }
        applied = true;
        return { ...project, worktrees: updatedWorktrees };
      }),
      archiveSuppressedWorktreeKeys,
    );
    if (applied) {
      setSharedProjects(projects, get, set);
    }
    return applied;
  }

  const updatedWorktree = event.worktree;
  if (!updatedWorktree) {
    return false;
  }

  let applied = false;
  const projects = get().projects.map((project) => {
    if (project.id !== event.workspaceId || project.type === 'cowork') {
      return project;
    }

    let projectApplied = false;
    const worktrees = project.worktrees.map((worktree) => {
      if (worktree.id !== updatedWorktree.id) {
        return worktree;
      }
      applied = true;
      projectApplied = true;
      return updatedWorktree;
    });

    return projectApplied ? { ...project, worktrees } : project;
  });

  if (applied) {
    setSharedProjects(projects, get, set);
  }
  return applied;
}

/** Applies an event's projects, keeping unchanged objects (and no-op events) as they were. */
function setSharedProjects(
  next: SidebarItem[],
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): void {
  const previous = get().projects;
  const projects = shareUnchangedProjects(previous, next);
  if (projects !== previous) set({ projects });
}

/**
 * The notice for a failed worktree setup. The source name follows the event's
 * own project and child source, not the selected project, so a late or
 * buffered event still names the source that failed.
 */
function worktreeGitFailedNotice(
  event: WorktreeGitFailedEvent,
  projects: SidebarItem[],
): InlineFailure {
  const details = event.error.trim();
  const project = projects.find((item) => item.id === event.projectId);
  const sourceName =
    project?.type === 'multi-repo' && event.sourceRepoId
      ? project.repos.find((repo) => repo.id === event.sourceRepoId)?.name
      : project?.name;
  const error = formatWorktreePrepareFailure({
    // Storage keeps its own handling; only the source reason changes the copy.
    ...(event.failureReason === 'source-no-commits'
      ? { reason: event.failureReason }
      : {}),
    ...(sourceName ? { sourceName } : {}),
    hasDetails: details !== '',
  });
  return details === '' ? { error } : { error, details: event.error };
}

function applyWorktreeGitFailedEvent(
  event: WorktreeGitFailedEvent,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): boolean {
  const { projectId, worktreeId } = event;

  // Main ends a turn it held for this setup as failed, in the chat itself, so
  // the chat state stays.
  usePipelineRunsStore.getState().dropPendingForWorktree(projectId, worktreeId);
  get().clearPendingTaskBranchNaming(projectId, worktreeId);

  if (!hasWorktreeRow(get().projects, projectId, worktreeId)) {
    set({ worktreeError: worktreeGitFailedNotice(event, get().projects) });
    return false;
  }

  set({
    projects: get().projects.map((project) => {
      if (project.id !== projectId || project.type === 'cowork') {
        return project;
      }
      return {
        ...project,
        worktrees: project.worktrees.map((worktree) =>
          worktree.id === worktreeId
            ? markWorktreeGitFailed(worktree, event.healthIssue)
            : worktree,
        ),
      };
    }),
    worktreeError: worktreeGitFailedNotice(event, get().projects),
  });
  return true;
}

/**
 * Consumes a deferred-creation `worktree:needs-repair` event (Task I1). The
 * deferred source-backed multi-repo Phase B created the workspace-root checkout
 * but found blocking repair issues. Main keeps the reservation as a
 * `git-pending`, recovery-required row (and the root checkout for the repair
 * flow to reuse); a later projects reload can show that pending row again.
 * Hide it here: drop the worktree row and selection, then open the
 * existing repair modal via `pendingWorkspaceRepair` (whose
 * `repairPendingWorkspaceWorktree` flow repairs the root checkout and creates
 * the child repos).
 *
 * Pending setup state (chat tabs and queued pipeline runs) is deliberately
 * KEPT: the repair flow reuses the same `worktreeId`, so a successful repair
 * re-adds the row, re-selects it, and flushes the queued pipeline runs, while
 * main releases any chat turn it held for the setup. Only a cancelled repair
 * (`cancelPendingWorkspaceRepair`) tears the pending setup state down.
 */
function applyWorktreeNeedsRepairEvent(
  event: WorktreeNeedsRepairEvent,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): void {
  const { projectId, worktreeId, branchName, repairIssues } = event;

  const project = get().projects.find(
    (candidate) => candidate.id === projectId,
  );
  const workspaceName = project ? getWorkspaceDisplayName(project) : projectId;

  // The row is about to disappear; a selection pointing at it would strand
  // the Code page on a nonexistent worktree behind the repair modal.
  const selection = useChatStore.getState().selectedWorktree;
  if (
    selection?.projectId === projectId &&
    selection.worktreeId === worktreeId
  ) {
    useChatStore.getState().deselectWorktree();
  }

  set({
    projects: get().projects.map((candidate) => {
      if (candidate.id !== projectId || candidate.type === 'cowork') {
        return candidate;
      }
      return {
        ...candidate,
        worktrees: candidate.worktrees.filter((wt) => wt.id !== worktreeId),
      };
    }),
    pendingWorkspaceRepair: {
      workspaceId: projectId,
      workspaceName,
      id: worktreeId,
      branchName,
      repairIssues,
      ...(event.existingBranch ? { existingBranch: event.existingBranch } : {}),
      ...(event.trackedRepoBaseBranches
        ? { trackedRepoBaseBranches: event.trackedRepoBaseBranches }
        : {}),
    },
  });

  useGitHubStore
    .getState()
    .addToast(
      'Worktree needs repair before setup can finish.',
      'warning',
      undefined,
      { workspaceName },
    );
}

async function runTeardown(
  item: SidebarItem,
  projectId: string,
  worktreeId: string,
  appliedProjectWorktreeScripts: AppliedProjectWorktreeScripts,
): Promise<void> {
  if (item.type === 'single-repo') {
    const effectiveScripts = getSingleRepoDisplayScripts(
      item,
      worktreeId,
      appliedProjectWorktreeScripts,
    );
    const command = getScriptCommand(effectiveScripts, 'teardown');
    if (command) {
      const script = createProjectScriptDescriptor(
        'teardown',
        command,
        getScriptDevServerPattern(effectiveScripts, 'teardown'),
        getScriptShellDefinition(effectiveScripts, 'teardown'),
        getScriptInteractive(effectiveScripts, 'teardown'),
      );
      const result = await runTrackedScript(
        projectId,
        worktreeId,
        script,
        window.api.runScript({
          target: 'project',
          scriptName: 'teardown',
          projectId,
          worktreeId,
        }),
      );
      if (!result.success) {
        throw new TeardownFailedError({
          projectId,
          worktreeId,
          output: result.output,
          timedOut: result.timedOut,
        });
      }
    }
  } else {
    if (item.type === 'cowork') {
      throw new TeardownFailedError({
        projectId,
        worktreeId,
        output: 'Cowork projects have no teardown script to run.',
        timedOut: false,
      });
    }
    await runWorkspaceLifecycle({
      item,
      workspaceId: projectId,
      worktreeId,
      lifecycle: 'teardown',
      alreadyRunningMessage: 'Project teardown is already running',
      createRootFailure: (response): Error =>
        new TeardownFailedError({
          projectId,
          worktreeId,
          repoName: WORKSPACE_ROOT_REPO_NAME,
          output: response.output,
          timedOut: response.timedOut,
        }),
      createRepoFailure: (repo, response): Error =>
        new TeardownFailedError({
          projectId,
          worktreeId,
          repoId: repo.id,
          repoName: repo.name,
          output: response.output,
          timedOut: response.timedOut,
        }),
    });
  }
}

async function runTrackedScript(
  projectId: string,
  worktreeId: string,
  script: ReturnType<
    | typeof createProjectScriptDescriptor
    | typeof createWorkspaceRootScriptDescriptor
    | typeof createWorkspaceRepoScriptDescriptor
  >,
  request: Promise<ScriptRunResponse>,
): Promise<ScriptRunResponse> {
  const scriptsState = useScriptsStore.getState();
  scriptsState.startRun(projectId, worktreeId, script);

  try {
    const result = await request;
    scriptsState.completeRun(projectId, worktreeId, script.scriptKey, result);
    if (result.success) {
      useFileListStore.getState().invalidate(projectId, worktreeId);
      if (shouldRefreshDiscoveryAfterScriptLifecycle(script.lifecycle)) {
        useChatStore
          .getState()
          .queueWorktreeTabDiscoveryRefresh(projectId, worktreeId);
      }
    }
    return result;
  } catch (error) {
    const failure: ScriptRunResponse = {
      success: false,
      exitCode: null,
      output: error instanceof Error ? error.message : String(error),
      timedOut: false,
      durationMs: 0,
    };
    scriptsState.completeRun(projectId, worktreeId, script.scriptKey, failure);
    throw error;
  }
}

function getDisplayScripts(
  baseEffectiveScripts: ScriptOverrides | undefined,
  worktreeEffectiveScripts: ScriptOverrides | undefined,
): ScriptOverrides | undefined {
  if (
    worktreeEffectiveScripts &&
    Object.keys(worktreeEffectiveScripts).length > 0
  ) {
    return worktreeEffectiveScripts;
  }

  return baseEffectiveScripts;
}

function getSingleRepoDisplayScripts(
  item: SingleRepoSidebarItem,
  worktreeId: string,
  appliedProjectWorktreeScripts: AppliedProjectWorktreeScripts,
): ScriptOverrides | undefined {
  const worktreeEffective = item.worktreeEffective?.[worktreeId];
  return getDisplayScripts(
    getSingleRepoWorktreeEffectiveScripts(
      item,
      worktreeId,
      appliedProjectWorktreeScripts,
    ),
    worktreeEffective?.effectiveScripts,
  );
}

export function drainPendingTaskBranchNaming(
  projectId: string,
  worktreeId: string,
  get: () => ProjectsState,
): void {
  const branchKey = createWorktreeLifecycleKey(projectId, worktreeId);
  const pending = get().pendingTaskBranchNamings[branchKey];
  if (pending === undefined) {
    return;
  }

  void window.api.scheduleTaskBranchNaming({
    projectId,
    worktreeId,
    text: pending.text,
    ...(pending.chatId ? { chatId: pending.chatId } : {}),
    ...(pending.selectedRepoId
      ? { selectedRepoId: pending.selectedRepoId }
      : {}),
  });
  get().clearPendingTaskBranchNaming(projectId, worktreeId);
}

function getWorkspaceBeforeScriptName(
  lifecycle: ProjectLifecycleScriptName,
): string {
  return `before-${lifecycle}`;
}

function getWorkspaceAfterScriptName(
  lifecycle: ProjectLifecycleScriptName,
): string {
  return `after-${lifecycle}`;
}

function createWorkspaceLifecycleError(
  lifecycle: ProjectLifecycleScriptName,
  response: ScriptRunResponse,
): Error {
  return new Error(response.output || `Project ${lifecycle} failed`);
}

function createRejectedWorkspaceLifecycleError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function hasWorkspaceLifecycleScripts(
  item: MultiRepoSidebarItem,
  worktreeId: string,
  lifecycle: ProjectLifecycleScriptName,
): boolean {
  const worktreeEffective = item.worktreeEffective?.[worktreeId];
  const rootScripts = getDisplayScripts(
    item.effectiveScripts,
    worktreeEffective?.effectiveScripts,
  );
  if (
    getScriptCommand(rootScripts, getWorkspaceBeforeScriptName(lifecycle)) ||
    getScriptCommand(rootScripts, getWorkspaceAfterScriptName(lifecycle))
  ) {
    return true;
  }

  return item.repos.some((repo) => {
    const repoScripts = getDisplayScripts(
      repo.effectiveScripts,
      worktreeEffective?.repos?.[repo.id]?.effectiveScripts,
    );
    return Boolean(getScriptCommand(repoScripts, lifecycle));
  });
}

function getSettledWorkspaceLifecycleFailure(
  results: PromiseSettledResult<{
    repo: WorkspaceRepoData;
    response: ScriptRunResponse;
  }>[],
  createRepoFailure: (
    repo: WorkspaceRepoData,
    response: ScriptRunResponse,
  ) => Error,
): Error | null {
  for (const result of results) {
    if (result.status === 'rejected') {
      return createRejectedWorkspaceLifecycleError(result.reason);
    }

    if (!result.value.response.success) {
      return createRepoFailure(result.value.repo, result.value.response);
    }
  }

  return null;
}

async function runWorkspaceLifecycle(options: {
  item: MultiRepoSidebarItem;
  workspaceId: string;
  worktreeId: string;
  lifecycle: ProjectLifecycleScriptName;
  alreadyRunningMessage: string;
  createRootFailure: (response: ScriptRunResponse) => Error;
  createRepoFailure: (
    repo: WorkspaceRepoData,
    response: ScriptRunResponse,
  ) => Error;
}): Promise<void> {
  const worktreeRuns =
    useScriptsStore.getState().runs[
      `${options.workspaceId}/${options.worktreeId}`
    ];
  if (hasActiveWorkspaceLifecycleRun(worktreeRuns, options.lifecycle)) {
    throw new Error(options.alreadyRunningMessage);
  }

  const worktreeEffective =
    options.item.worktreeEffective?.[options.worktreeId];
  const rootScripts = getDisplayScripts(
    options.item.effectiveScripts,
    worktreeEffective?.effectiveScripts,
  );

  const beforeScriptName = getWorkspaceBeforeScriptName(options.lifecycle);
  const beforeScript = getScriptCommand(rootScripts, beforeScriptName);
  if (beforeScript) {
    const result = await runTrackedScript(
      options.workspaceId,
      options.worktreeId,
      createWorkspaceRootScriptDescriptor(
        beforeScriptName,
        beforeScript,
        getScriptDevServerPattern(rootScripts, beforeScriptName),
        getScriptShellDefinition(rootScripts, beforeScriptName),
        getScriptInteractive(rootScripts, beforeScriptName),
      ),
      window.api.runScript({
        target: 'workspace-root',
        scriptName: beforeScriptName,
        workspaceId: options.workspaceId,
        worktreeId: options.worktreeId,
      }),
    );
    if (!result.success) {
      throw options.createRootFailure(result);
    }
  }

  const childRuns: Array<
    Promise<{ repo: WorkspaceRepoData; response: ScriptRunResponse }>
  > = [];
  for (const repo of options.item.repos) {
    const repoScripts = getDisplayScripts(
      repo.effectiveScripts,
      worktreeEffective?.repos?.[repo.id]?.effectiveScripts,
    );
    const command = getScriptCommand(repoScripts, options.lifecycle);
    if (!command) {
      continue;
    }

    childRuns.push(
      runTrackedScript(
        options.workspaceId,
        options.worktreeId,
        createWorkspaceRepoScriptDescriptor(
          repo.id,
          repo.name,
          options.lifecycle,
          command,
          getScriptDevServerPattern(repoScripts, options.lifecycle),
          getScriptShellDefinition(repoScripts, options.lifecycle),
          getScriptInteractive(repoScripts, options.lifecycle),
        ),
        window.api.runScript({
          target: 'workspace-repo',
          scriptName: options.lifecycle,
          workspaceId: options.workspaceId,
          worktreeId: options.worktreeId,
          repoId: repo.id,
        }),
      ).then((response) => ({ repo, response })),
    );
  }

  const childResults = await Promise.allSettled(childRuns);
  const childFailure = getSettledWorkspaceLifecycleFailure(
    childResults,
    options.createRepoFailure,
  );
  if (childFailure) {
    throw childFailure;
  }

  const afterScriptName = getWorkspaceAfterScriptName(options.lifecycle);
  const afterScript = getScriptCommand(rootScripts, afterScriptName);
  if (afterScript) {
    const result = await runTrackedScript(
      options.workspaceId,
      options.worktreeId,
      createWorkspaceRootScriptDescriptor(
        afterScriptName,
        afterScript,
        getScriptDevServerPattern(rootScripts, afterScriptName),
        getScriptShellDefinition(rootScripts, afterScriptName),
        getScriptInteractive(rootScripts, afterScriptName),
      ),
      window.api.runScript({
        target: 'workspace-root',
        scriptName: afterScriptName,
        workspaceId: options.workspaceId,
        worktreeId: options.worktreeId,
      }),
    );
    if (!result.success) {
      throw options.createRootFailure(result);
    }
  }
}

/**
 * Removal takes priority over a worktree's automatic setup, so main cancels
 * the whole setup sequence before anything else runs. `stopRunningScripts`
 * cannot do it: this store tracks runs only for worktrees whose runs are
 * loaded (a row removed from the sidebar is often not the open one), and
 * stopping just the running step lets setup start its next one. Best effort;
 * the archive in main drains anything still running.
 */
async function cancelWorktreeSetup(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  try {
    await window.api.cancelWorktreeSetup({ projectId, worktreeId });
  } catch {
    // The archive itself still fences and drains setup.
  }
}

async function stopRunningScripts(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const worktreeRuns =
    useScriptsStore.getState().runs[`${projectId}/${worktreeId}`];
  if (!worktreeRuns) return;

  const runningScriptKeys = Object.entries(worktreeRuns)
    .filter(([, run]) => isScriptRunActive(run.status))
    .map(([scriptKey]) => scriptKey);

  if (runningScriptKeys.length === 0) return;

  await Promise.all(
    runningScriptKeys.map(async (scriptKey) => {
      try {
        const response = await window.api.stopScript({
          projectId,
          worktreeId,
          scriptKey,
        });
        const scriptsState = useScriptsStore.getState();
        if (response) {
          scriptsState.completeRun(projectId, worktreeId, scriptKey, response);
        } else {
          scriptsState.completeStaleRun(projectId, worktreeId, scriptKey);
        }
      } catch {
        useScriptsStore
          .getState()
          .completeStaleRun(projectId, worktreeId, scriptKey);
      }
    }),
  );
}

async function stopRunningHooks(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const worktreeRuns =
    useHooksStore.getState().runs[`${projectId}/${worktreeId}`];
  if (!worktreeRuns) return;

  const runningHookKeys = Object.entries(worktreeRuns)
    .filter(([, run]) => run.status === 'running')
    .map(([hookKey]) => hookKey);

  if (runningHookKeys.length === 0) return;

  await Promise.all(
    runningHookKeys.map(async (hookKey) => {
      const response = await window.api.stopHook({
        projectId,
        worktreeId,
        hookKey,
      });
      if (response) {
        useHooksStore
          .getState()
          .completeRun(projectId, worktreeId, hookKey, response);
      }
    }),
  );
}

function refreshRestoredWorktreeActivity(
  projectId: string,
  worktreeId: string,
): void {
  void requestChangedFilesRefresh(projectId, worktreeId).catch(
    (error: unknown) => {
      reportClientAppError(error);
    },
  );
}

/**
 * Marks the row busy, then runs main's read-only source admission before any
 * other removal effect (CAN-5333). A refusal unmarks the row and rejects.
 */
async function markArchivingAndAdmitSource(
  archiveKey: string,
  projectId: string,
  worktreeId: string,
  kind: 'single-repo' | 'multi-repo',
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): Promise<void> {
  set({
    archivingWorktrees: new Set(get().archivingWorktrees).add(archiveKey),
  });
  try {
    await assertWorktreeRemovalAdmitted(projectId, worktreeId, kind);
  } catch (error) {
    const archivingWorktrees = new Set(get().archivingWorktrees);
    archivingWorktrees.delete(archiveKey);
    set({ archivingWorktrees });
    throw error;
  }
  clearWorktreeActivity(projectId, worktreeId);
}

function deselectIfSelectedWorktree(
  projectId: string,
  worktreeId: string,
): void {
  const selected = useChatStore.getState().selectedWorktree;
  if (selected?.projectId === projectId && selected.worktreeId === worktreeId) {
    useChatStore.getState().deselectWorktree();
  }
}

interface ArchiveUiSnapshot {
  projectId: string;
  worktreeId: string;
  createdAt?: string;
  previousProjects: SidebarItem[];
  previousDiffStats: Record<string, DiffStats>;
  previousCommitsAhead: Record<string, boolean>;
  previousBaseBranches: Record<string, string | null>;
  previousDefaultBranches: Record<string, string | null>;
  previousUncommittedChanges: Record<string, boolean>;
  previousHasRemoteTracking: Record<string, boolean>;
  previousHasOriginRemote: Record<string, boolean>;
  previousHasBranchBeenPushed: Record<string, boolean>;
  previousHasUnpushedCommits: Record<string, boolean>;
  previousHasUnpulledCommits: Record<string, boolean>;
  previousRepoBranches: Record<string, RepoBranchInfo[]>;
  previousBaseBranchExistsLocally: Record<string, boolean>;
  previousBaseBranchExistsInRemote: Record<string, boolean>;
  previousWorkspaceDrift: Record<string, WorkspaceDriftSummary>;
  previousPendingTaskBranchNamings: Record<string, PendingTaskBranchNaming>;
  wasRegisteredForPrPolling: boolean;
  remainingWorktreeOrder: string[];
  expectedRemainingWorktreeOrder: string[];
}

async function beginArchiveUiRemoval(
  projectId: string,
  worktreeId: string,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): Promise<ArchiveUiSnapshot> {
  // Archive capture reads the persisted ChatTabsFile. Checkpoint main's
  // canonical scope first so pending plan/relocation instructions survive
  // archive and repeated restore cycles.
  await useChatStore.getState().flushWorktreeTabs(projectId, worktreeId);
  useChatStore.getState().suppressWorktreePersistence(projectId, worktreeId);

  const archiveKey = createDiffStatsKey(projectId, worktreeId);
  const driftKey = createWorkspaceDriftKey(projectId, worktreeId);

  // Snapshot every per-worktree-keyed map before the optimistic clear so
  // that, if archive IPC rejects, we can restore the full prior state. The
  // backend archive call is the single source of truth for removing the
  // persisted worktree record — the renderer must not call saveProjects
  // before or after archive IPC.
  const previousProjects = get().projects;
  const previousDiffStats = get().diffStats;
  const previousCommitsAhead = get().commitsAhead;
  const previousBaseBranches = get().baseBranches;
  const previousDefaultBranches = get().defaultBranches;
  const previousUncommittedChanges = get().uncommittedChanges;
  const previousHasRemoteTracking = get().hasRemoteTracking;
  const previousHasOriginRemote = get().hasOriginRemote;
  const previousHasBranchBeenPushed = get().hasBranchBeenPushed;
  const previousHasUnpushedCommits = get().hasUnpushedCommits;
  const previousHasUnpulledCommits = get().hasUnpulledCommits;
  const previousRepoBranches = get().repoBranches;
  const previousBaseBranchExistsLocally = get().baseBranchExistsLocally;
  const previousBaseBranchExistsInRemote = get().baseBranchExistsInRemote;
  const previousWorkspaceDrift = get().workspaceDrift;
  const previousPendingTaskBranchNamings = get().pendingTaskBranchNamings;
  const wasRegisteredForPrPolling = registeredForPrPolling.has(archiveKey);
  const archivedProject = previousProjects.find(
    (project) => project.id === projectId,
  );
  const createdAt =
    archivedProject && archivedProject.type !== 'cowork'
      ? archivedProject.worktrees.find((worktree) => worktree.id === worktreeId)
          ?.createdAt
      : undefined;
  markArchiveSuppressedWorktree(projectId, worktreeId, createdAt);

  // Optimistically remove from UI immediately
  const updatedProjects = previousProjects.flatMap((p) => {
    if (p.id !== projectId || p.type === 'cowork') return p;
    const worktrees = flattenCurrentWorktreeGrouping(p, get()).filter(
      (wt) => wt.id !== worktreeId,
    );
    // Deletion retention is always on: removing the last worktree of a
    // temporary multi-repo workspace leaves a retained container behind, so
    // the workspace row stays visible (showing its "Archived and deleted"
    // link). Main's `removedTemporaryWorkspaceId` response remains
    // authoritative for the actual removal (see `performArchive`).
    return {
      ...p,
      worktrees,
    };
  });

  const nextDiffStats = { ...previousDiffStats };
  delete nextDiffStats[archiveKey];
  const nextCommitsAhead = { ...previousCommitsAhead };
  delete nextCommitsAhead[archiveKey];
  const nextBaseBranches = { ...previousBaseBranches };
  delete nextBaseBranches[archiveKey];
  const nextDefaultBranches = { ...previousDefaultBranches };
  delete nextDefaultBranches[archiveKey];
  const nextUncommittedChanges = { ...previousUncommittedChanges };
  delete nextUncommittedChanges[archiveKey];
  const nextHasRemoteTracking = { ...previousHasRemoteTracking };
  delete nextHasRemoteTracking[archiveKey];
  const nextHasOriginRemote = { ...previousHasOriginRemote };
  delete nextHasOriginRemote[archiveKey];
  const nextHasBranchBeenPushed = { ...previousHasBranchBeenPushed };
  delete nextHasBranchBeenPushed[archiveKey];
  const nextHasUnpushedCommits = { ...previousHasUnpushedCommits };
  delete nextHasUnpushedCommits[archiveKey];
  const nextHasUnpulledCommits = { ...previousHasUnpulledCommits };
  delete nextHasUnpulledCommits[archiveKey];
  const nextRepoBranches = { ...previousRepoBranches };
  delete nextRepoBranches[archiveKey];
  const nextBaseBranchExistsLocally = { ...previousBaseBranchExistsLocally };
  delete nextBaseBranchExistsLocally[archiveKey];
  const nextBaseBranchExistsInRemote = { ...previousBaseBranchExistsInRemote };
  delete nextBaseBranchExistsInRemote[archiveKey];
  const nextWorkspaceDrift = { ...previousWorkspaceDrift };
  delete nextWorkspaceDrift[driftKey];
  const nextPendingTaskBranchNamings = { ...previousPendingTaskBranchNamings };
  delete nextPendingTaskBranchNamings[archiveKey];
  registeredForPrPolling.delete(archiveKey);

  set({
    projects: updatedProjects,
    diffStats: nextDiffStats,
    commitsAhead: nextCommitsAhead,
    baseBranches: nextBaseBranches,
    defaultBranches: nextDefaultBranches,
    uncommittedChanges: nextUncommittedChanges,
    hasRemoteTracking: nextHasRemoteTracking,
    hasOriginRemote: nextHasOriginRemote,
    hasBranchBeenPushed: nextHasBranchBeenPushed,
    hasUnpushedCommits: nextHasUnpushedCommits,
    hasUnpulledCommits: nextHasUnpulledCommits,
    repoBranches: nextRepoBranches,
    baseBranchExistsLocally: nextBaseBranchExistsLocally,
    baseBranchExistsInRemote: nextBaseBranchExistsInRemote,
    workspaceDrift: nextWorkspaceDrift,
    pendingTaskBranchNamings: nextPendingTaskBranchNamings,
  });

  const updatedProject = updatedProjects.find(
    (project) => project.id === projectId,
  );
  return {
    projectId,
    worktreeId,
    createdAt,
    previousProjects,
    previousDiffStats,
    previousCommitsAhead,
    previousBaseBranches,
    previousDefaultBranches,
    previousUncommittedChanges,
    previousHasRemoteTracking,
    previousHasOriginRemote,
    previousHasBranchBeenPushed,
    previousHasUnpushedCommits,
    previousHasUnpulledCommits,
    previousRepoBranches,
    previousBaseBranchExistsLocally,
    previousBaseBranchExistsInRemote,
    previousWorkspaceDrift,
    previousPendingTaskBranchNamings,
    wasRegisteredForPrPolling,
    remainingWorktreeOrder:
      !updatedProject || updatedProject.type === 'cowork'
        ? []
        : updatedProject.worktrees.map((worktree) => worktree.id),
    expectedRemainingWorktreeOrder:
      !archivedProject || archivedProject.type === 'cowork'
        ? []
        : archivedProject.worktrees
            .filter((worktree) => worktree.id !== worktreeId)
            .map((worktree) => worktree.id),
  };
}

/**
 * The current projects with the archived worktree put back where it was.
 * Only that row returns: removals that overlap it (a bulk batch moves on once
 * a row is hidden) keep their own rows hidden or gone.
 */
function projectsWithRestoredWorktree(
  current: SidebarItem[],
  snapshot: ArchiveUiSnapshot,
): SidebarItem[] {
  const { projectId, worktreeId } = snapshot;
  const previousIndex = snapshot.previousProjects.findIndex(
    (project) => project.id === projectId,
  );
  const previous = snapshot.previousProjects[previousIndex];
  if (!previous || previous.type === 'cowork') return current;
  const restored = previous.worktrees.find(
    (worktree) => worktree.id === worktreeId,
  );
  if (!restored) return current;
  const currentProject = current.find((project) => project.id === projectId);
  if (!currentProject) {
    // The project left the sidebar meanwhile: put it back as it was.
    const next = [...current];
    next.splice(Math.min(previousIndex, next.length), 0, previous);
    return next;
  }
  if (
    currentProject.type === 'cowork' ||
    currentProject.worktrees.some((worktree) => worktree.id === worktreeId)
  ) {
    return current;
  }
  // After the nearest earlier row still listed; failing that, before the
  // nearest later one (an overlapping removal may have hidden the earlier
  // rows); failing both, last.
  const previousAt = previous.worktrees.findIndex(
    (worktree) => worktree.id === worktreeId,
  );
  const earlierIds = new Set(
    previous.worktrees.slice(0, previousAt).map((worktree) => worktree.id),
  );
  const laterIds = new Set(
    previous.worktrees.slice(previousAt + 1).map((worktree) => worktree.id),
  );
  let insertAt = -1;
  currentProject.worktrees.forEach((worktree, index) => {
    if (earlierIds.has(worktree.id)) insertAt = index + 1;
  });
  if (insertAt < 0) {
    const laterAt = currentProject.worktrees.findIndex((worktree) =>
      laterIds.has(worktree.id),
    );
    insertAt = laterAt < 0 ? currentProject.worktrees.length : laterAt;
  }
  const worktrees = [...currentProject.worktrees];
  worktrees.splice(insertAt, 0, restored);
  return current.map((project) =>
    project === currentProject ? { ...currentProject, worktrees } : project,
  );
}

/** `current` with `key` set back to its value in `previous`, if it had one. */
function withRestoredKey<V>(
  current: Record<string, V>,
  previous: Record<string, V>,
  key: string,
): Record<string, V> {
  if (!(key in previous)) return current;
  return { ...current, [key]: previous[key] };
}

function rollbackArchiveUiRemoval(
  snapshot: ArchiveUiSnapshot,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): void {
  unmarkArchiveSuppressedWorktree(
    snapshot.projectId,
    snapshot.worktreeId,
    snapshot.createdAt,
    {
      clearActiveLoadFilters: true,
    },
  );
  useChatStore
    .getState()
    .resumeWorktreePersistence(snapshot.projectId, snapshot.worktreeId);
  if (snapshot.wasRegisteredForPrPolling) {
    registeredForPrPolling.add(
      createDiffStatsKey(snapshot.projectId, snapshot.worktreeId),
    );
  }
  // Row-scoped: overlapping removals took their snapshots at other moments,
  // so restoring a whole snapshot would revive or re-hide their rows.
  const key = createDiffStatsKey(snapshot.projectId, snapshot.worktreeId);
  const driftKey = createWorkspaceDriftKey(
    snapshot.projectId,
    snapshot.worktreeId,
  );
  const state = get();
  set({
    projects: projectsWithRestoredWorktree(state.projects, snapshot),
    diffStats: withRestoredKey(
      state.diffStats,
      snapshot.previousDiffStats,
      key,
    ),
    commitsAhead: withRestoredKey(
      state.commitsAhead,
      snapshot.previousCommitsAhead,
      key,
    ),
    baseBranches: withRestoredKey(
      state.baseBranches,
      snapshot.previousBaseBranches,
      key,
    ),
    defaultBranches: withRestoredKey(
      state.defaultBranches,
      snapshot.previousDefaultBranches,
      key,
    ),
    uncommittedChanges: withRestoredKey(
      state.uncommittedChanges,
      snapshot.previousUncommittedChanges,
      key,
    ),
    hasRemoteTracking: withRestoredKey(
      state.hasRemoteTracking,
      snapshot.previousHasRemoteTracking,
      key,
    ),
    hasOriginRemote: withRestoredKey(
      state.hasOriginRemote,
      snapshot.previousHasOriginRemote,
      key,
    ),
    hasBranchBeenPushed: withRestoredKey(
      state.hasBranchBeenPushed,
      snapshot.previousHasBranchBeenPushed,
      key,
    ),
    hasUnpushedCommits: withRestoredKey(
      state.hasUnpushedCommits,
      snapshot.previousHasUnpushedCommits,
      key,
    ),
    hasUnpulledCommits: withRestoredKey(
      state.hasUnpulledCommits,
      snapshot.previousHasUnpulledCommits,
      key,
    ),
    repoBranches: withRestoredKey(
      state.repoBranches,
      snapshot.previousRepoBranches,
      key,
    ),
    baseBranchExistsLocally: withRestoredKey(
      state.baseBranchExistsLocally,
      snapshot.previousBaseBranchExistsLocally,
      key,
    ),
    baseBranchExistsInRemote: withRestoredKey(
      state.baseBranchExistsInRemote,
      snapshot.previousBaseBranchExistsInRemote,
      key,
    ),
    workspaceDrift: withRestoredKey(
      state.workspaceDrift,
      snapshot.previousWorkspaceDrift,
      driftKey,
    ),
    pendingTaskBranchNamings: withRestoredKey(
      state.pendingTaskBranchNamings,
      snapshot.previousPendingTaskBranchNamings,
      key,
    ),
  });
}

function cleanupArchivedWorktreeRendererState(
  projectId: string,
  worktreeId: string,
  get: () => ProjectsState,
): void {
  deselectIfSelectedWorktree(projectId, worktreeId);
  useChatStore.getState().cleanupWorktree(projectId, worktreeId);
  useChatStore.getState().dropWorktreeQueuedState(projectId, worktreeId);
  usePipelineRunsStore.getState().dropPendingForWorktree(projectId, worktreeId);
  usePipelineRunsStore.getState().releaseDetailOwner(projectId, worktreeId);
  get().clearPendingTaskBranchNaming(projectId, worktreeId);
  useScriptsStore.getState().cleanupWorktree(projectId, worktreeId);
  useHooksStore.getState().cleanupWorktree(projectId, worktreeId);
}

/** Recovery cleanup needs confirmed absence, not an optimistically hidden row. */
export function cleanupUnlistedWorktreeRendererState(
  projectId: string,
  worktreeId: string,
): boolean {
  const get = useProjectsStore.getState;
  const state = get();
  if (
    state.projectInventoryStatus !== 'ready' ||
    !state.projectInventorySnapshot ||
    state.failedWorkspaceIds.has(projectId)
  )
    return false;
  const hasOwner = (projects: readonly SidebarItem[]): boolean =>
    projects.some(
      (project) =>
        project.id === projectId &&
        (project.type === 'cowork' ||
          project.worktrees.some((row) => row.id === worktreeId)),
    );
  if (
    hasOwner(state.projects) ||
    hasOwner(state.projectInventorySnapshot.projects)
  )
    return false;
  cleanupArchivedWorktreeRendererState(projectId, worktreeId, get);
  return true;
}

function finalizeArchiveUiRemoval(
  snapshot: ArchiveUiSnapshot,
  get: () => ProjectsState,
): void {
  clearArchiveSuppressedChatActivity(
    snapshot.projectId,
    snapshot.worktreeId,
    snapshot.createdAt,
  );
  cleanupArchivedWorktreeRendererState(
    snapshot.projectId,
    snapshot.worktreeId,
    get,
  );
}

export function removeTemporaryWorkspaceFromUi(
  workspaceId: string | undefined,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): void {
  if (!workspaceId) {
    return;
  }

  const projects = get().projects;
  if (!projects.some((project) => project.id === workspaceId)) {
    return;
  }

  set({
    projects: projects.filter((project) => project.id !== workspaceId),
  });
}

/**
 * Splits with a background phase still running, keyed
 * `${workspaceId}/${worktreeId}`. The value carries the source worktree's
 * createdAt captured at optimistic-removal time so a failed split can clear
 * the matching archive-suppression tombstone and let the restored row render.
 */
interface PendingSplitCompletion {
  createdAt?: string;
  awaitingFastResponse: boolean;
  bufferedEvent?: SplitTemporaryWorkspaceCompleteEvent;
}

const pendingSplitCompletions = new Map<string, PendingSplitCompletion>();

/** "A", "\"A\" and \"B\"", "\"A\", \"B\" and \"C\"" for toast copy. */
function formatQuotedNameList(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * Detailed success copy for the split-complete toast: spells out what
 * happened to each repo instead of a bare "Project split".
 */
function buildSplitCompletionToastMessage(
  results: SplitTemporaryWorkspaceCompleteEvent['results'],
  rootDisposition?: SplitTemporaryWorkspaceCompleteEvent['rootDisposition'],
): string {
  const splitNames = results
    .filter((entry) => entry.disposition === 'split')
    .map((entry) => entry.repoName);
  const archivedNames = results
    .filter((entry) => entry.disposition === 'archived')
    .map((entry) => entry.repoName);
  const deletedNames = results
    .filter((entry) => entry.disposition === 'deleted')
    .map((entry) => entry.repoName);

  const parts: string[] = [];
  if (splitNames.length > 0) {
    parts.push(
      `moved ${formatQuotedNameList(splitNames)} to ${
        splitNames.length === 1 ? 'its own project' : 'their own projects'
      }`,
    );
  }
  if (archivedNames.length > 0) {
    parts.push(`archived ${formatQuotedNameList(archivedNames)}`);
  }
  if (deletedNames.length > 0) {
    parts.push(`deleted ${formatQuotedNameList(deletedNames)}`);
  }
  if (rootDisposition === 'archived') {
    parts.push('archived the project root items');
  } else if (rootDisposition === 'deleted') {
    parts.push('deleted the project root items');
  }
  if (parts.length === 0) {
    return 'Project split';
  }
  const detail = parts.join(', ');
  return `Project split: ${detail.charAt(0).toUpperCase()}${detail.slice(1)}`;
}

/**
 * Optimistically add the reserved split destination rows (git-pending) to the
 * in-memory projects state so the destination worktree is selectable the
 * instant the fast phase returns — without waiting for the authoritative
 * sidebar reload. Rows carry the same ids the backend reserved, so the
 * background reload and the later `worktree:git-ready` events reconcile onto
 * them. Returns true when the response's navigation target is selectable
 * from the (now updated) state; false means the caller must await the full
 * reload first (e.g. the destination workspace was just created and is not
 * in the renderer state yet).
 */
function injectReservedSplitWorktrees(
  response: SplitTemporaryWorkspaceResponse,
  sourceWorktree: WorktreeData | undefined,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): boolean {
  const splitResults = response.results.filter(
    (
      entry,
    ): entry is SplitTemporaryWorkspaceResponse['results'][number] & {
      destinationWorkspaceId: string;
      destinationWorktreeId: string;
    } =>
      entry.disposition === 'split' &&
      entry.destinationWorkspaceId !== undefined &&
      entry.destinationWorktreeId !== undefined,
  );
  if (splitResults.length === 0) {
    return true;
  }

  const projects = get().projects;
  let changed = false;
  const next = projects.map((project) => {
    if (project.type === 'cowork') {
      return project;
    }
    const hits = splitResults.filter(
      (entry) => entry.destinationWorkspaceId === project.id,
    );
    if (hits.length === 0) {
      return project;
    }
    const existingIds = new Set(project.worktrees.map((wt) => wt.id));
    const additions: WorktreeData[] = hits
      .filter((entry) => !existingIds.has(entry.destinationWorktreeId))
      .map((entry) => ({
        id: entry.destinationWorktreeId,
        branchName: sourceWorktree?.branchName ?? entry.destinationWorktreeId,
        createdAt: sourceWorktree?.createdAt ?? new Date().toISOString(),
        setupPhase: 'git-pending',
      }));
    if (additions.length === 0) {
      return project;
    }
    changed = true;
    return { ...project, worktrees: [...project.worktrees, ...additions] };
  });
  if (changed) {
    set({ projects: next });
  }

  const target = response.navigationTarget;
  if (target.kind !== 'worktree') {
    return true;
  }
  return next.some((project) => project.id === target.workspaceId);
}

/**
 * Terminal handler for a background split: on success, reload and drop the
 * (now empty) temporary workspace from the UI; on failure, un-suppress the
 * source worktree so the authoritative reload restores it, and surface the
 * error as a toast — the modal that initiated the split is long closed.
 */
function handleSplitTemporaryWorkspaceComplete(
  event: SplitTemporaryWorkspaceCompleteEvent,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
): void {
  const key = `${event.workspaceId}/${event.worktreeId}`;
  const pending = pendingSplitCompletions.get(key);
  if (pending?.awaitingFastResponse) {
    pending.bufferedEvent = event;
    return;
  }
  pendingSplitCompletions.delete(key);

  for (const warning of event.warnings) {
    useGitHubStore.getState().addToast(warning, 'error', undefined, {
      projectId: event.workspaceId,
      worktreeId: event.worktreeId,
    });
  }

  if (event.success) {
    useGitHubStore
      .getState()
      .addToast(
        buildSplitCompletionToastMessage(event.results, event.rootDisposition),
        'success',
      );
    removeTemporaryWorkspaceFromUi(event.removedTemporaryWorkspaceId, get, set);
    void get().loadProjects({ silent: true });
    return;
  }

  unmarkArchiveSuppressedWorktree(
    event.workspaceId,
    event.worktreeId,
    pending?.createdAt,
    { clearActiveLoadFilters: true },
  );
  useChatStore
    .getState()
    .resumeWorktreePersistence(event.workspaceId, event.worktreeId);
  useGitHubStore
    .getState()
    .addToast(event.error ?? 'Failed to split project.', 'error', undefined, {
      projectId: event.workspaceId,
      worktreeId: event.worktreeId,
    });
  void get()
    .loadProjects({ silent: true })
    .then(() => {
      const chatStore = useChatStore.getState();
      const selected = chatStore.selectedWorktree;
      if (!selected) {
        return;
      }
      const projects = get().projects;
      const selectedStillExists = projects.some(
        (project) =>
          project.id === selected.projectId &&
          project.type !== 'cowork' &&
          project.worktrees.some(
            (worktree) => worktree.id === selected.worktreeId,
          ),
      );
      if (selectedStillExists) {
        return;
      }
      const restoredSource = projects.find(
        (project) =>
          project.id === event.workspaceId &&
          project.type !== 'cowork' &&
          project.worktrees.some(
            (worktree) => worktree.id === event.worktreeId,
          ),
      );
      if (restoredSource) {
        chatStore.selectWorktree(event.workspaceId, event.worktreeId);
      } else {
        chatStore.deselectWorktree();
      }
    });
}

async function performArchive(
  projectId: string,
  worktreeId: string,
  item: SingleRepoSidebarItem | MultiRepoSidebarItem,
  snapshot: ArchiveUiSnapshot,
  get: () => ProjectsState,
  set: (state: Partial<ProjectsState>) => void,
  options?: ArchiveWorktreeOptions,
): Promise<void> {
  const archiveResponse =
    item.type === 'multi-repo'
      ? await window.api.archiveWorkspaceWorktree({
          workspaceId: projectId,
          worktreeId,
          expectedCreatedAt: snapshot.createdAt,
          ...(options?.expectedBranchName
            ? { expectedBranchName: options.expectedBranchName }
            : {}),
          remainingWorktreeOrder: snapshot.remainingWorktreeOrder,
          expectedRemainingWorktreeOrder:
            snapshot.expectedRemainingWorktreeOrder,
          ...(options?.deleteBranch !== undefined
            ? { deleteBranch: options.deleteBranch }
            : {}),
          ...(options?.lockAfterArchive !== undefined
            ? { lockAfterArchive: options.lockAfterArchive }
            : {}),
          ...(options?.deleteWithoutRetentionIfMissing !== undefined
            ? {
                deleteWithoutRetentionIfMissing:
                  options.deleteWithoutRetentionIfMissing,
              }
            : {}),
          // CAN-5336: a discardable refusal resolves with its description.
          typedRefusal: true,
        })
      : await window.api.archiveWorktree({
          repoPath: item.repoPath,
          projectId,
          worktreeId,
          expectedCreatedAt: snapshot.createdAt,
          ...(options?.expectedBranchName
            ? { expectedBranchName: options.expectedBranchName }
            : {}),
          remainingWorktreeOrder: snapshot.remainingWorktreeOrder,
          expectedRemainingWorktreeOrder:
            snapshot.expectedRemainingWorktreeOrder,
          ...(options?.deleteBranch !== undefined
            ? { deleteBranch: options.deleteBranch }
            : {}),
          ...(options?.lockAfterArchive !== undefined
            ? { lockAfterArchive: options.lockAfterArchive }
            : {}),
          ...(options?.deleteWithoutRetentionIfMissing !== undefined
            ? {
                deleteWithoutRetentionIfMissing:
                  options.deleteWithoutRetentionIfMissing,
              }
            : {}),
          typedRefusal: true,
        });
  // Before warnings and finalization: the callers' catches roll the row back.
  throwIfArchiveRefused(archiveResponse, {
    ...(options?.expectedBranchName !== undefined
      ? { expectedBranchName: options.expectedBranchName }
      : {}),
    ...(options?.deleteBranch !== undefined
      ? { deleteBranch: options.deleteBranch }
      : {}),
    ...(options?.deleteWithoutRetentionIfMissing !== undefined
      ? {
          deleteWithoutRetentionIfMissing:
            options.deleteWithoutRetentionIfMissing,
        }
      : {}),
  });

  for (const warning of archiveResponse.warnings) {
    useGitHubStore.getState().addToast(warning, 'warning', undefined, {
      category: 'Worktree',
      projectId,
      worktreeId,
    });
  }

  if (archiveResponse.removedTemporaryWorkspaceId) {
    useGitHubStore
      .getState()
      .addToast(
        'Hidden after archiving its last worktree.',
        'info',
        undefined,
        {
          workspaceName: getWorkspaceDisplayName(item),
        },
      );
  }

  // Only clean up dependent stores after confirmed successful archive.
  // The backend archive IPC is now the single source of truth for
  // removing the persisted worktree record, so the renderer must NOT
  // call saveProjects after archive success. Keep the archive suppression
  // tombstone so stale project reloads cannot redraw the deleted row.
  finalizeArchiveUiRemoval(snapshot, get);
  removeTemporaryWorkspaceFromUi(
    archiveResponse.removedTemporaryWorkspaceId,
    get,
    set,
  );
  // The changed-event subscription is a best-effort cross-window update. The
  // initiating renderer must not depend on that debounced broadcast to learn
  // either archive source of truth: on a loaded CI runner the full projects
  // refresh can be delayed while the live row has already disappeared, and a
  // previously loaded archive-summary cache otherwise keeps rendering its
  // stale empty list. Refresh both stores directly so either one can reveal
  // the new Archived subgroup as soon as its authoritative read completes.
  await Promise.all([
    useArchivedContainersStore
      .getState()
      .loadForWorkspace(projectId, { trailing: true }),
    get().loadProjects({ silent: true }),
  ]);
}

/**
 * Generation counter for refreshDiffStats. Incremented each time a call starts.
 * When a call finishes, it checks whether a newer call has been initiated;
 * if so, it discards its (now-stale) results instead of overwriting
 * more-recent optimistic state (e.g. from setTrackedBaseBranch).
 */
let diffStatsGeneration = 0;

/**
 * Coalescing state for refreshDiffStats. When a refresh is already in flight,
 * additional callers mark the queue so that a single trailing refresh runs
 * after the current one. This prevents stacking overlapping diff-stat
 * refreshes when focus, polling, and GitHub callbacks fire in quick succession.
 */
let diffStatsRefreshPromise: Promise<void> | null = null;
let diffStatsRefreshQueued = false;
let targetedDiffStatsRefreshTail: Promise<void> = Promise.resolve();

/**
 * Per-worktree adaptive polling state for the scheduled diff-stats refresh.
 * The foreground (selected) worktree refreshes every tick; background
 * worktrees back off while unchanged (interval doubles up to a ceiling) and
 * snap back to the base cadence when their stats change or when a targeted
 * refresh signals activity.
 */
const bufferedWorktreeGitReadyEvents = new Map<string, WorktreeGitReadyEvent>();
const bufferedWorktreeGitFailedEvents = new Map<
  string,
  WorktreeGitFailedEvent
>();

function createWorktreeLifecycleKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Debounce window for `workspaceWorktreesUpdated`. The PR Split engine can
 * emit a burst of these events back-to-back (one per child worktree, plus
 * grouping and retarget writes), and each one otherwise triggers a full
 * projects reload (all workspaces, drift summaries, GitHub/watcher resync).
 * Coalescing the burst into a single trailing reload keeps the reload cost
 * bounded.
 */
const WORKSPACE_WORKTREES_RELOAD_DEBOUNCE_MS = 400;
let workspaceWorktreesReloadTimeout: ReturnType<typeof setTimeout> | null =
  null;

function clearScheduledWorkspaceWorktreesReload(): void {
  if (workspaceWorktreesReloadTimeout !== null) {
    clearTimeout(workspaceWorktreesReloadTimeout);
    workspaceWorktreesReloadTimeout = null;
  }
}

function scheduleWorkspaceWorktreesReload(reload: () => void): void {
  clearScheduledWorkspaceWorktreesReload();
  workspaceWorktreesReloadTimeout = setTimeout(() => {
    workspaceWorktreesReloadTimeout = null;
    reload();
  }, WORKSPACE_WORKTREES_RELOAD_DEBOUNCE_MS);
}

/* eslint-disable @typescript-eslint/explicit-function-return-type */
export const useProjectsStore = create<ProjectsState>((set, get) => {
  const applyDiffStatsResponse = async (params: {
    response: DiffStatsBatchResponseItem[];
    pendingWorktreeKeys: Set<string>;
    mergeKeys?: Set<string>;
  }): Promise<void> => {
    const previousDiffStatsState = getCurrentDiffStatsState(get());
    const previousDiffStats = previousDiffStatsState.diffStats;
    const previousHasOriginRemote = previousDiffStatsState.hasOriginRemote;
    const previousBaseBranchExistsInRemote =
      previousDiffStatsState.baseBranchExistsInRemote;
    const previousRepoBranches = previousDiffStatsState.repoBranches;
    const built = buildDiffStatsState(
      params.response,
      params.pendingWorktreeKeys,
    );
    const {
      branchUpdates,
      healthUpdates,
      brokenKeys,
      diffOnlyKeys,
      ...builtNextState
    } = built;
    const responseKeys = new Set(
      params.response.map((item) =>
        createDiffStatsKey(item.projectId, item.worktreeId),
      ),
    );
    const stateForStabilization =
      params.mergeKeys || diffOnlyKeys.size > 0
        ? mergeDiffStatsStateForKeys(
            previousDiffStatsState,
            builtNextState,
            params.mergeKeys ?? responseKeys,
            diffOnlyKeys,
          )
        : builtNextState;
    const { state: nextState, changed: diffStatsChanged } =
      stabilizeDiffStatsState(previousDiffStatsState, stateForStabilization);

    const currentProjects = get().projects;
    const { hasBranchChange, hasHealthChange } = detectProjectMetadataChanges(
      currentProjects,
      branchUpdates,
      healthUpdates,
    );

    if (hasBranchChange || hasHealthChange) {
      const updatedProjects = applyProjectMetadataChanges(
        currentProjects,
        branchUpdates,
        healthUpdates,
      );
      set({
        projects: updatedProjects,
        ...nextState,
      });
      // Only persist when branch names changed. Backend owns persistence
      // for health changes detected during stats.
      if (hasBranchChange) {
        await get().saveProjects(updatedProjects);
      }
    } else if (diffStatsChanged) {
      set({ ...nextState });
    }

    invalidateChangedFileLists(
      previousDiffStats,
      nextState.diffStats,
      (projectId, worktreeId) => {
        useFileListStore.getState().invalidate(projectId, worktreeId);
      },
    );

    const cleanRemoteDiffTransitions = collectRemoteCleanDiffStatTransitions(
      previousDiffStats,
      nextState.diffStats,
      previousHasOriginRemote,
      previousBaseBranchExistsInRemote,
      previousRepoBranches,
      nextState.hasOriginRemote,
      nextState.baseBranchExistsInRemote,
      nextState.repoBranches,
    );

    // Reload projects when any worktree's canopy.json content changes
    // between poll cycles so effective scripts/hooks stay in sync.
    let canopyContentChanged = false;
    for (const item of params.response) {
      if (item.mode === 'diff_only') continue;
      const key = createDiffStatsKey(item.projectId, item.worktreeId);
      if (brokenKeys.has(key)) continue;
      const hadPrev = prevCanopyJsonHash.has(key);
      const prev = prevCanopyJsonHash.get(key);
      const curr = item.canopyJsonHash;
      // Only trigger after the first poll to avoid a reload on initial
      // hydration, even when the first observed hash is undefined.
      if (hadPrev && prev !== curr) {
        canopyContentChanged = true;
        clearDismissedRecommendedPluginScopesForWorktree(
          item.projectId,
          item.worktreeId,
        );
      }
      prevCanopyJsonHash.set(key, curr);
    }
    if (canopyContentChanged) {
      void get().loadProjects({ silent: true });
    }

    // Register all worktrees for background PR polling so status is preloaded
    const githubState = useGitHubStore.getState();
    for (const { projectId, worktreeId } of cleanRemoteDiffTransitions) {
      void githubState.requestFastRefresh(projectId, worktreeId, false);
    }
    registerPrPolling(
      nextState.commitsAhead,
      registeredForPrPolling,
      (projectId, worktreeId) => {
        void githubState.requestRefresh(projectId, worktreeId);
      },
    );
    updatePersistedDiffStatsState(nextState);
  };

  const getForegroundDiffStatsKey = (): string | null => {
    const selected = useChatStore.getState().selectedWorktree;
    if (!selected) {
      return null;
    }
    const key = createDiffStatsKey(selected.projectId, selected.worktreeId);
    markWorktreeDiffStatsActivityKey(key);
    return key;
  };

  const recordLiveWorktreeActivity = (nowMs: number): void => {
    const chatState = useChatStore.getState();
    for (const key of Array.from(chatState.unreadWorktreeKeys)) {
      markWorktreeDiffStatsActivityKey(key, nowMs);
    }
    for (const [key, worktreeChat] of Object.entries(chatState.worktreeChats)) {
      if (
        worktreeChat.tabs.some(
          (tab) => tab.status === 'streaming' || tab.unread === true,
        )
      ) {
        markWorktreeDiffStatsActivityKey(key, nowMs);
      }
    }

    const pipelineState = usePipelineRunsStore.getState();
    const activePipelineMaps = [
      pipelineState.runningExecutionsByWorktree,
      pipelineState.pausedExecutionsByWorktree,
      pipelineState.pendingExecutions,
      pipelineState.queuedExecutionsByWorktree,
    ];
    for (const entriesByWorktree of activePipelineMaps) {
      for (const [key, entries] of Object.entries(entriesByWorktree)) {
        if (
          (entries instanceof Set && entries.size > 0) ||
          (Array.isArray(entries) && entries.length > 0)
        ) {
          markWorktreeDiffStatsActivityKey(key, nowMs);
        }
      }
    }
    for (const key of Array.from(pipelineState.unseenPipelineWorktreeKeys)) {
      markWorktreeDiffStatsActivityKey(key, nowMs);
    }
    for (const key of Array.from(
      pipelineState.unseenFailedPipelineWorktreeKeys,
    )) {
      markWorktreeDiffStatsActivityKey(key, nowMs);
    }
  };

  const applyPollStatesFromResponse = (
    response: DiffStatsBatchResponseItem[],
    foregroundKey: string | null,
    forceReset: boolean,
  ): void => {
    const nowMs = Date.now();
    for (const item of response) {
      const key = createDiffStatsKey(item.projectId, item.worktreeId);
      const previous = worktreeDiffStatsPollStates.get(key);
      const signature = buildDiffStatsChangeSignature(item);
      if (
        previous !== undefined &&
        previous.lastChangeSignature !== null &&
        previous.lastChangeSignature !== signature
      ) {
        markWorktreeDiffStatsActivityKey(key, nowMs);
      }
      if (forceReset) {
        markWorktreeDiffStatsActivityKey(key, nowMs);
      }
      const activityAt = getWorktreeDiffStatsActivityAtMs(key) ?? 0;
      worktreeDiffStatsPollStates.set(
        key,
        computeNextDiffStatsPollState({
          previous,
          signature,
          isForeground: key === foregroundKey,
          isRecentlyActive:
            nowMs - activityAt <= DIFF_STATS_RECENT_ACTIVITY_WINDOW_MS,
          forceReset,
          nowMs,
        }),
      );
    }
  };

  const runRefreshDiffStatsOnce = async (): Promise<void> => {
    const generation = ++diffStatsGeneration;
    const { refreshableWorktrees, pendingWorktreeKeys, totalCount } =
      collectRefreshableWorktrees(get().projects);

    if (totalCount === 0) {
      if (generation !== diffStatsGeneration) return;
      worktreeDiffStatsPollStates.clear();
      const currentDiffStatsState = getCurrentDiffStatsState(get());
      if (diffStatsStateHasEntries(currentDiffStatsState)) {
        const emptyState = emptyDiffStatsState();
        set(emptyState);
        updatePersistedDiffStatsState(emptyState);
      }
      return;
    }

    try {
      // Include broken worktrees in the batch so the backend can return
      // partial data (e.g. healthy child repos of a multi-repo workspace
      // whose other repos are broken/missing). `getWorktreeStats`
      // short-circuits cheaply for single-repo broken and root-broken
      // multi-repo cases.
      const response =
        refreshableWorktrees.length === 0
          ? []
          : await window.api.getDiffStatsBatch({
              worktrees: refreshableWorktrees.map((wt) => ({
                projectId: wt.projectId,
                worktreeId: wt.worktreeId,
              })),
              source: 'renderer-global-poll',
            });
      if (generation !== diffStatsGeneration) return;
      applyPollStatesFromResponse(response, getForegroundDiffStatsKey(), false);
      await applyDiffStatsResponse({ response, pendingWorktreeKeys });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to refresh diff stats:', error);
    }
  };

  /**
   * One scheduler tick of the adaptive refresh: foreground worktree plus the
   * due subset of background worktrees (bounded batch, oldest due first).
   * Results merge into existing state so worktrees outside the batch keep
   * their last-known stats.
   */
  const runScheduledDiffStatsTickOnce = async (): Promise<void> => {
    const generation = ++diffStatsGeneration;
    const { refreshableWorktrees, pendingWorktreeKeys, totalCount } =
      collectRefreshableWorktrees(get().projects);

    if (totalCount === 0) {
      if (generation !== diffStatsGeneration) return;
      worktreeDiffStatsPollStates.clear();
      const currentDiffStatsState = getCurrentDiffStatsState(get());
      if (diffStatsStateHasEntries(currentDiffStatsState)) {
        const emptyState = emptyDiffStatsState();
        set(emptyState);
        updatePersistedDiffStatsState(emptyState);
      }
      return;
    }

    const foregroundKey = getForegroundDiffStatsKey();
    const nowMs = Date.now();
    recordLiveWorktreeActivity(nowMs);
    const validKeys = new Set(
      refreshableWorktrees.map((worktree) =>
        createDiffStatsKey(worktree.projectId, worktree.worktreeId),
      ),
    );
    pruneWorktreeDiffStatsRuntime(validKeys);
    const currentDiffStatsState = getCurrentDiffStatsState(get());
    const prunedDiffStats = stabilizeDiffStatsState(
      currentDiffStatsState,
      pruneDiffStatsState(currentDiffStatsState, validKeys),
    );
    if (prunedDiffStats.changed) {
      set(prunedDiffStats.state);
      updatePersistedDiffStatsState(prunedDiffStats.state);
    }
    const plan = planScheduledDiffStatsBatch({
      worktrees: refreshableWorktrees,
      pollStates: worktreeDiffStatsPollStates,
      activityAtMs: worktreeDiffStatsActivityAtMs,
      foregroundKey,
      nowMs,
      batchLimit: DIFF_STATS_BACKGROUND_BATCH_LIMIT,
    });
    for (const key of plan.prunedKeys) {
      worktreeDiffStatsPollStates.delete(key);
    }
    if (plan.batch.length === 0) {
      return;
    }

    try {
      const response = await window.api.getDiffStatsBatch({
        worktrees: plan.batch.map((wt) => {
          const key = createDiffStatsKey(wt.projectId, wt.worktreeId);
          return {
            projectId: wt.projectId,
            worktreeId: wt.worktreeId,
            mode: getSidebarStatsRequestMode(
              key,
              foregroundKey,
              Object.prototype.hasOwnProperty.call(
                currentDiffStatsState.hasOriginRemote,
                key,
              ),
            ),
          };
        }),
        source: 'renderer-global-poll',
      });
      if (generation !== diffStatsGeneration) return;
      applyPollStatesFromResponse(response, foregroundKey, false);
      const mergeKeys = new Set(
        plan.batch.map((wt) => createDiffStatsKey(wt.projectId, wt.worktreeId)),
      );
      await applyDiffStatsResponse({
        response,
        pendingWorktreeKeys,
        mergeKeys,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to refresh scheduled diff stats:', error);
    }
  };

  const fastDiffStatsQueue = createFastDiffStatsQueue({
    refresh: (projectId, worktreeId) =>
      get().refreshWorktreeDiffStats(projectId, worktreeId),
  });

  const runTargetedDiffStatsRefresh = async (
    worktrees: RefreshableWorktreeRef[],
    options?: { skipFetch?: boolean },
  ): Promise<boolean> => {
    // Selection and other UI activity can request a targeted refresh as soon
    // as the reservation row is visible. Do not health-check that reservation
    // before Phase B has created its checkout: a missing path is expected
    // while `git-pending`, not evidence of an unhealthy worktree.
    const refreshableWorktrees = worktrees.filter((candidate) => {
      const project = get().projects.find(
        (item) => item.id === candidate.projectId,
      );
      if (!project || project.type === 'cowork') {
        return true;
      }
      const worktree = project.worktrees.find(
        (item) => item.id === candidate.worktreeId,
      );
      return worktree?.setupPhase !== 'git-pending';
    });
    if (refreshableWorktrees.length === 0) {
      return false;
    }
    const mergeKeys = new Set(
      refreshableWorktrees.map((worktree) =>
        createDiffStatsKey(worktree.projectId, worktree.worktreeId),
      ),
    );
    const activityAt = Date.now();
    for (const key of Array.from(mergeKeys)) {
      markWorktreeDiffStatsActivityKey(key, activityAt);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generation = ++diffStatsGeneration;
      try {
        const response = await window.api.getDiffStatsBatch({
          worktrees: refreshableWorktrees,
          skipFetch: options?.skipFetch,
          source: 'renderer-targeted',
        });
        if (generation !== diffStatsGeneration) {
          // A global poll started while this user-awaited refresh was in
          // flight. Retry once so a harmless poll cannot turn branch-from
          // into a silent no-op, while still discarding the older response.
          continue;
        }
        const responseByKey = new Map(
          response.map((item) => [
            createDiffStatsKey(item.projectId, item.worktreeId),
            item,
          ]),
        );
        const hasFreshStatusForEveryWorktree = refreshableWorktrees.every(
          (worktree) => {
            const item = responseByKey.get(
              createDiffStatsKey(worktree.projectId, worktree.worktreeId),
            );
            return (
              item !== undefined &&
              item.healthIssue === undefined &&
              typeof item.hasUncommittedChanges === 'boolean'
            );
          },
        );
        // A targeted refresh is an activity signal (commit, script completion,
        // user action) — snap those worktrees back to the base poll cadence.
        applyPollStatesFromResponse(
          response,
          getForegroundDiffStatsKey(),
          true,
        );
        await applyDiffStatsResponse({
          response,
          pendingWorktreeKeys: new Set(),
          mergeKeys,
        });
        await Promise.all(
          refreshableWorktrees.map((worktree) =>
            requestLoadedChangedFilesRefresh(
              worktree.projectId,
              worktree.worktreeId,
            ),
          ),
        );
        return hasFreshStatusForEveryWorktree;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to refresh targeted diff stats:', error);
        return false;
      }
    }
    return false;
  };

  const refreshDiffStatsForWorktrees = (
    worktrees: RefreshableWorktreeRef[],
    options?: { skipFetch?: boolean },
  ): Promise<boolean> => {
    const refresh = targetedDiffStatsRefreshTail.then(() =>
      runTargetedDiffStatsRefresh(worktrees, options),
    );
    targetedDiffStatsRefreshTail = refresh.then(
      () => undefined,
      () => undefined,
    );
    return refresh;
  };

  return {
    projects: [],
    isLoading: false,
    hasHydratedProjects: false,
    projectInventoryStatus: 'unhydrated',
    projectInventorySnapshot: null,
    projectLoadWarningKeys: new Set<string>(),
    failedWorkspaceIds: new Set<string>(),
    appliedProjectWorktreeScripts: {},
    appliedProjectWorktreeHooks: {},
    ...initialPersistedDiffStatsState,
    workspaceDrift: {},
    workspaceReferenceRepoStatus: {},
    discoveryLoading: new Set<string>(),
    creatingWorktreeForProject: new Set<string>(),
    hiddenWorkspaceIds: [],
    hydrateHiddenWorkspaceIds: (ids): void => {
      set({ hiddenWorkspaceIds: ids });
    },
    setHiddenWorkspaceIds: (ids): void => {
      set({ hiddenWorkspaceIds: ids });
      void window.api
        .savePreferences({ worktreeFilterHiddenWorkspaceIds: ids })
        .catch(() => {
          // Silently ignore save failures — local state still applies.
        });
    },
    recentlyAddedProjectIds: new Set<string>(),
    detectRecentlyAddedProjects: (): void => {
      const state = get();
      const currentIds = new Set(state.projects.map((p) => p.id));

      // Capture the first hydrated snapshot as the baseline without pulsing —
      // otherwise every workspace would pulse on startup.
      if (!recentlyAddedBaselineCaptured) {
        if (state.hasHydratedProjects) {
          recentlyAddedBaselineCaptured = true;
          recentlyAddedBaselineIds = currentIds;
        }
        return;
      }

      const newIds = Array.from(currentIds).filter(
        (id) => !recentlyAddedBaselineIds.has(id),
      );
      // Union, never replace: a snapshot flap (reload racing a write) must not
      // re-flag an id as new.
      for (const project of state.projects) {
        recentlyAddedBaselineIds.add(project.id);
      }

      if (newIds.length === 0) {
        return;
      }

      set((prev) => {
        const next = new Set(prev.recentlyAddedProjectIds);
        for (const id of newIds) {
          next.add(id);
        }
        return { recentlyAddedProjectIds: next };
      });

      for (const id of newIds) {
        const existing = recentlyAddedHighlightTimers.get(id);
        if (existing !== undefined) {
          window.clearTimeout(existing);
        }
        const timer = window.setTimeout(() => {
          recentlyAddedHighlightTimers.delete(id);
          set((prev) => {
            if (!prev.recentlyAddedProjectIds.has(id)) {
              return {};
            }
            const next = new Set(prev.recentlyAddedProjectIds);
            next.delete(id);
            return { recentlyAddedProjectIds: next };
          });
        }, RECENTLY_ADDED_PULSE_MS);
        recentlyAddedHighlightTimers.set(id, timer);
      }
    },
    clearRecentlyAddedProjectTimers: (): void => {
      recentlyAddedHighlightTimers.forEach((timer) =>
        window.clearTimeout(timer),
      );
      recentlyAddedHighlightTimers.clear();
    },
    pendingScrollToWorktree: null,
    requestScrollToWorktree: (
      projectId,
      worktreeId,
      reason = 'selected',
    ): void => {
      // Creation flows seed a `created` scroll and then immediately call
      // `selectWorktree` for the same worktree, which requests a `selected`
      // scroll. Don't let that follow-up downgrade the hardened creation
      // scroll (which re-asserts across the post-creation reflow window).
      const current = get().pendingScrollToWorktree;
      if (
        reason === 'selected' &&
        current?.projectId === projectId &&
        current.worktreeId === worktreeId &&
        current.reason === 'created'
      ) {
        return;
      }
      set({
        pendingScrollToWorktree: { projectId, worktreeId, reason },
      });
    },
    clearPendingScrollToWorktree: (): void => {
      if (get().pendingScrollToWorktree !== null) {
        set({ pendingScrollToWorktree: null });
      }
    },
    tearingDownWorktrees: new Set<string>(),
    archivingWorktrees: new Set<string>(),
    pendingWorkspaceRepair: null,
    workspaceRepairPending: false,
    pendingHookChatPluginInstallPrompt: null,
    pendingRecommendedPluginPrompt: null,
    pendingTaskBranchNamings: {},

    enqueuePendingTaskBranchNaming: (
      projectId,
      worktreeId,
      text,
      options,
    ): void => {
      const enqueueProject = get().projects.find(
        (project) => project.id === projectId,
      );
      const worktree =
        enqueueProject && enqueueProject.type !== 'cowork'
          ? enqueueProject.worktrees.find(
              (candidate) => candidate.id === worktreeId,
            )
          : undefined;
      if (worktree && worktree.setupPhase !== 'git-pending') {
        void window.api.scheduleTaskBranchNaming({
          projectId,
          worktreeId,
          text,
          ...(options?.chatId ? { chatId: options.chatId } : {}),
          ...(options?.selectedRepoId
            ? { selectedRepoId: options.selectedRepoId }
            : {}),
        });
        return;
      }

      const key = `${projectId}/${worktreeId}`;
      set({
        pendingTaskBranchNamings: {
          ...get().pendingTaskBranchNamings,
          [key]: {
            text,
            ...(options?.chatId ? { chatId: options.chatId } : {}),
            ...(options?.selectedRepoId
              ? { selectedRepoId: options.selectedRepoId }
              : {}),
          },
        },
      });
    },

    clearPendingTaskBranchNaming: (projectId, worktreeId): void => {
      const key = `${projectId}/${worktreeId}`;
      const current = get().pendingTaskBranchNamings;
      if (!(key in current)) return;
      const next = { ...current };
      delete next[key];
      set({ pendingTaskBranchNamings: next });
    },

    subscribeToWorktreeGitLifecycleEvents: () => {
      const unsubReady = window.api.onWorktreeGitReady(
        (event: WorktreeGitReadyEvent): void => {
          if (applyWorktreeGitReadyEvent(event, get, set)) {
            return;
          }
          const key = createWorktreeLifecycleKey(
            event.projectId,
            event.worktreeId,
          );
          bufferedWorktreeGitFailedEvents.delete(key);
          bufferedWorktreeGitReadyEvents.set(key, event);
          void get().loadProjects({ silent: true });
        },
      );

      const unsubFailed = window.api.onWorktreeGitFailed(
        (event: WorktreeGitFailedEvent): void => {
          if (applyWorktreeGitFailedEvent(event, get, set)) {
            return;
          }
          const key = createWorktreeLifecycleKey(
            event.projectId,
            event.worktreeId,
          );
          bufferedWorktreeGitReadyEvents.delete(key);
          bufferedWorktreeGitFailedEvents.set(key, event);
          void get().loadProjects({ silent: true });
        },
      );

      const unsubNeedsRepair = window.api.onWorktreeNeedsRepair(
        (event: WorktreeNeedsRepairEvent): void => {
          applyWorktreeNeedsRepairEvent(event, get, set);
        },
      );

      const unsubBranchChanged = window.api.onWorktreeBranchChanged(
        (event: WorktreeBranchChangedEvent): void => {
          applyWorktreeBranchChangedEvent(event, get, set);
        },
      );

      // Main-initiated worktree writes have no IPC response for the renderer to
      // fold in. Authoritative lists replace stale snapshots, single-row updates
      // are merged immediately, and workspace-id-only events fall back to a reload
      // so PR Split child rows, grouping, and retargeted branch labels appear
      // live. A multi-child split emits a burst of these events in quick
      // succession, so the reload itself is debounced/coalesced (see
      // `scheduleWorkspaceWorktreesReload`) rather than firing once per event.
      const unsubWorkspaceWorktrees = window.api.onWorkspaceWorktreesUpdated(
        (event: WorkspaceWorktreesUpdatedEvent): void => {
          if (!event.workspaceId) {
            return;
          }
          if (applyWorkspaceWorktreeUpdatedEvent(event, get, set)) {
            return;
          }
          scheduleWorkspaceWorktreesReload(() => {
            void get().loadProjects({ silent: true });
          });
        },
      );

      const unsubWorktreesFileChanged = window.api.onWorktreesFileChanged(
        (): void => {
          scheduleWorkspaceWorktreesReload(() => {
            void get().loadProjects({ silent: true });
          });
        },
      );

      // A conversion or move back (CAN-3415) rewrites a workspace's owner in
      // main with no renderer request to answer, so re-read the projects.
      const unsubOwnership = window.api.orgProjects.onOwnershipChanged(
        (): void => {
          scheduleWorkspaceWorktreesReload(() => {
            void get().loadProjects({ silent: true });
          });
        },
      );

      const unsubSplitComplete = window.api.onWorkspaceSplitTemporaryComplete(
        (event: SplitTemporaryWorkspaceCompleteEvent): void => {
          handleSplitTemporaryWorkspaceComplete(event, get, set);
        },
      );

      return (): void => {
        unsubReady();
        unsubFailed();
        unsubNeedsRepair();
        unsubBranchChanged();
        unsubWorkspaceWorktrees();
        unsubWorktreesFileChanged();
        unsubOwnership();
        unsubSplitComplete();
        clearScheduledWorkspaceWorktreesReload();
      };
    },

    inspectHookChatPluginDependencies: async (
      projectId,
      worktreeId,
      worktreeLabel,
    ) => {
      let response;
      try {
        response = await window.api.inspectHookChatPluginDependencies({
          projectId,
          worktreeId,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          'Failed to inspect hook chat plugin dependencies:',
          error,
        );
        return;
      }

      if (!response?.items || response.items.length === 0) {
        return;
      }

      const fallbackLabel = ((): string => {
        const project = get().projects.find((p) => p.id === projectId);
        const worktree =
          project && project.type !== 'cowork'
            ? project.worktrees.find((w) => w.id === worktreeId)
            : undefined;
        return worktree?.branchName ?? worktreeId;
      })();

      set({
        pendingHookChatPluginInstallPrompt: {
          projectId,
          worktreeId,
          worktreeLabel: worktreeLabel ?? fallbackLabel,
          items: response.items,
        },
      });
    },

    dismissPendingHookChatPluginInstallPrompt: () => {
      set({ pendingHookChatPluginInstallPrompt: null });
    },

    inspectRecommendedPlugins: async (
      projectId,
      worktreeId,
      options,
    ): Promise<void> => {
      const scopeKey = buildRecommendedPluginScopeKey(
        projectId,
        worktreeId,
        options?.repoId,
      );
      if (
        !options?.force &&
        dismissedRecommendedPluginScopeKeys.has(scopeKey)
      ) {
        return;
      }

      let response;
      try {
        response = await window.api.inspectRecommendedPlugins({
          workspaceId: projectId,
          worktreeId,
          repoId: options?.repoId,
        });
      } catch {
        return;
      }

      if (
        !response ||
        ((response.promptItems?.length ?? 0) === 0 &&
          (response.requirements?.length ?? 0) === 0)
      ) {
        return;
      }

      set({
        pendingRecommendedPluginPrompt: {
          projectId,
          worktreeId,
          repoId: options?.repoId,
          scopeLabel: options?.label ?? response.scopeLabel,
          items: response.promptItems ?? [],
          requirements: response.requirements ?? [],
        },
      });
    },

    applyRecommendedPlugins: async ({
      projectId,
      worktreeId,
      repoId,
      selectedKeys,
      optOutKeys,
      clearOptOutKeys,
      dismissPromptOnSuccess,
    }): Promise<ApplyRecommendedPluginsResponse> => {
      const response = await window.api.applyRecommendedPlugins({
        workspaceId: projectId,
        worktreeId,
        repoId,
        selectedKeys,
        optOutKeys,
        clearOptOutKeys,
      });

      // Re-pull projects so renderer state reflects the persisted
      // `defaultPluginSelections` and `recommendedPluginOptOutKeys` changes.
      await get().loadProjects({ silent: true });

      const acceptedAny = response.results.some(
        (result) =>
          result.status === 'selected' ||
          result.status === 'installed-and-selected',
      );
      if (acceptedAny) {
        await useChatStore
          .getState()
          .syncEmptyChatPluginSelections(
            projectId,
            worktreeId,
            response.defaultPluginSelections,
            { repoId },
          );
      }

      const allSucceeded = response.results.every(
        (result) => result.status !== 'error',
      );
      if (allSucceeded) {
        // Clear the dismissed flag so future inspections (e.g., new
        // recommendations added to canopy.json) can re-prompt.
        const scopeKey = buildRecommendedPluginScopeKey(
          projectId,
          worktreeId,
          repoId,
        );
        dismissedRecommendedPluginScopeKeys.delete(scopeKey);

        if (dismissPromptOnSuccess) {
          set({ pendingRecommendedPluginPrompt: null });
        }
      }

      return response;
    },

    dismissPendingRecommendedPluginPrompt: (options): void => {
      const current = get().pendingRecommendedPluginPrompt;
      if (current && options?.remember) {
        const scopeKey = buildRecommendedPluginScopeKey(
          current.projectId,
          current.worktreeId,
          current.repoId,
        );
        dismissedRecommendedPluginScopeKeys.add(scopeKey);
      }
      set({ pendingRecommendedPluginPrompt: null });
    },

    worktreeError: null,
    clearWorktreeError: () => set({ worktreeError: null }),

    branchRenameRequest: null,

    requestBranchRename: (projectId: string, worktreeId: string): void => {
      set({ branchRenameRequest: { projectId, worktreeId } });
    },

    clearBranchRenameRequest: (): void => {
      set({ branchRenameRequest: null });
    },

    branchInfoRequest: null,

    requestBranchInfo: (projectId: string, worktreeId: string): void => {
      set({ branchInfoRequest: { projectId, worktreeId } });
    },

    clearBranchInfoRequest: (): void => {
      set({ branchInfoRequest: null });
    },

    loadProjects: (options) => {
      const generation = ++projectsLoadGeneration;
      const inventoryStartedAt = Date.now();
      const completionPromise = new Promise<void>((resolve, reject) => {
        projectsLoadCompletionResolvers.set(generation, (error) => {
          if (options?.requireSuccess && error) reject(error);
          else resolve();
        });
      });
      if (__CANOPY_E2E__)
        observeFirstProjectsLoadRenderer(
          'projects-load-renderer-entered',
          () => {
            const state = get();
            return {
              generation,
              silent: options?.silent === true,
              isLoading: state.isLoading,
              hasHydratedProjects: state.hasHydratedProjects,
              priorProjectCount: state.projects.length,
            };
          },
        );
      void (async (): Promise<void> => {
        let heldE2eBarrier: E2eProjectsLoadBarrier | null = null;
        let settlementStage = 'ipc';
        let loadFailure: Error | undefined;
        const archiveSuppressedFilterKeys = new Set(
          archiveSuppressedWorktreeKeys,
        );
        set({
          projectInventoryStatus: 'loading',
          ...(!options?.silent ? { isLoading: true } : {}),
        });

        try {
          // Keep tracking removals until this load finishes applying its
          // response. IPC settling can precede optimistic archive removal
          // even when the stale snapshot has not reached the store yet.
          activeArchiveSuppressedLoadFilters.add(archiveSuppressedFilterKeys);
          const file = await window.api.loadProjects();
          settlementStage = 'post-ipc';
          if (__CANOPY_E2E__)
            observeFirstProjectsLoadRenderer(
              'projects-load-renderer-ipc-resolved',
              () => {
                const [loaded] = projectFirstProjectsLoadLists([file.items]);
                const remainingWorkspaceIds = Math.max(
                  0,
                  8 -
                    (Array.isArray(loaded.workspaceIds)
                      ? loaded.workspaceIds.length
                      : 0),
                );
                return {
                  generation,
                  ...loaded,
                  ...projectFirstProjectsLoadWarnings(
                    file.warnings,
                    remainingWorkspaceIds,
                  ),
                };
              },
            );
          heldE2eBarrier = await waitAtE2eProjectsLoadBarrier();
          if (generation !== projectsLoadGeneration) {
            if (__CANOPY_E2E__)
              observeFirstProjectsLoadRenderer(
                'projects-load-renderer-superseded',
                () => ({
                  generation,
                  latestGeneration: projectsLoadGeneration,
                  settlement: 'resolved',
                }),
              );
            return;
          }
          const loadWarnings = file.warnings ?? [];
          const loadedProjects = mergeLoadedProjectsWithLastGoodState(
            file.items,
            get().projects,
            loadWarnings,
          );
          const visibleItems = filterVisibleWorkspaceItems(
            filterArchiveSuppressedWorktrees(
              loadedProjects,
              archiveSuppressedFilterKeys,
            ),
          );
          const sorted = [...visibleItems].sort((a, b) => a.order - b.order);
          const normalized = mergePersistedPrStatuses(
            normalizeItemOrder(sorted),
            useGitHubStore.getState().prStatuses,
          );
          const nextWarningKeys = new Set<string>();
          const previousWarningKeys = get().projectLoadWarningKeys;

          for (const warning of loadWarnings) {
            const warningKey = createProjectLoadWarningKey(warning);
            nextWarningKeys.add(warningKey);
            if (!previousWarningKeys.has(warningKey)) {
              useGitHubStore
                .getState()
                .addToast(
                  formatProjectLoadWarningMessage(warning),
                  'error',
                  undefined,
                  { category: 'Pipeline' },
                );
            }
          }

          set({
            projects: shareUnchangedProjects(get().projects, normalized),
            isLoading: false,
            hasHydratedProjects: true,
            projectInventoryStatus: 'ready',
            projectInventorySnapshot: {
              projects: filterVisibleWorkspaceItems(loadedProjects),
              startedAt: inventoryStartedAt,
            },
            projectLoadWarningKeys: nextWarningKeys,
            failedWorkspaceIds: new Set(
              loadWarnings.map((warning) => warning.workspaceId),
            ),
          });
          settlementStage = 'post-apply';
          if (__CANOPY_E2E__)
            observeFirstProjectsLoadRenderer(
              'projects-load-renderer-applied',
              () => {
                const projections = projectFirstProjectsLoadLists([
                  file.items,
                  loadedProjects,
                  visibleItems,
                  normalized,
                ]);
                return {
                  generation,
                  loaded: projections[0],
                  merged: projections[1],
                  visible: projections[2],
                  applied: projections[3],
                  isLoading: get().isLoading,
                  hasHydratedProjects: get().hasHydratedProjects,
                };
              },
            );
          useGitHubStore.getState().hydratePersistedPrStatuses(normalized);
          await get()
            .refreshWorkspaceDrift(normalized)
            .catch(() => undefined);
        } catch (error) {
          loadFailure =
            error instanceof Error
              ? error
              : new Error('Failed to load projects.');
          const superseded = generation !== projectsLoadGeneration;
          if (__CANOPY_E2E__)
            observeFirstProjectsLoadRenderer(
              'projects-load-renderer-error',
              () => ({
                generation,
                latestGeneration: projectsLoadGeneration,
                phase: 'caught',
                settlementStage,
                superseded,
                ...classifyFirstProjectsLoadRendererError(error),
              }),
            );
          if (generation !== projectsLoadGeneration) {
            if (__CANOPY_E2E__)
              observeFirstProjectsLoadRenderer(
                'projects-load-renderer-superseded',
                () => ({
                  generation,
                  latestGeneration: projectsLoadGeneration,
                  settlement: 'rejected',
                }),
              );
            return;
          }
          // eslint-disable-next-line no-console
          console.error('Failed to load projects:', error);
          const current = get();
          set({
            isLoading: false,
            hasHydratedProjects: true,
            projectInventoryStatus: 'error',
            failedWorkspaceIds: new Set([
              ...Array.from(current.failedWorkspaceIds),
              ...current.projects.map((project) => project.id),
            ]),
          });
          if (__CANOPY_E2E__)
            observeFirstProjectsLoadRenderer(
              'projects-load-renderer-error',
              () => {
                const state = get();
                const [preserved] = projectFirstProjectsLoadLists([
                  state.projects,
                ]);
                return {
                  generation,
                  phase: 'state-preserved',
                  isLoading: state.isLoading,
                  hasHydratedProjects: state.hasHydratedProjects,
                  preserved,
                };
              },
            );
        } finally {
          activeArchiveSuppressedLoadFilters.delete(
            archiveSuppressedFilterKeys,
          );
          heldE2eBarrier?.resolveCompleted();
          if (e2eProjectsLoadBarrier === heldE2eBarrier) {
            e2eProjectsLoadBarrier = null;
          }
          if (generation === projectsLoadGeneration) {
            resolveProjectsLoadsThrough(generation, loadFailure);
          }
          if (__CANOPY_E2E__)
            observeFirstProjectsLoadRenderer(
              'projects-load-renderer-completed',
              () => ({
                generation,
                latestGeneration: projectsLoadGeneration,
                resolvedThrough: generation === projectsLoadGeneration,
              }),
            );
        }
      })();
      return completionPromise;
    },

    saveProjects: async (items, options) => {
      const payload = mergePersistedPrStatuses(
        items ?? get().projects,
        useGitHubStore.getState().prStatuses,
      );
      const preserveWorkspaceIds = Array.from(get().failedWorkspaceIds);
      const saveOptions =
        preserveWorkspaceIds.length > 0
          ? { ...options, preserveWorkspaceIds }
          : options;
      try {
        if (saveOptions) {
          await window.api.saveProjects(payload, saveOptions);
        } else {
          await window.api.saveProjects(payload);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to save projects:', error);
      }
    },

    refreshWorkspaceDrift: async (items) => {
      const sourceItems = items ?? get().projects;
      const entries = await Promise.all(
        sourceItems.flatMap((item) =>
          item.type === 'cowork'
            ? []
            : item.worktrees.map(async (worktree) => {
                const summary = await window.api
                  .readWorkspaceDriftSummary({
                    workspaceId: item.id,
                    worktreeId: worktree.id,
                  })
                  .catch(
                    (): WorkspaceDriftSummary => ({
                      hasDrift: false,
                      blockingIssueCount: 0,
                      warningIssueCount: 0,
                    }),
                  );
                const entry: WorkspaceDriftEntry = {
                  key: createWorkspaceDriftKey(item.id, worktree.id),
                  summary,
                };
                return entry;
              }),
        ),
      );

      const workspaceDrift: Record<string, WorkspaceDriftSummary> = {};
      for (const entry of entries) {
        workspaceDrift[entry.key] = entry.summary;
      }

      set({ workspaceDrift });
    },

    browseForRepo: async () => {
      // The add-workspace flow is cowork-capable: a non-git folder becomes
      // an external cowork workspace further down `addLocalRepo`, so this
      // must not reject non-git folders at browse time.
      return window.api.browseForRepo({ allowNonGit: true });
    },

    addLocalRepo: async (repoPath, options) => {
      const workspace = await window.api.addWorkspaceFromFolder({ repoPath });
      await get().loadProjects();
      if (workspace.type === 'cowork' && options?.activate !== false) {
        const { useStandaloneChatStore } =
          await import('./standaloneChatStore');
        await useStandaloneChatStore
          .getState()
          .activateCreatedCoworkWorkspace(workspace.id);
      }
      return { id: workspace.id, type: workspace.type };
    },

    addRemoteRepo: async (remoteUrl, destinationDir, options) => {
      const workspace = await window.api.addWorkspaceFromRemote({
        remoteUrl,
        destinationDir,
        ...(options?.jobId ? { jobId: options.jobId } : {}),
      });
      await get().loadProjects();
      return workspace.id;
    },

    initLocalRepo: async (name) => {
      const workspace = await window.api.createNewWorkspace({ name });
      await get().loadProjects();
      return workspace.id;
    },

    createOrgMemberCodeProject: async (request) => {
      const result =
        await window.api.orgProjects.createMemberCodeProject(request);
      if (result.ok) {
        // The project already exists. A stale sidebar is recoverable and must
        // not turn a successful create into a reported failure.
        await get()
          .loadProjects({ silent: true })
          .catch((): undefined => undefined);
      }
      return result;
    },

    createOrgMemberMultiRepoProject: async (request) => {
      const result =
        await window.api.orgProjects.createMemberMultiRepoProject(request);
      // The local project may exist even when its setup failed.
      if (result.ok || result.code === 'setup-failed')
        await get()
          .loadProjects({ silent: true })
          .catch((): undefined => undefined);
      return result;
    },

    removeProject: async (projectId) => {
      const updated = normalizeItemOrder(
        get().projects.filter((item) => item.id !== projectId),
      );
      set({ projects: updated });
      await get().saveProjects(updated);

      const existingDiffs = get().diffStats;
      const filteredDiffs: Record<string, DiffStats> = {};
      const existingCommitsAhead = get().commitsAhead;
      const filteredCommitsAhead: Record<string, boolean> = {};
      const existingBaseBranches = get().baseBranches;
      const filteredBaseBranches: Record<string, string | null> = {};
      const existingDefaultBranches = get().defaultBranches;
      const filteredDefaultBranches: Record<string, string | null> = {};

      for (const [key, value] of Object.entries(existingDiffs)) {
        if (!key.startsWith(`${projectId}/`)) {
          filteredDiffs[key] = value;
        }
      }

      for (const [key, value] of Object.entries(existingCommitsAhead)) {
        if (!key.startsWith(`${projectId}/`)) {
          filteredCommitsAhead[key] = value;
        }
      }

      for (const [key, value] of Object.entries(existingBaseBranches)) {
        if (!key.startsWith(`${projectId}/`)) {
          filteredBaseBranches[key] = value;
        }
      }

      for (const [key, value] of Object.entries(existingDefaultBranches)) {
        if (!key.startsWith(`${projectId}/`)) {
          filteredDefaultBranches[key] = value;
        }
      }

      const filteredWorkspaceDrift: Record<string, WorkspaceDriftSummary> = {};
      for (const [key, value] of Object.entries(get().workspaceDrift)) {
        if (!key.startsWith(`${projectId}/`)) {
          filteredWorkspaceDrift[key] = value;
        }
      }

      set({
        appliedProjectWorktreeScripts:
          omitAppliedProjectWorktreeScriptsForPrefix(
            get().appliedProjectWorktreeScripts,
            `${projectId}/`,
          ),
        appliedProjectWorktreeHooks: omitAppliedProjectWorktreeHooksForPrefix(
          get().appliedProjectWorktreeHooks,
          `${projectId}/`,
        ),
        diffStats: filteredDiffs,
        commitsAhead: filteredCommitsAhead,
        baseBranches: filteredBaseBranches,
        defaultBranches: filteredDefaultBranches,
        workspaceDrift: filteredWorkspaceDrift,
      });
    },

    registerCreatedWorkspaceWorktree: async (projectId, created, options) =>
      finalizeCreatedWorktree(projectId, created, get, set, options),

    ...createWorktreeCreationActions({
      get,
      set,
      finalizeCreatedWorktree,
      drainPendingTaskBranchNaming,
      removeTemporaryWorkspaceFromUi,
      refreshDiffStatsForWorktrees,
    }),

    cancelPendingWorkspaceRepair: async () => {
      const pending = get().pendingWorkspaceRepair;
      if (!pending) {
        return;
      }

      set({
        workspaceRepairPending: true,
        worktreeError: null,
      });

      try {
        const response = await window.api.archiveWorkspaceWorktree({
          workspaceId: pending.workspaceId,
          worktreeId: pending.id,
        });
        set({
          pendingWorkspaceRepair: null,
        });
        // Cancelling is the terminal outcome for a deferred-creation
        // needs-repair rollback — the chat state (including any message
        // queued before setup) was kept alive for the repair flow and must be
        // torn down with the worktree now.
        useChatStore
          .getState()
          .cleanupWorktree(pending.workspaceId, pending.id);
        useChatStore
          .getState()
          .dropWorktreeQueuedState(pending.workspaceId, pending.id);
        removeTemporaryWorkspaceFromUi(
          response.removedTemporaryWorkspaceId,
          get,
          set,
        );
      } catch (error) {
        const appError = toAppError(resolveClientAppError(error));
        if (appError)
          set({
            worktreeError: inlineFailure(
              appError,
              "Couldn't cancel the repair.",
            ),
          });
      } finally {
        set({ workspaceRepairPending: false });
      }
    },

    setupWorkspace: async (workspaceId, worktreeId) => {
      const item = get().projects.find(
        (project): project is MultiRepoSidebarItem =>
          project.type === 'multi-repo' && project.id === workspaceId,
      );
      if (!item) {
        throw new Error(`Project ${workspaceId} not found`);
      }

      await runWorkspaceLifecycle({
        item,
        workspaceId,
        worktreeId,
        lifecycle: 'setup',
        alreadyRunningMessage: 'Project setup is already running',
        createRootFailure: (response): Error =>
          createWorkspaceLifecycleError('setup', response),
        createRepoFailure: (_repo, response): Error =>
          createWorkspaceLifecycleError('setup', response),
      });
    },

    launchWorkspace: async (workspaceId, worktreeId) => {
      const item = get().projects.find(
        (project): project is MultiRepoSidebarItem =>
          project.type === 'multi-repo' && project.id === workspaceId,
      );
      if (!item) {
        throw new Error(`Project ${workspaceId} not found`);
      }

      await runWorkspaceLifecycle({
        item,
        workspaceId,
        worktreeId,
        lifecycle: 'launch',
        alreadyRunningMessage: 'Project launch is already running',
        createRootFailure: (response): Error =>
          createWorkspaceLifecycleError('launch', response),
        createRepoFailure: (_repo, response): Error =>
          createWorkspaceLifecycleError('launch', response),
      });
    },

    teardownWorkspace: async (workspaceId, worktreeId) => {
      const item = get().projects.find(
        (project): project is MultiRepoSidebarItem =>
          project.type === 'multi-repo' && project.id === workspaceId,
      );
      if (!item) {
        throw new Error(`Project ${workspaceId} not found`);
      }

      await runWorkspaceLifecycle({
        item,
        workspaceId,
        worktreeId,
        lifecycle: 'teardown',
        alreadyRunningMessage: 'Project teardown is already running',
        createRootFailure: (response): Error =>
          createWorkspaceLifecycleError('teardown', response),
        createRepoFailure: (_repo, response): Error =>
          createWorkspaceLifecycleError('teardown', response),
      });
    },

    archiveWorktree: async (projectId, worktreeId, options) => {
      const archiveKey = createDiffStatsKey(projectId, worktreeId);
      const existingArchive = inFlightArchives.get(archiveKey);
      if (existingArchive) return existingArchive;

      const item = get().projects.find((p) => p.id === projectId);
      if (!item || item.type === 'cowork') return;

      const archiveOperation = (async (): Promise<void> => {
        // Every route below, files-only and missing-checkout included.
        await markArchivingAndAdmitSource(
          archiveKey,
          projectId,
          worktreeId,
          item.type,
          get,
          set,
        );

        const targetWorktree = item.worktrees.find(
          (wt) => wt.id === worktreeId,
        );
        const isPendingGitSetup = targetWorktree?.setupPhase === 'git-pending';

        // Announce the removal to the "Archived and deleted" surfaces right
        // away: teardown, capture, and Git cleanup can take a while, and the
        // row leaves the sidebar long before main commits the container.
        const archivedContainersStore = useArchivedContainersStore.getState();
        archivedContainersStore.registerPendingContainer({
          workspaceId: projectId,
          containerId: worktreeId,
          kind: 'worktree',
          name:
            targetWorktree?.label ?? targetWorktree?.branchName ?? worktreeId,
          ...(targetWorktree?.branchName !== undefined
            ? { branchName: targetWorktree.branchName }
            : {}),
          state: options?.lockAfterArchive === true ? 'archived' : 'deleted',
        });
        await awaitPendingRemovalHoldForE2e();

        deselectIfSelectedWorktree(projectId, worktreeId);
        const teardownKey = `${projectId}/${worktreeId}`;
        let archiveSnapshot: ArchiveUiSnapshot | null = null;

        try {
          await cancelWorktreeSetup(projectId, worktreeId);
          if (isPendingGitSetup) {
            // For git-pending worktrees, skip renderer script/hook teardown.
            // No scripts/hooks could have been started against a worktree
            // whose directory does not exist yet, and the backend handles
            // cancellation of in-flight setup.
            archiveSnapshot = await beginArchiveUiRemoval(
              projectId,
              worktreeId,
              get,
              set,
            );
            options?.onUiRemoved?.();
            await performArchive(
              projectId,
              worktreeId,
              item,
              archiveSnapshot,
              get,
              set,
              options,
            );
          } else {
            const hasTeardown =
              item.type === 'single-repo'
                ? Boolean(
                    getScriptCommand(
                      getSingleRepoDisplayScripts(
                        item,
                        worktreeId,
                        get().appliedProjectWorktreeScripts,
                      ),
                      'teardown',
                    ),
                  )
                : hasWorkspaceLifecycleScripts(item, worktreeId, 'teardown');

            await stopRunningScripts(projectId, worktreeId);
            await stopRunningHooks(projectId, worktreeId);

            if (hasTeardown) {
              const next = new Set(get().tearingDownWorktrees);
              next.add(teardownKey);
              set({ tearingDownWorktrees: next });
              try {
                await runTeardown(
                  item,
                  projectId,
                  worktreeId,
                  get().appliedProjectWorktreeScripts,
                );
              } finally {
                const done = new Set(get().tearingDownWorktrees);
                done.delete(teardownKey);
                set({ tearingDownWorktrees: done });
              }
            }

            archiveSnapshot = await beginArchiveUiRemoval(
              projectId,
              worktreeId,
              get,
              set,
            );
            options?.onUiRemoved?.();
            await performArchive(
              projectId,
              worktreeId,
              item,
              archiveSnapshot,
              get,
              set,
              options,
            );
          }
        } catch (error) {
          if (archiveSnapshot) {
            rollbackArchiveUiRemoval(archiveSnapshot, get, set);
          }
          archivedContainersStore.clearPendingContainer(projectId, worktreeId);
          // Every desktop worktree removal funnels here or through
          // "Delete without teardown" below (CAN-5335).
          offerLifecycleJournalQuarantine(error);
          throw error;
        } finally {
          const archivingWorktrees = new Set(get().archivingWorktrees);
          archivingWorktrees.delete(archiveKey);
          set({
            archivingWorktrees,
            appliedProjectWorktreeScripts:
              omitAppliedProjectWorktreeScriptsForKey(
                get().appliedProjectWorktreeScripts,
                createAppliedProjectWorktreeScriptsKey(projectId, worktreeId),
              ),
            appliedProjectWorktreeHooks: omitAppliedProjectWorktreeHooksForKey(
              get().appliedProjectWorktreeHooks,
              createAppliedProjectWorktreeHooksKey(projectId, worktreeId),
            ),
          });
          if (
            get().projects.some(
              (project) =>
                project.id === projectId &&
                project.type !== 'cowork' &&
                project.worktrees.some((row) => row.id === worktreeId),
            )
          )
            refreshRestoredWorktreeActivity(projectId, worktreeId);
        }
      })();

      const trackedArchive = archiveOperation.finally(() => {
        if (inFlightArchives.get(archiveKey) === trackedArchive) {
          inFlightArchives.delete(archiveKey);
        }
      });
      inFlightArchives.set(archiveKey, trackedArchive);
      await trackedArchive;
    },

    reconcileArchivedWorktree: async (projectId, worktreeId, options) => {
      cleanupArchivedWorktreeRendererState(projectId, worktreeId, get);
      const removeDeletedWorktree = (): void => {
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId && project.type !== 'cowork'
              ? {
                  ...project,
                  worktrees: project.worktrees.filter(
                    (worktree) => worktree.id !== worktreeId,
                  ),
                }
              : project,
          ),
        }));
        // Main reports the project without checking Always show, so apply the
        // sidebar's own retirement policy rather than removing it outright.
        const emptied = get().projects.find(
          (project) => project.id === options?.removedTemporaryWorkspaceId,
        );
        if (emptied && isRetiredTemporaryWorkspace(emptied))
          removeTemporaryWorkspaceFromUi(emptied.id, get, set);
      };
      removeDeletedWorktree();
      await get().loadProjects({ silent: true });
      // The completion event is authoritative. A concurrent or cached project
      // refresh can briefly return the pre-delete snapshot, so enforce the
      // deletion again after the refresh rather than resurrecting the row.
      removeDeletedWorktree();
    },

    forceArchiveWorktree: async (projectId, worktreeId, options) => {
      const archiveKey = createDiffStatsKey(projectId, worktreeId);
      const existingArchive = inFlightArchives.get(archiveKey);
      if (existingArchive) return existingArchive;

      const item = get().projects.find((p) => p.id === projectId);
      if (!item || item.type === 'cowork') return;

      const archiveOperation = (async (): Promise<void> => {
        // "Delete without teardown" skips teardown, not source admission.
        await markArchivingAndAdmitSource(
          archiveKey,
          projectId,
          worktreeId,
          item.type,
          get,
          set,
        );

        const targetWorktree = item.worktrees.find(
          (wt) => wt.id === worktreeId,
        );
        const isPendingGitSetup = targetWorktree?.setupPhase === 'git-pending';

        deselectIfSelectedWorktree(projectId, worktreeId);
        let archiveSnapshot: ArchiveUiSnapshot | null = null;

        try {
          await cancelWorktreeSetup(projectId, worktreeId);
          if (!isPendingGitSetup) {
            await stopRunningScripts(projectId, worktreeId);
            await stopRunningHooks(projectId, worktreeId);
          }
          archiveSnapshot = await beginArchiveUiRemoval(
            projectId,
            worktreeId,
            get,
            set,
          );
          await performArchive(
            projectId,
            worktreeId,
            item,
            archiveSnapshot,
            get,
            set,
            options,
          );
        } catch (error) {
          if (archiveSnapshot) {
            rollbackArchiveUiRemoval(archiveSnapshot, get, set);
          }
          offerLifecycleJournalQuarantine(error);
          throw error;
        } finally {
          const archivingWorktrees = new Set(get().archivingWorktrees);
          archivingWorktrees.delete(archiveKey);
          set({
            archivingWorktrees,
            appliedProjectWorktreeScripts:
              omitAppliedProjectWorktreeScriptsForKey(
                get().appliedProjectWorktreeScripts,
                createAppliedProjectWorktreeScriptsKey(projectId, worktreeId),
              ),
            appliedProjectWorktreeHooks: omitAppliedProjectWorktreeHooksForKey(
              get().appliedProjectWorktreeHooks,
              createAppliedProjectWorktreeHooksKey(projectId, worktreeId),
            ),
          });
          if (
            get().projects.some(
              (project) =>
                project.id === projectId &&
                project.type !== 'cowork' &&
                project.worktrees.some((row) => row.id === worktreeId),
            )
          )
            refreshRestoredWorktreeActivity(projectId, worktreeId);
        }
      })();

      const trackedArchive = archiveOperation.finally(() => {
        if (inFlightArchives.get(archiveKey) === trackedArchive) {
          inFlightArchives.delete(archiveKey);
        }
      });
      inFlightArchives.set(archiveKey, trackedArchive);
      await trackedArchive;
    },

    toggleCollapsed: async (projectId) => {
      const updatedProjects = get().projects.map((item) => {
        if (item.id !== projectId) return item;

        return {
          ...item,
          collapsed: !item.collapsed,
        };
      });

      set({ projects: updatedProjects });
      await get().saveProjects(updatedProjects);
    },

    reorderProjects: async (activeProjectId, overProjectId) => {
      const current = [...get().projects].sort((a, b) => a.order - b.order);
      const oldIndex = current.findIndex((item) => item.id === activeProjectId);
      const newIndex = current.findIndex((item) => item.id === overProjectId);

      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
        return;
      }

      const reordered = normalizeItemOrder(
        arrayMove(current, oldIndex, newIndex),
      );
      set({ projects: reordered });
      await get().saveProjects(reordered, { replaceWorkspaceOrder: true });
    },

    reorderWorktrees: async (projectId, activeWorktreeId, overWorktreeId) => {
      const previousProjects = get().projects;
      let changed = false;
      const updatedProjects = previousProjects.map((item) => {
        if (item.id !== projectId || item.type === 'cowork') return item;
        const worktrees = reorderVisibleWorktrees(
          item.worktrees,
          activeWorktreeId,
          overWorktreeId,
        );
        if (worktrees === item.worktrees) return item;
        changed = true;
        return {
          ...item,
          worktrees,
        };
      });
      if (!changed) return;
      set({ projects: updatedProjects });
      try {
        await window.api.reorderWorktrees({
          workspaceId: projectId,
          activeWorktreeId,
          overWorktreeId,
        });
      } catch {
        if (get().projects === updatedProjects) {
          set({ projects: previousProjects });
        }
        useGitHubStore
          .getState()
          .addToast('Try reordering the items again', 'error', undefined, {
            projectId,
            worktreeId: activeWorktreeId,
          });
      }
      // Reconcile concurrent creation/archive and supersede loads started
      // before the canonical write acknowledged, including on rejection.
      await get().loadProjects({ silent: true });
    },

    reorderActivitySections: async (projectId, newOrder) => {
      const updatedProjects = get().projects.map((item) => {
        if (item.id !== projectId) return item;
        return { ...item, activitySectionOrder: newOrder };
      });
      set({ projects: updatedProjects });
      await get().saveProjects(updatedProjects);
    },

    getBaseBranch: (projectId, worktreeId) => {
      return get().baseBranches[createDiffStatsKey(projectId, worktreeId)];
    },

    refreshDiffStats: () => {
      if (diffStatsRefreshPromise) {
        diffStatsRefreshQueued = true;
        return diffStatsRefreshPromise;
      }

      const run = async (): Promise<void> => {
        do {
          diffStatsRefreshQueued = false;
          await runRefreshDiffStatsOnce();
        } while (diffStatsRefreshQueued);
      };

      diffStatsRefreshPromise = run().finally(() => {
        diffStatsRefreshPromise = null;
        diffStatsRefreshQueued = false;
      });

      return diffStatsRefreshPromise;
    },

    refreshDiffStatsScheduled: () => {
      // Periodic tick: never queue behind an in-flight refresh (the next tick
      // covers it), but a full refresh requested while this tick runs still
      // gets its trailing full pass via the shared queue flag.
      if (diffStatsRefreshPromise) {
        return diffStatsRefreshPromise;
      }

      const run = async (): Promise<void> => {
        await runScheduledDiffStatsTickOnce();
        while (diffStatsRefreshQueued) {
          diffStatsRefreshQueued = false;
          await runRefreshDiffStatsOnce();
        }
      };

      diffStatsRefreshPromise = run().finally(() => {
        diffStatsRefreshPromise = null;
        diffStatsRefreshQueued = false;
      });

      return diffStatsRefreshPromise;
    },

    refreshWorktreeDiffStats: (projectId, worktreeId) =>
      refreshDiffStatsForWorktrees([{ projectId, worktreeId }], {
        skipFetch: true,
      }).then(() => undefined),

    refreshWorktreeDiffStatsVerified: (projectId, worktreeId) =>
      refreshDiffStatsForWorktrees([{ projectId, worktreeId }], {
        skipFetch: true,
      }),

    refreshWorktreeDiffStatsFromRemote: (projectId, worktreeId) =>
      refreshDiffStatsForWorktrees([{ projectId, worktreeId }]).then(
        () => undefined,
      ),

    refreshWorktreesDiffStatsFromRemote: (worktrees) =>
      refreshDiffStatsForWorktrees(worktrees).then(() => undefined),

    fastRefreshWorktreeDiffStats: (projectId, worktreeId, options): void => {
      fastDiffStatsQueue.enqueue(projectId, worktreeId, options);
    },

    retryWorktreeHealthCheck: async (
      projectId,
      worktreeId,
    ): Promise<WorktreeHealthCheckResponse> => {
      const response = await window.api.retryWorktreeHealthCheck({
        projectId,
        worktreeId,
      });

      const currentProjects = get().projects;
      const updatedProjects = currentProjects.map((project) => {
        if (project.id !== projectId || project.type === 'cowork') {
          return project;
        }
        return {
          ...project,
          worktrees: project.worktrees.map((wt) =>
            wt.id === worktreeId ? response.worktree : wt,
          ),
        };
      });
      set({ projects: updatedProjects });

      // Refresh in the background so the retry button reflects the health-check
      // result immediately instead of waiting on potentially slow git stats.
      void get().refreshWorktreeDiffStatsFromRemote(projectId, worktreeId);

      return response;
    },

    updateBranchName: (projectId, worktreeId, newBranchName, repoId): void => {
      const key = createDiffStatsKey(projectId, worktreeId);
      const updatesSidebarBranch = !repoId || repoId === WORKSPACE_ROOT_REPO_ID;

      if (repoId) {
        // Multi-repo: update the specific repo branch in repoBranches
        const currentRepoBranches = get().repoBranches[key];
        if (currentRepoBranches) {
          set({
            repoBranches: {
              ...get().repoBranches,
              [key]: currentRepoBranches.map((rb) =>
                rb.repoId === repoId ? { ...rb, branch: newBranchName } : rb,
              ),
            },
          });
        }
      }

      set({
        projects: clearWorktreePrStateForBranchChange(
          get().projects,
          projectId,
          worktreeId,
          updatesSidebarBranch ? newBranchName : undefined,
        ),
      });
      useGitHubStore.getState().clearWorktreePrStatus(projectId, worktreeId);
      void useGitHubStore.getState().requestFastRefresh(projectId, worktreeId);
    },

    setTrackedBaseBranch: async (
      projectId,
      worktreeId,
      baseBranch,
      repoId,
      presence,
    ): Promise<void> => {
      const key = createDiffStatsKey(projectId, worktreeId);
      // Persist first. If the targeted write fails, renderer state remains on
      // the last authoritative value, so automatic PR-base adoption still has
      // a live drift to retry and manual changes never manufacture a phantom
      // explicit choice. Main serializes this with its other worktree writes.
      await window.api.setTrackedBaseBranch({
        workspaceId: projectId,
        worktreeId,
        repoId,
        baseBranch,
      });
      const nextBaseBranchExistsLocally =
        presence !== undefined
          ? {
              ...get().baseBranchExistsLocally,
              [key]: presence.existsLocally,
            }
          : get().baseBranchExistsLocally;
      const nextBaseBranchExistsInRemote =
        presence !== undefined
          ? {
              ...get().baseBranchExistsInRemote,
              [key]: presence.existsInRemote,
            }
          : get().baseBranchExistsInRemote;

      // Optimistically patch baseBranches for single-repo
      const nextBaseBranches = !repoId
        ? { ...get().baseBranches, [key]: baseBranch }
        : get().baseBranches;

      // Optimistically patch repoBranches for multi-repo. Presence metadata is
      // optional because some callers (for example aligning with a PR's base)
      // know the authoritative branch name before the next git-stat refresh
      // has resolved its local/remote refs.
      let nextRepoBranches = get().repoBranches;
      if (repoId) {
        const current = nextRepoBranches[key];
        if (current) {
          nextRepoBranches = {
            ...nextRepoBranches,
            [key]: current.map((rb) =>
              rb.repoId === repoId
                ? {
                    ...rb,
                    baseBranch: baseBranch ?? undefined,
                    ...(presence
                      ? {
                          baseBranchExistsLocally: presence.existsLocally,
                          baseBranchExistsInRemote: presence.existsInRemote,
                        }
                      : {}),
                  }
                : rb,
            ),
          };
        }
      }

      set({
        projects: get().projects.map((project) => {
          if (project.id !== projectId || project.type === 'cowork') {
            return project;
          }
          return {
            ...project,
            worktrees: project.worktrees.map((wt) => {
              if (wt.id !== worktreeId) return wt;
              const retargetedWorktree = { ...wt };
              delete retargetedWorktree.branchGroupingParentWorktreeId;
              if (repoId) {
                // Multi-repo: set or delete the per-repo entry
                const existing =
                  retargetedWorktree.trackedRepoBaseBranches ?? {};
                if (baseBranch !== null) {
                  return {
                    ...retargetedWorktree,
                    trackedRepoBaseBranches: {
                      ...existing,
                      [repoId]: baseBranch,
                    },
                  };
                } else {
                  const rest = Object.fromEntries(
                    Object.entries(existing).filter(([k]) => k !== repoId),
                  );
                  return {
                    ...retargetedWorktree,
                    trackedRepoBaseBranches:
                      Object.keys(rest).length > 0 ? rest : undefined,
                  };
                }
              } else {
                // Single-repo: set trackedBaseBranch directly
                return {
                  ...retargetedWorktree,
                  trackedBaseBranch: baseBranch,
                };
              }
            }),
          };
        }),
        baseBranches: nextBaseBranches,
        baseBranchExistsLocally: nextBaseBranchExistsLocally,
        baseBranchExistsInRemote: nextBaseBranchExistsInRemote,
        repoBranches: nextRepoBranches,
      });
      // Explicit user intent is persisted through a targeted write rather
      // than the wholesale `saveProjects()` snapshot. The main process now
      // preserves `trackedBaseBranch` / `trackedRepoBaseBranches` across a
      // wholesale renderer save (so a stale 30s diff-stats snapshot can no
      // longer drop a main-process retarget), which also means a wholesale
      // save can no longer *carry* this change — a clear included. The
      // targeted channel writes through the same `updateWorkspaceWorktrees`
      // funnel the main-process retargeter uses.
      // Reconcile the changed worktree immediately. Both stats and a visible
      // changed-files list depend on the persisted base branch, so start their
      // targeted reads together once the save has made that base authoritative.
      await Promise.all([
        get().refreshWorktreeDiffStatsFromRemote(projectId, worktreeId),
        requestLoadedChangedFilesRefresh(projectId, worktreeId),
      ]);
    },

    setWorktreeLastKnownPrStatus: (projectId, worktreeId, status): void => {
      set({
        projects: updateWorktreeLastKnownPrStatus(
          get().projects,
          projectId,
          worktreeId,
          status,
        ),
      });
    },

    applyDependentBaseBranchUpdates: (updates): void => {
      const state = get();
      const nextDiffStatsState =
        applyDependentBaseBranchUpdatesToDiffStatsState(state, updates);
      set({
        projects: applyDependentBaseBranchUpdatesToItems(
          state.projects,
          updates,
        ),
        ...nextDiffStatsState,
      });
    },

    markWorktreePipelineExecutionsSeen: async (
      projectId,
      worktreeId,
      executionIds,
    ): Promise<void> => {
      const updatedProjects = updateWorktreeSeenPipelineExecutionIds(
        get().projects,
        projectId,
        worktreeId,
        executionIds,
        'add',
      );
      if (updatedProjects === get().projects) {
        return;
      }
      set({ projects: updatedProjects });
      await get().saveProjects(updatedProjects);
    },

    pruneStaleSeenPipelineExecutionIds: async (
      activeExecutionIdsByWorktree,
    ): Promise<void> => {
      const updatedProjects = pruneStaleSeenPipelineExecutionIds(
        get().projects,
        activeExecutionIdsByWorktree,
      );
      if (updatedProjects === get().projects) {
        return;
      }
      set({ projects: updatedProjects });
      await get().saveProjects(updatedProjects);
    },

    clearWorktreeSeenPipelineExecutions: async (
      projectId,
      worktreeId,
      executionIds,
    ): Promise<void> => {
      const updatedProjects = updateWorktreeSeenPipelineExecutionIds(
        get().projects,
        projectId,
        worktreeId,
        executionIds,
        'remove',
      );
      if (updatedProjects === get().projects) {
        return;
      }
      set({ projects: updatedProjects });
      await get().saveProjects(updatedProjects);
    },

    setWorktreePausedHookKeys: async (
      projectId,
      worktreeId,
      pausedHookKeys,
    ): Promise<void> => {
      const uniqueKeys = normalizePausedHookKeys(pausedHookKeys);
      const previousProjects = get().projects;
      let changed = false;
      const nextProjects = previousProjects.map((project) => {
        if (project.id !== projectId || project.type === 'cowork') {
          return project;
        }
        return {
          ...project,
          worktrees: project.worktrees.map((worktree) => {
            if (worktree.id !== worktreeId) {
              return worktree;
            }
            const current = normalizePausedHookKeys(
              worktree.pausedHookKeys ?? [],
            );
            if (areStringArraysEqual(current, uniqueKeys)) {
              return worktree;
            }
            changed = true;
            if (uniqueKeys.length === 0) {
              const next = { ...worktree };
              delete next.pausedHookKeys;
              return next;
            }
            return { ...worktree, pausedHookKeys: uniqueKeys };
          }),
        };
      });
      if (!changed) {
        return;
      }
      set({ projects: nextProjects });
      try {
        await window.api.setWorktreePausedHooks({
          projectId,
          worktreeId,
          pausedHookKeys: uniqueKeys,
        });
      } catch {
        if (get().projects === nextProjects) {
          set({ projects: previousProjects });
        }
        useGitHubStore
          .getState()
          .addToast('Failed to update paused hooks', 'error', undefined, {
            category: 'Hook',
            projectId,
            worktreeId,
          });
      }
    },

    setWorktreeHidden: async (projectId, worktreeId, hidden): Promise<void> => {
      const previousProjects = get().projects;
      let changed = false;
      const nextProjects = previousProjects.map((project) => {
        if (project.id !== projectId || project.type === 'cowork') {
          return project;
        }
        return {
          ...project,
          worktrees: project.worktrees.map((worktree) => {
            if (worktree.id !== worktreeId) {
              return worktree;
            }
            const current = worktree.hidden === true;
            if (current === hidden) {
              return worktree;
            }
            changed = true;
            if (hidden) {
              return { ...worktree, hidden: true };
            }
            const next = { ...worktree };
            delete next.hidden;
            return next;
          }),
        };
      });
      if (!changed) {
        return;
      }
      set({ projects: nextProjects });
      try {
        await window.api.setWorktreeHidden({
          projectId,
          worktreeId,
          hidden,
        });
      } catch {
        // Only this row's flag: a selection's Hide runs several at once.
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== projectId || project.type === 'cowork') {
              return project;
            }
            let rolledBack = false;
            const worktrees = project.worktrees.map((worktree) => {
              if (
                worktree.id !== worktreeId ||
                (worktree.hidden === true) !== hidden
              ) {
                return worktree;
              }
              rolledBack = true;
              if (!hidden) {
                return { ...worktree, hidden: true };
              }
              const next = { ...worktree };
              delete next.hidden;
              return next;
            });
            return rolledBack ? { ...project, worktrees } : project;
          }),
        }));
        useGitHubStore
          .getState()
          .addToast('Failed to update hidden state', 'error', undefined, {
            projectId,
            worktreeId,
          });
      }
    },

    setWorktreeLabel: async (projectId, worktreeId, label): Promise<void> => {
      const trimmed = label?.trim() ?? '';
      const nextLabel = trimmed.length > 0 ? trimmed : undefined;
      const previousProjects = get().projects;
      let changed = false;
      const nextProjects = previousProjects.map((project) => {
        if (project.id !== projectId || project.type === 'cowork') {
          return project;
        }
        return {
          ...project,
          worktrees: project.worktrees.map((worktree) => {
            if (worktree.id !== worktreeId) {
              return worktree;
            }
            if ((worktree.label ?? undefined) === nextLabel) {
              return worktree;
            }
            changed = true;
            if (nextLabel === undefined) {
              const next = { ...worktree };
              delete next.label;
              return next;
            }
            return { ...worktree, label: nextLabel };
          }),
        };
      });
      if (!changed) {
        return;
      }
      set({ projects: nextProjects });
      try {
        await window.api.setWorktreeLabel({
          projectId,
          worktreeId,
          ...(nextLabel !== undefined ? { label: nextLabel } : {}),
        });
      } catch {
        if (get().projects === nextProjects) {
          set({ projects: previousProjects });
        }
        useGitHubStore
          .getState()
          .addToast('Failed to update label', 'error', undefined, {
            projectId,
            worktreeId,
          });
      }
    },

    setWorktreePinned: async (projectId, worktreeId, pinned): Promise<void> => {
      const previousProjects = get().projects;
      let previousPinned = false;
      let changed = false;
      const nextProjects = previousProjects.map((project) => {
        if (project.id !== projectId || project.type === 'cowork') {
          return project;
        }
        return {
          ...project,
          worktrees: project.worktrees.map((worktree) => {
            if (worktree.id !== worktreeId) {
              return worktree;
            }
            if ((worktree.pinned === true) === pinned) {
              return worktree;
            }
            previousPinned = worktree.pinned === true;
            changed = true;
            if (!pinned) {
              const next = { ...worktree };
              delete next.pinned;
              return next;
            }
            return { ...worktree, pinned: true };
          }),
        };
      });
      if (!changed) {
        return;
      }
      set({ projects: nextProjects });
      try {
        await window.api.setWorktreePinned({ projectId, worktreeId, pinned });
      } catch {
        set((state) => ({
          projects: state.projects.map((project) => {
            if (project.id !== projectId || project.type === 'cowork') {
              return project;
            }
            let rolledBack = false;
            const worktrees = project.worktrees.map((worktree) => {
              if (
                worktree.id !== worktreeId ||
                (worktree.pinned === true) !== pinned
              ) {
                return worktree;
              }
              rolledBack = true;
              if (previousPinned) {
                return { ...worktree, pinned: true };
              }
              const next = { ...worktree };
              delete next.pinned;
              return next;
            });
            return rolledBack ? { ...project, worktrees } : project;
          }),
        }));
        useGitHubStore
          .getState()
          .addToast(
            pinned ? 'Failed to pin' : 'Failed to unpin',
            'error',
            undefined,
            { projectId, worktreeId },
          );
      }
    },

    setWorkspacePinned: async (workspaceId, pinned): Promise<void> => {
      const previousProjects = get().projects;
      let previousPinned = false;
      let changed = false;
      const nextProjects = previousProjects.map((project) => {
        if (project.id !== workspaceId) {
          return project;
        }
        if ((project.pinned === true) === pinned) {
          return project;
        }
        previousPinned = project.pinned === true;
        changed = true;
        if (!pinned) {
          const next = { ...project };
          delete next.pinned;
          return next;
        }
        return { ...project, pinned: true };
      });
      if (!changed) {
        return;
      }
      set({ projects: nextProjects });
      try {
        await window.api.updateWorkspaceMetadata({ workspaceId, pinned });
      } catch {
        set((state) => ({
          projects: state.projects.map((project) => {
            if (
              project.id !== workspaceId ||
              (project.pinned === true) !== pinned
            ) {
              return project;
            }
            if (previousPinned) {
              return { ...project, pinned: true };
            }
            const next = { ...project };
            delete next.pinned;
            return next;
          }),
        }));
        useGitHubStore
          .getState()
          .addToast(pinned ? 'Failed to pin' : 'Failed to unpin', 'error');
      }
    },

    setWorkspaceItemSortMode: async (workspaceId, mode): Promise<void> => {
      const previousProjects = get().projects;
      let previousMode: SidebarSortMode | undefined;
      let changed = false;
      const nextProjects = previousProjects.map((project) => {
        if (project.id !== workspaceId) {
          return project;
        }
        if (resolveSidebarSortMode(project.itemSortMode) === mode) {
          return project;
        }
        previousMode = project.itemSortMode;
        changed = true;
        return { ...project, itemSortMode: mode };
      });
      if (!changed) {
        return;
      }
      set({ projects: nextProjects });
      try {
        await window.api.updateWorkspaceMetadata({
          workspaceId,
          itemSortMode: mode,
        });
      } catch {
        set((state) => ({
          projects: state.projects.map((project) => {
            if (
              project.id !== workspaceId ||
              resolveSidebarSortMode(project.itemSortMode) !== mode
            ) {
              return project;
            }
            if (previousMode !== undefined) {
              return { ...project, itemSortMode: previousMode };
            }
            const next = { ...project };
            delete next.itemSortMode;
            return next;
          }),
        }));
        useGitHubStore.getState().addToast('Failed to change order', 'error');
      }
    },

    setWorktreeBranchGroupingOverride: async (
      projectId,
      worktreeId,
      override,
    ): Promise<void> => {
      const previousProjects = get().projects;
      let changed = false;
      const nextProjects = previousProjects.map((project) => {
        if (project.id !== projectId || project.type === 'cowork') {
          return project;
        }
        const flattenedWorktrees = flattenCurrentWorktreeGrouping(
          project,
          get(),
        );
        return {
          ...project,
          worktrees: flattenedWorktrees.map((worktree) => {
            if (worktree.id !== worktreeId) {
              return worktree;
            }
            const current = worktree.branchGroupingOverride;
            const next = override ?? undefined;
            if (current === next) {
              return worktree;
            }
            changed = true;
            if (next === undefined) {
              const updated = { ...worktree };
              delete updated.branchGroupingOverride;
              return updated;
            }
            return { ...worktree, branchGroupingOverride: next };
          }),
        };
      });
      if (!changed) {
        return;
      }
      set({ projects: nextProjects });
      try {
        const updatedProject = nextProjects.find(
          (project) => project.id === projectId,
        );
        await window.api.setWorktreeBranchGrouping({
          projectId,
          worktreeId,
          override,
          worktreeOrder:
            updatedProject?.type === 'single-repo' ||
            updatedProject?.type === 'multi-repo'
              ? updatedProject.worktrees.map((worktree) => worktree.id)
              : undefined,
        });
        // A background load may have read before this write and replaced the
        // optimistic override while IPC was pending. Reconcile from main after
        // acknowledgement, superseding older in-flight loads before returning.
        await get().loadProjects({ silent: true });
      } catch {
        if (get().projects === nextProjects) {
          set({ projects: previousProjects });
        }
        useGitHubStore
          .getState()
          .addToast('Failed to update branch grouping', 'error', undefined, {
            projectId,
            worktreeId,
          });
      }
    },

    setWorktreeStatus: (projectId, worktreeId, status): void => {
      set((state) => ({
        projects: state.projects.map((project) => {
          if (project.id !== projectId || project.type === 'cowork') {
            return project;
          }
          return {
            ...project,
            worktrees: project.worktrees.map((wt) => {
              if (wt.id !== worktreeId) {
                return wt;
              }

              if (status) {
                return { ...wt, status };
              }

              const nextWorktree = { ...wt };
              delete nextWorktree.status;
              return nextWorktree;
            }),
          };
        }),
      }));
    },

    setAppliedProjectWorktreeScripts: (
      projectId,
      worktreeId,
      loadedSourceScripts,
      sourceScripts,
    ): void => {
      const project = get().projects.find(
        (item): item is SingleRepoSidebarItem =>
          item.type === 'single-repo' && item.id === projectId,
      );
      if (!project) {
        return;
      }

      const effectiveScripts = applySingleRepoWorktreeSourceScripts(
        project.effectiveScripts,
        project.scripts,
        loadedSourceScripts,
        sourceScripts,
      );

      const worktreeKey = createAppliedProjectWorktreeScriptsKey(
        projectId,
        worktreeId,
      );
      set({
        appliedProjectWorktreeScripts: {
          ...get().appliedProjectWorktreeScripts,
          [worktreeKey]: effectiveScripts ?? {},
        },
      });
    },

    setAppliedProjectWorktreeHooks: (
      projectId,
      worktreeId,
      loadedSourceHooks,
      sourceHooks,
    ): void => {
      const project = get().projects.find(
        (item): item is SingleRepoSidebarItem =>
          item.type === 'single-repo' && item.id === projectId,
      );
      if (!project) {
        return;
      }

      const effectiveHooks = applySingleRepoWorktreeSourceHooks(
        project.effectiveHooks,
        project.hooks,
        loadedSourceHooks,
        sourceHooks,
      );

      const hookWorktreeKey = createAppliedProjectWorktreeHooksKey(
        projectId,
        worktreeId,
      );
      set({
        appliedProjectWorktreeHooks: {
          ...get().appliedProjectWorktreeHooks,
          [hookWorktreeKey]: effectiveHooks ?? {},
        },
      });
    },

    subscribeToDiscoveryEvents: () => {
      return window.api.onWorktreeDiscoveryEvent(
        (event: WorktreeDiscoveryEvent) => {
          // Per-tab discoveries (events with chatId) are handled by chatStore.
          if (event.chatId) {
            useChatStore.getState().handleTabDiscoveryEvent(event);
            return;
          }

          const key = createDiffStatsKey(event.projectId, event.worktreeId);

          if (event.discovery === null) {
            // Loading state
            const next = new Set(get().discoveryLoading);
            next.add(key);
            set({ discoveryLoading: next });
            return;
          }

          // Discovery complete — update the worktree and clear loading.
          const { discovery } = event;
          const nextLoading = new Set(get().discoveryLoading);
          nextLoading.delete(key);

          const updatedProjects = get().projects.map((project) => {
            if (project.id !== event.projectId || project.type === 'cowork') {
              return project;
            }
            return {
              ...project,
              worktrees: project.worktrees.map((wt) =>
                wt.id === event.worktreeId ? { ...wt, discovery } : wt,
              ),
            };
          });

          set({ projects: updatedProjects, discoveryLoading: nextLoading });
        },
      );
    },

    subscribeToWorkspaceReferenceRepoEvents: () => {
      return window.api.onWorkspaceReferenceRepoStatus(
        (event: WorkspaceReferenceRepoStatusEvent) => {
          const next = { ...get().workspaceReferenceRepoStatus };
          if (event.status) {
            next[event.workspaceId] = event.status;
          } else {
            delete next[event.workspaceId];
          }
          set({ workspaceReferenceRepoStatus: next });

          if (event.didUpdateReferenceRepo) {
            void get().loadProjects();
          }
        },
      );
    },

    retriggerDiscovery: async (projectId, worktreeId, pluginSelections) => {
      await window.api.discoverWorktreeEnv({
        projectId,
        worktreeId,
        pluginSelections,
      });
    },

    createWorkspace: async (name) => {
      // Main creates and indexes the project in one commit (CAN-3799 D11).
      const result = await window.api.createWorkspace({ name });
      await get().loadProjects();

      return result.id;
    },

    importWorkspaceFromRepo: async (repoPath) => {
      const response = await window.api.importWorkspaceFromRepo({ repoPath });
      await get().loadProjects();

      return response.workspace.id;
    },

    addRepoToWorkspace: async (workspaceId, repoPath, addToSourceControl) => {
      const response = await window.api.addRepoToWorkspace({
        workspaceId,
        repoPath,
        addToSourceControl,
      });

      const projectsWithWorkspaceRepo = get().projects.map((item) => {
        if (item.id !== workspaceId || item.type !== 'multi-repo') {
          return item;
        }

        return {
          ...item,
          repos: [...item.repos, response.repo],
          sourceRepoPath: response.sourceRepoPath ?? item.sourceRepoPath,
        };
      });

      const updatedProjects = normalizeItemOrder(projectsWithWorkspaceRepo);

      set({ projects: updatedProjects });
      await get().saveProjects(updatedProjects);
      await get().refreshWorkspaceDrift(updatedProjects);
    },

    removeRepoFromWorkspace: async (workspaceId, repoId) => {
      await window.api.removeRepoFromWorkspace({ workspaceId, repoId });

      const updatedProjects = get().projects.map((item) => {
        if (item.id !== workspaceId || item.type !== 'multi-repo') return item;

        return {
          ...item,
          repos: item.repos.filter((r) => r.id !== repoId),
        };
      });

      set({ projects: updatedProjects });
      await get().saveProjects(updatedProjects);
      await get().refreshWorkspaceDrift(updatedProjects);
    },

    addRepoToWorktree: async (workspaceId, worktreeId, repoId) => {
      await window.api.addRepoToWorktree({ workspaceId, worktreeId, repoId });
      // Re-validate health immediately after changing repo membership so the
      // sidebar does not wait for the next polling refresh.
      await get().retryWorktreeHealthCheck(workspaceId, worktreeId);
      // Repo mismatch warnings are derived from repoBranches, which come from
      // the diff stats payload. Wait for that snapshot to catch up so the
      // add/remove dialog and row warning clear as soon as the action finishes.
      await get().refreshDiffStats();
    },

    removeRepoFromWorktree: async (workspaceId, worktreeId, repoId) => {
      await window.api.removeRepoFromWorktree({
        workspaceId,
        worktreeId,
        repoId,
      });
      await get().retryWorktreeHealthCheck(workspaceId, worktreeId);
      await get().refreshDiffStats();
    },

    splitTemporaryWorkspaceWorktree: async (
      projectId,
      worktreeId,
      selections,
      rootAction,
      destructiveApprovalToken,
      previewRevision,
    ) => {
      const item = get().projects.find((p) => p.id === projectId);
      if (!item || item.type !== 'multi-repo' || item.temporary !== true) {
        throw new Error(
          'Split project is only available for temporary multi-repo projects',
        );
      }
      const sourceWorktree = item.worktrees.find((wt) => wt.id === worktreeId);

      deselectIfSelectedWorktree(projectId, worktreeId);
      await stopRunningScripts(projectId, worktreeId);
      await stopRunningHooks(projectId, worktreeId);
      // Flush any pending debounced chat persistence so the backend's chat
      // partitioning sees the latest tab state (mirrors the combine flow).
      await useChatStore.getState().flushWorktreeTabs(projectId, worktreeId);

      const snapshot = await beginArchiveUiRemoval(
        projectId,
        worktreeId,
        get,
        set,
      );
      const completionKey = `${projectId}/${worktreeId}`;
      const pendingCompletion: PendingSplitCompletion = {
        createdAt: snapshot.createdAt,
        awaitingFastResponse: true,
      };
      pendingSplitCompletions.set(completionKey, pendingCompletion);
      try {
        // Fast phase only: the backend validates, creates destination
        // workspaces, migrates repo-owned chats/plans, and reserves the split
        // worktrees as git-pending rows, then continues in the background.
        // Warnings and the final outcome arrive on the split-complete event
        // (`handleSplitTemporaryWorkspaceComplete`).
        const response = await window.api.splitTemporaryWorkspace({
          workspaceId: projectId,
          worktreeId,
          selections,
          ...(rootAction ? { rootAction } : {}),
          ...(destructiveApprovalToken ? { destructiveApprovalToken } : {}),
          ...(previewRevision ? { previewRevision } : {}),
        });

        pendingCompletion.awaitingFastResponse = false;
        const bufferedEvent = pendingCompletion.bufferedEvent;
        if (bufferedEvent && !bufferedEvent.success) {
          handleSplitTemporaryWorkspaceComplete(bufferedEvent, get, set);
          throw new Error(bufferedEvent.error ?? 'Failed to split project.');
        }

        finalizeArchiveUiRemoval(snapshot, get);
        // Optimistic landing: inject the reserved git-pending rows straight
        // from the response so the caller can select the destination
        // immediately, and reconcile with the authoritative sidebar reload in
        // the background. Only when the navigation target's workspace is not
        // in renderer state yet (freshly created) does the reload block.
        if (injectReservedSplitWorktrees(response, sourceWorktree, get, set)) {
          void get().loadProjects({ silent: true });
        } else {
          await get().loadProjects({ silent: true });
        }
        set({ worktreeError: null });
        if (bufferedEvent) {
          handleSplitTemporaryWorkspaceComplete(bufferedEvent, get, set);
        }
        return response;
      } catch (error) {
        pendingSplitCompletions.delete(completionKey);
        rollbackArchiveUiRemoval(snapshot, get, set);
        throw error;
      } finally {
        set({
          appliedProjectWorktreeScripts:
            omitAppliedProjectWorktreeScriptsForKey(
              get().appliedProjectWorktreeScripts,
              createAppliedProjectWorktreeScriptsKey(projectId, worktreeId),
            ),
          appliedProjectWorktreeHooks: omitAppliedProjectWorktreeHooksForKey(
            get().appliedProjectWorktreeHooks,
            createAppliedProjectWorktreeHooksKey(projectId, worktreeId),
          ),
        });
      }
    },
  };
});

// Keep the renderer cowork-workspace-id registry (`@/lib/cowork-registry`)
// in sync with the projects store's `projects` state. `cowork.ts` reads
// this registry instead of importing this store directly to avoid an
// import cycle (this store imports `chatStore.ts`, which imports
// `cowork.ts`). Re-registering on every `projects` state change (rather
// than at each of the many `set({ projects: ... })` call sites) keeps this
// a single, easy-to-audit wiring point.
useProjectsStore.subscribe((state, previousState) => {
  if (state.projects === previousState.projects) {
    return;
  }
  registerCoworkWorkspaceIds(
    state.projects
      .filter((project) => project.type === 'cowork')
      .map((project) => project.id),
  );
  // Deleting a project through the discard path skips per-worktree cleanup, and
  // nothing can send from its chats again to clear their Ollama failures.
  const retainedIds = new Set(state.projects.map((project) => project.id));
  for (const project of previousState.projects) {
    if (!retainedIds.has(project.id))
      useOllamaConnectionBannerStore.getState().clearProject(project.id);
  }
});

if (__CANOPY_E2E__) {
  window.__canopyProjectsTestApi = {
    holdNextLoadAfterRead: (): void => {
      if (e2eProjectsLoadBarrier !== null) {
        throw new Error('A projects load is already held for E2E automation.');
      }
      let resolveReached = (): void => undefined;
      let resolveRelease = (): void => undefined;
      let resolveCompleted = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        resolveReached = resolve;
      });
      const release = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      const completed = new Promise<void>((resolve) => {
        resolveCompleted = resolve;
      });
      e2eProjectsLoadBarrier = {
        claimed: false,
        reached,
        resolveReached,
        release,
        resolveRelease,
        completed,
        resolveCompleted,
      };
    },
    loadProjects: async (options): Promise<void> => {
      await useProjectsStore.getState().loadProjects({
        silent: true,
        requireSuccess: options?.requireSuccess === true,
      });
    },
    waitForHeldLoad: async (): Promise<void> => {
      const barrier = e2eProjectsLoadBarrier;
      if (!barrier) {
        throw new Error('No projects load is held for E2E automation.');
      }
      await barrier.reached;
    },
    releaseHeldLoad: async (): Promise<void> => {
      const barrier = e2eProjectsLoadBarrier;
      if (!barrier?.claimed) {
        throw new Error('No projects load has reached the E2E hold point.');
      }
      barrier.resolveRelease();
      await barrier.completed;
    },
  };
}
