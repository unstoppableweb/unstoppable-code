import { ControlButton } from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import {
  foldWorktreeMenuIntoMore,
  getWorktreeDeleteLabels,
  WORKTREE_GROUPING_GLYPHS,
  type WorktreeGroupingActionKind,
  type WorktreeRemovalMode,
} from '@canopy/ui-app';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import type {
  DiffStats,
  RepoBranchInfo,
  WorkspaceDriftSummary,
  WorkspaceRepoData,
  WorktreeDiffStatsStyle,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import {
  isSplitPrEligible,
  shouldShowWorktreeMergedState,
  useGitHubStore,
  worktreeKey,
} from '@/stores/githubStore';
import { useSplitPrGatingPreferences } from '@/hooks/useSplitPrPreferences';
import { deriveSplitPrEligibilityInputs } from '@/lib/splitPrEligibilityInputs';
import { buildSplitRunningStatusLine } from '@/lib/split-progress';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  isScriptRunActive,
  useScriptsStore,
  type ScriptRunState,
} from '@/stores/scriptsStore';
import { useHooksStore, type HookRunState } from '@/stores/hooksStore';
import { useCodeGraphBuildStore } from '@/stores/codeGraphBuildStore';
import { useChatStore } from '@/stores/chatStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useActivityStore } from '@/stores/activityStore';
import { useShallow } from 'zustand/shallow';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  useTerminalActivityStore,
  type TerminalActivityEntry,
} from '@/stores/terminalActivityStore';
import {
  useTerminalStore,
  resolveTerminalRowLabel,
  type KnownTerminalSession,
} from '@/stores/terminalStore';
import type { TerminalGroup } from '@canopy/desktop-shared/types';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import { NEW_WORKTREE_DISPLAY_NAME } from '@canopy/desktop-shared/lib/default-worktree-branch';
import { getTerminalListStateLabel } from '@/lib/terminal-session-state';
import { getScheduledMessagesForWorktree } from '@/lib/worktreeSessionPromptAutomations';
import { type WorktreeUiStatus } from '@/lib/worktree-status';
import { RunSpinner } from '../shared/loading/spinners/RunSpinner';
import { ProjectIcon } from '../shared/ProjectIcon';
import type { DotTone, WorkspaceKind } from '@canopy/ui-shared/components';
import {
  StopLaunchFaces,
  WorktreeIdStopLaunchButton,
} from './WorktreeLaunchStopControl';
import { useWorktreeLaunchStop } from '@/hooks/useWorktreeLaunchStop';
import { getSplitWorkspaceMenuState } from './split-workspace-menu';
import {
  WorktreeBranchInfoDialog,
  type WorktreeBranchInfoDialogPendingRename,
} from './WorktreeBranchInfoDialog';
import {
  canShowStandaloneDeleteButton,
  getDeleteAction,
  isWorktreeFresh,
} from './worktree-delete-action';
import {
  WorktreeRemovalConfirmDialog,
  type WorktreeArchiveConfirmationTarget,
} from './WorktreeRemovalConfirmDialog';
import { resolveArchiveRetentionDays } from '@canopy/desktop-shared/lib/archive-retention';
import {
  WorktreeRow as SharedWorktreeRow,
  WorktreeRowActionChip,
  RailIconButton,
  DiffStatsBadge,
  type WorktreePipelineStatus as SharedWorktreePipelineStatus,
  type WorktreeTerminalStatus as SharedWorktreeTerminalStatus,
  type WorktreeScriptStatus as SharedWorktreeScriptStatus,
  type WorktreeHookStatus as SharedWorktreeHookStatus,
  type WorktreeGraphBuildStatus as SharedWorktreeGraphBuildStatus,
  type WorktreeRowPrStatus,
  type WorktreeSetupPhase as SharedWorktreeSetupPhase,
  type WorktreeRowDepthBadge,
  ChatPreviewPopover,
  PipelineStatusPopover,
  PIPELINE_POPOVER_HIDE_DELAY_MS,
  TerminalStatusPopover,
  RunBadgePopover,
  ActionMenuRowStyle,
  FloatingMenu,
  FloatingMenuPointAnchor,
  FLOATING_MENU_GAP,
  type FloatingMenuPlacement,
  WorktreeActionMenuItems,
  type WorktreeMenuItem,
  type PipelineStatusPopoverEntry,
  type TerminalPopoverRow,
  type RunBadgeRow,
  type ChatPreviewRow,
} from '@canopy/ui-shared/components';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import { useSuspendSidebarHovers } from '@/hooks/useSuspendSidebarHovers';
import {
  ArchiveBoxIcon,
  ArchiveIcon,
  BranchIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  LabelIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinFilledIcon,
  PinIcon,
  PipelineIcon,
  RocketLaunchIcon,
  TemporaryMultiRepoIcon,
  SplitIcon,
  ShareIcon,
  SplitPrIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import { useSplitPrReadiness } from '@/hooks/useSplitPrReadiness';
import { useSharedContainerEntryPointVisible } from '@/hooks/useSharedContainerEntryPointVisible';
import { subscribeToSharedContainerInviteRequests } from '@/lib/sharedContainerInviteEvents';
import {
  sharedWorktreeKey,
  useSharedContainersStore,
} from '@/stores/sharedContainersStore';
import { InviteTeammateModal } from '@/components/shared/InviteTeammateModal';
import { SPLIT_PR_BLOCKER_COPY } from '@/lib/splitPrEligibilityInputs';
import { useCanopyDesktopPrSplitEnabled } from '@/hooks/useCanopyDesktopPrSplitEnabled';
import {
  buildIdleWatcherChatRows,
  hasIdleWatcherChat,
} from './idle-watcher-chats';
import { deriveWorktreeSplitRowStatus } from './worktreeSplitRowStatus';
import { deriveDesktopPrBadgeStatus } from './worktreePrBadge';
import {
  WorktreePrCreatingIndicator,
  WorktreePrMergingIndicator,
} from './WorktreePrProgressIndicators';
import {
  buildChatPreviewRows,
  buildHookRunBadgeRows,
  buildScheduledMessagePreviewRows,
  buildScriptRunBadgeRows,
  buildToolApprovalPreviewRows,
} from './worktreeRowPreviewRows';
import {
  CONTEXT_MENU_POINTER_OFFSET,
  Tooltip,
  useContextMenuPlacement,
} from '@canopy/ui-shared';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { worktreeRecencyMs } from '@/lib/sidebar-ordering';

// Stable references for terminal-label-source fallbacks. Returning fresh `{}`
// or `[]` literals from a useShallow selector causes its inner Object.is
// comparison to mark the snapshot as changed on every call, which trips
// React's `getSnapshot should be cached` guard and triggers an infinite
// update loop on worktrees that have not yet hydrated their terminal bucket.
const EMPTY_GROUP_ORDINALS: Record<string, number> = {};
const EMPTY_GROUPS: TerminalGroup[] = [];
const EMPTY_SESSIONS: Record<string, KnownTerminalSession> = {};
// Stable empty reference so the active-script-runs selector never returns a
// fresh `[]` literal (which would trip React's cached-snapshot guard the same
// way the terminal selectors above can).
const EMPTY_SCRIPT_RUNS: ScriptRunState[] = [];
// Stable empty reference for the active-hook-runs selector, same rationale as
// EMPTY_SCRIPT_RUNS above.
const EMPTY_HOOK_RUNS: HookRunState[] = [];

/** The project header's glyph kind, for the row's preview card. */
function previewProjectKind(type: string | undefined): WorkspaceKind {
  if (type === 'cowork') return 'cowork';
  return type === 'multi-repo' ? 'multi-repo' : 'single-repo';
}

interface AddRepoMenuItemInput {
  hasActiveSession: boolean;
  isDone: boolean;
  isPendingGitSetup: boolean;
  isRunningSetup: boolean;
  onAddRepoToWorktreeAdhoc: () => void;
}

/** The Add project row of the worktree "…" menu. */
function addRepoMenuItem({
  hasActiveSession,
  isDone,
  isPendingGitSetup,
  isRunningSetup,
  onAddRepoToWorktreeAdhoc,
}: AddRepoMenuItemInput): WorktreeMenuItem {
  return {
    key: 'add-repository',
    label: 'Add project',
    icon: <TemporaryMultiRepoIcon />,
    disabled: isDone || hasActiveSession || isPendingGitSetup || isRunningSetup,
    tooltip: hasActiveSession
      ? 'Stop active sessions before adding a repo'
      : isDone
        ? 'Done worktrees cannot add repos'
        : isPendingGitSetup || isRunningSetup
          ? 'Wait for setup to finish before adding a repo'
          : undefined,
    onSelect: onAddRepoToWorktreeAdhoc,
    testId: 'worktree-actions-menu-add-repo',
  };
}

/** One menu row rendered on its own, closing the menu before it runs. */
function SingleActionMenuRow({
  item,
  onClose,
}: {
  item: WorktreeMenuItem;
  onClose: () => void;
}): JSX.Element {
  return (
    <ActionMenuRowStyle>
      <WorktreeActionMenuItems
        items={[item]}
        onSelect={(selected): void => {
          if (selected.disabled || !selected.onSelect) return;
          onClose();
          selected.onSelect();
        }}
      />
    </ActionMenuRowStyle>
  );
}

/**
 * Action-menu row for the adhoc multi-repo combine entry. Disabled when the
 * source worktree has active sessions or is still running its setup phase;
 * the disabled title differs between the two so the user knows what to do
 * next. Exported so tests can render the row directly — the action menu is
 * portalled and gated by component state, which makes SSR snapshots of the
 * surrounding `WorktreeItem` insufficient for asserting menu-item behavior.
 */
export function AddRepoMenuItem({
  onClose,
  ...input
}: AddRepoMenuItemInput & { onClose: () => void }): JSX.Element {
  return (
    <SingleActionMenuRow item={addRepoMenuItem(input)} onClose={onClose} />
  );
}

/**
 * Action-menu row for splitting a temporary multi-repo workspace worktree
 * back into per-repo single-repo worktrees. Only rendered when the owning
 * workspace is a temporary multi-repo workspace (the hosts gate the callback
 * prop). A split moves checkouts and tears the source down, so — mirroring
 * the Split PR launch gating and its `SPLIT_PR_BLOCKER_COPY` wording —
 * active agent chats and active (running or paused) pipelines block it, as
 * do done worktrees and in-flight setup. Exported for the same
 * portalled-menu testability reason as {@link AddRepoMenuItem}.
 */
interface SplitWorkspaceMenuItemInput {
  hasActiveSession: boolean;
  hasActivePipelines: boolean;
  isDone: boolean;
  isPendingGitSetup: boolean;
  isRunningSetup: boolean;
  onSplitWorkspace: () => void;
}

/** The Split project row of the worktree "…" menu. */
function splitWorkspaceMenuItem({
  onSplitWorkspace,
  ...state
}: SplitWorkspaceMenuItemInput): WorktreeMenuItem {
  const { disabled, tooltip } = getSplitWorkspaceMenuState(state);
  return {
    key: 'split-workspace',
    label: 'Split project',
    icon: <SplitIcon />,
    disabled,
    tooltip,
    onSelect: onSplitWorkspace,
    testId: 'worktree-actions-menu-split-workspace',
  };
}

export function SplitWorkspaceMenuItem({
  onClose,
  ...input
}: SplitWorkspaceMenuItemInput & { onClose: () => void }): JSX.Element {
  return (
    <SingleActionMenuRow
      item={splitWorkspaceMenuItem(input)}
      onClose={onClose}
    />
  );
}

/** Hover card for a blocked Split PR row: its title, then one line per reason. */
function SplitPrBlockedTooltip({
  reasons,
}: {
  reasons: readonly string[];
}): JSX.Element {
  return (
    <span className="flex flex-col items-center text-center">
      <span className="text-2xs font-medium leading-tight fg-primary">
        Split PR
      </span>
      {reasons.map((reason) => (
        <span
          key={reason}
          className="mt-0.5 text-3xs leading-snug fg-secondary"
        >
          {reason}
        </span>
      ))}
    </span>
  );
}

export type WorktreePipelineStatus =
  | 'running'
  | 'unseen'
  | 'unseen-failure'
  | 'paused';

export type WorktreeTerminalStatus = 'running' | 'unseen' | 'unseen-failure';

function WorktreeIdRunSpinner({
  className = '',
}: {
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`inline-flex h-3 w-3 shrink-0 items-center justify-center ${className}`}
    >
      <RunSpinner />
    </span>
  );
}

/**
 * Fully-described branch-grouping context-menu item. The host (`ProjectSection`)
 * computes the label and bakes the action (group/ungroup a single worktree, or
 * group/ungroup all children of a parent) into `onSelect`.
 */
export interface BranchGroupingMenuDescriptor {
  label: string;
  kind: WorktreeGroupingActionKind;
  testId: string;
  onSelect: () => void | Promise<void>;
}

interface WorktreeItemProps {
  worktreeDiffStatsStyle?: WorktreeDiffStatsStyle;
  worktree: WorktreeData;
  projectId: string;
  stats?: DiffStats;
  hasUncommittedChanges?: boolean;
  hasCommitsAhead?: boolean;
  hasUnpushedCommits?: boolean;
  isSelected: boolean;
  isStreaming: boolean;
  /** Live background tasks: the background spinner while nothing streams. */
  backgroundTasks?: number;
  hasActiveSession: boolean;
  awaitingApproval: boolean;
  /** True when an interactive agent question is waiting for an answer. */
  hasPendingQuestion?: boolean;
  /** True when a Canopy tool-approval prompt is blocking a chat here. */
  hasPendingToolApproval?: boolean;
  hasUnread: boolean;
  isDiscovering: boolean;
  isRunningSetup: boolean;
  isRunningRun: boolean;
  isTearingDown: boolean;
  isArchiveInProgress?: boolean;
  pipelineStatus?: WorktreePipelineStatus;
  terminalStatus?: WorktreeTerminalStatus;
  isMultiRepo?: boolean;
  driftSummary?: WorkspaceDriftSummary;
  repoBranches?: RepoBranchInfo[];
  configRepos?: WorkspaceRepoData[];
  hasRemoteTracking?: boolean;
  hasBranchBeenPushed?: boolean;
  onSelect: (projectId: string, worktreeId: string) => void;
  onArchive: (
    worktreeId: string,
    options?: {
      deleteBranch?: boolean;
      expectedBranchName?: string;
      lockAfterArchive?: boolean;
      deleteWithoutRetentionIfMissing?: boolean;
    },
  ) => void;
  onOpenDriftDetails?: (projectId: string, worktreeId: string) => void;
  onAddRepoToWorktree?: (
    worktreeId: string,
    repoId: string,
  ) => void | Promise<void>;
  onRemoveRepoFromWorktree?: (
    worktreeId: string,
    repoId: string,
  ) => void | Promise<void>;
  onCreateBranchWorktree?: (worktreeId: string) => void;
  onDispatchPipeline?: (worktreeId: string) => void;
  onLaunch?: () => void;
  /** The row's actions menu opened, so the host can refresh what it offers. */
  onActionsMenuOpen?: () => void;
  isLaunchActive?: boolean;
  /**
   * Open the Add Repo modal that lets the user combine this worktree with
   * another workspace into an adhoc multi-repo destination worktree. Driven
   * by `WorktreeManager` and forwarded through `WorktreeItemAdapter`.
   */
  onAddRepoToWorktreeAdhoc?: (worktreeId: string) => void;
  /**
   * Open the Split Workspace modal that dissolves this temporary multi-repo
   * workspace worktree back into per-repo single-repo worktrees. Only wired
   * (via `WorktreeItemAdapter`) when the owning workspace is a temporary
   * multi-repo workspace.
   */
  onSplitWorkspace?: (worktreeId: string) => void;
  onToggleHidden?: (worktreeId: string, nextHidden: boolean) => void;
  /**
   * Branch-grouping context-menu item. Present only when grouping is meaningful
   * for this worktree (it has an eligible base-branch parent, or it is a parent
   * of other worktrees). Fully describes the menu label and action.
   */
  branchGroupingMenu?: BranchGroupingMenuDescriptor;
  baseBranch?: string | null;
  baseBranchExistsLocally?: boolean;
  baseBranchExistsInRemote?: boolean;
  /**
   * Resolved UI status for the worktree (idle/planning/working/unread/done).
   * Drives the dot color in list view and grouping in kanban view. Computed
   * once per render in `WorktreeManager` and threaded through `ProjectSection`
   * and `WorktreeKanbanBoard` so both views stay in sync.
   */
  uiStatus?: WorktreeUiStatus;
  /**
   * `'list'` (default) renders the original sidebar row with hover-revealed
   * actions and per-project drag-to-reorder. `'kanban'` disables sortable
   * drag, keeps action buttons visible by default, and shows the diff badge
   * inline (no fade-out on hover).
   */
  displayMode?: 'list' | 'kanban';
  /** Depth badge for this worktree, computed from base-branch ancestry. */
  depthBadge?: WorktreeRowDepthBadge;
  /** Indent row content while preserving the full-width row surface. */
  nested?: boolean;
  /** Branch-ancestry depth when rendered as a nested child. */
  nestedChildDepth?: number;
  /**
   * Keeps an in-flow copy selectable while removing every drag binding. Used
   * for the selected row rendered under a collapsed workspace header, which
   * lives outside the worktree DndContext and therefore must not register
   * with the surrounding workspace DndContext.
   */
  disableSortable?: boolean;
  /**
   * Renders this row as a pinned selected-item copy (sticky band / bottom
   * pin surface). The copy is never a drag source or sortable registration,
   * and carries its own automation id so flow selectors stay unique.
   */
  pinnedCopy?: boolean;
  /** Pin surface used to keep descendant automation ids globally unique. */
  pinnedSurface?: 'pin-top' | 'pin-bottom';
}

type WorktreeItemSortable = ReturnType<typeof useSortable>;

interface WorktreeItemContentProps extends WorktreeItemProps {
  sortable: WorktreeItemSortable | null;
}

function SortableWorktreeItem(props: WorktreeItemProps): JSX.Element {
  const sortable = useSortable({ id: props.worktree.id });
  return <WorktreeItemContent {...props} sortable={sortable} />;
}

export function WorktreeItem(props: WorktreeItemProps): JSX.Element {
  const sortableDisabled =
    props.disableSortable === true ||
    props.pinnedCopy === true ||
    (props.displayMode ?? 'list') !== 'list' ||
    props.worktree.hidden === true;

  if (sortableDisabled) {
    return <WorktreeItemContent {...props} sortable={null} />;
  }
  return <SortableWorktreeItem {...props} />;
}

function WorktreeItemContent({
  worktree,
  worktreeDiffStatsStyle = 'short',
  projectId,
  stats,
  hasUncommittedChanges,
  hasCommitsAhead,
  hasUnpushedCommits,
  isSelected,
  isStreaming,
  backgroundTasks = 0,
  hasActiveSession,
  awaitingApproval,
  hasPendingQuestion = false,
  hasPendingToolApproval = false,
  hasUnread,
  isDiscovering,
  isRunningSetup,
  isRunningRun,
  isTearingDown,
  isArchiveInProgress = false,
  pipelineStatus,
  terminalStatus,
  isMultiRepo,
  repoBranches,
  configRepos,
  hasBranchBeenPushed,
  onSelect,
  onArchive,
  onAddRepoToWorktree,
  onRemoveRepoFromWorktree,
  onCreateBranchWorktree,
  onDispatchPipeline,
  onLaunch,
  onActionsMenuOpen,
  isLaunchActive = false,
  onAddRepoToWorktreeAdhoc,
  onSplitWorkspace,
  onToggleHidden,
  branchGroupingMenu,
  baseBranch: baseBranchProp,
  baseBranchExistsLocally,
  baseBranchExistsInRemote,
  uiStatus = 'idle',
  displayMode = 'list',
  depthBadge,
  nested = false,
  nestedChildDepth,
  pinnedCopy = false,
  pinnedSurface,
  sortable,
}: WorktreeItemContentProps): JSX.Element {
  const automationId = (base: string): string =>
    pinnedSurface ? `${base}-${pinnedSurface}` : base;
  const sortableDisabled = sortable === null;
  const listeners = sortable?.listeners;
  const setNodeRef = sortable?.setNodeRef;
  const transform = sortable?.transform ?? null;
  const transition = sortable?.transition;
  const isDragging = sortable?.isDragging ?? false;

  const setWorktreePinned = useProjectsStore(
    (state) => state.setWorktreePinned,
  );

  const prStatus = useGitHubStore(
    (state) => state.prStatuses[`${projectId}/${worktree.id}`],
  );
  const isDone = worktree.status === 'done';
  const effectivePrStatus =
    prStatus === undefined ? worktree.lastKnownPrStatus : prStatus;
  const isMergedViaPr = shouldShowWorktreeMergedState(
    worktree.status,
    effectivePrStatus,
  );
  const doneLabel = isMergedViaPr ? 'PR merged' : 'Done';
  const hasLineChanges =
    stats !== undefined && stats.insertions + stats.deletions > 0;
  const diffStatsForRow =
    stats !== undefined
      ? { insertions: stats.insertions, deletions: stats.deletions }
      : undefined;
  const hasLocalBranchChanges =
    hasCommitsAhead === true || hasUnpushedCommits === true;
  const hasLocalWork =
    hasUncommittedChanges === true || hasLineChanges || hasLocalBranchChanges;

  // Split PR menu gating — identical strict check to the PR activity panel,
  // shared via `deriveSplitPrEligibilityInputs`: feature toggle on,
  // single-repo workspace, open PR, and the line-count threshold met
  // (preferring the PR's own additions/deletions). `effectivePrStatus` (with
  // its `lastKnownPrStatus` fallback) and this row's own diff stats are
  // pre-sourced here since they come from a different reactive path than the
  // PR panel; the `!isDone` gate stays local since the shared helper is
  // eligibility-only and doesn't know about worktree lifecycle status.
  const { splitPrEnabled, splitPrThresholdLines } =
    useSplitPrGatingPreferences();
  const canopyDesktopPrSplitEnabled = useCanopyDesktopPrSplitEnabled();
  const canSplitPr =
    canopyDesktopPrSplitEnabled &&
    !isDone &&
    isSplitPrEligible(
      deriveSplitPrEligibilityInputs({
        prStatus: effectivePrStatus,
        diffStats: diffStatsForRow,
        splitPrEnabled,
        thresholdLines: splitPrThresholdLines,
        isSingleRepo: isMultiRepo === false,
      }),
    );
  // Blocker-only readiness (uncommitted changes / unpushed commits / merge
  // conflicts / active pipelines / active chats) for the same worktree, used
  // to render the menu item disabled-with-tooltip instead of hiding it once
  // `canSplitPr` (threshold/toggle/open-PR/single-repo) is already true.
  const splitPrReadiness = useSplitPrReadiness(
    projectId,
    worktree.id,
    isMultiRepo === false,
  );
  // Mirrored split lock for this row (from main via `splitLockedWorktrees`).
  // While locked, the row must pre-gate its Split PR launcher (a second launch
  // would double-acquire) and disable Delete (removing the checkout
  // mid-split would strand the split map + branches; the main-side
  // `assertNotSplitLocked` archive guard is the authority, this just mirrors it
  // in the UI).
  const splitLocked = useGitHubStore((state) =>
    state.splitLockedWorktrees.has(worktreeKey(projectId, worktree.id)),
  );
  // The renderer presentation session outlives the main-process lock: it stays
  // open after a completed split settles so the finished page can render. The
  // split row badge keys on `locked || session` for presence, then mirrors the
  // SplitWorkflowView's own step derivation to pick the color: planning/carving
  // → active (pulsing blue); a proposed plan awaiting approval → review, or a
  // completed map → done (both the unread amber "needs attention" color).
  const splitWorkflowSessionOpen = useGitHubStore((state) =>
    state.splitWorkflowSessions.has(worktreeKey(projectId, worktree.id)),
  );
  const isPlanningSplit = useGitHubStore((state) =>
    state.planningSplitPr.has(worktreeKey(projectId, worktree.id)),
  );
  const isSplitting = useGitHubStore((state) =>
    state.splittingPr.has(worktreeKey(projectId, worktree.id)),
  );
  const splitPlanPresent = useGitHubStore(
    (state) =>
      state.splitPrPlans[worktreeKey(projectId, worktree.id)] !== undefined,
  );
  const splitCompleted = useGitHubStore(
    (state) =>
      state.splitPrResults[worktreeKey(projectId, worktree.id)]?.status ===
      'completed',
  );
  // The most recent in-flight phase label ("Carving child branch (2/4)") for
  // the badge tooltip's status line. Selecting the derived string (not the
  // event array) keeps the row from re-rendering on same-phase updates.
  const splitRunningLine = useGitHubStore((state) =>
    buildSplitRunningStatusLine(
      state.splitPrProgress[worktreeKey(projectId, worktree.id)] ?? [],
    ),
  );
  const isPendingGitSetup = worktree.setupPhase === 'git-pending';
  const [showConfirm, setShowConfirm] = useState(false);
  const [archiveConfirmationTarget, setArchiveConfirmationTarget] =
    useState<WorktreeArchiveConfirmationTarget | null>(null);
  // Which retained state the pending removal confirmation lands in: Delete
  // (kept for the retention window) or Archive (kept until deleted).
  const [removalMode, setRemovalMode] = useState<WorktreeRemovalMode>('delete');
  const [showBranchesModal, setShowBranchesModal] = useState(false);
  const [showInviteTeammateModal, setShowInviteTeammateModal] = useState(false);
  const sharedContainerInviteVisible = useSharedContainerEntryPointVisible();
  // Scalar selector: a boolean, never a fresh object, so a long sidebar list
  // does not re-render on unrelated shared-container store updates.
  const isSharedWithTeammates = useSharedContainersStore((s) =>
    Boolean(s.sharedWorktrees[sharedWorktreeKey(projectId, worktree.id)]),
  );
  useEffect(() => {
    if (pinnedCopy || !sharedContainerInviteVisible) return;
    const matchesThisRow = (request: {
      projectId: string;
      worktreeId: string;
      containerType: string;
    }): boolean =>
      request.projectId === projectId &&
      request.worktreeId === worktree.id &&
      request.containerType === 'CODE_WORKTREE';
    return subscribeToSharedContainerInviteRequests(
      (request) => {
        if (!matchesThisRow(request)) return false;
        setShowInviteTeammateModal(true);
        return true;
      },
      (request) => {
        if (!matchesThisRow(request)) setShowInviteTeammateModal(false);
      },
    );
  }, [pinnedCopy, projectId, sharedContainerInviteVisible, worktree.id]);
  const [pendingBranchInfoRename, setPendingBranchInfoRename] =
    useState<WorktreeBranchInfoDialogPendingRename | null>(null);
  const [pendingBranchInfoLabelEdit, setPendingBranchInfoLabelEdit] =
    useState(false);

  // Pipeline popover hover state
  const [pipelineHoverRect, setPipelineHoverRect] = useState<DOMRect | null>(
    null,
  );
  const wtKey = `${projectId}/${worktree.id}`;

  // Plan-explore chats finishing while their modal is closed mark a dedicated
  // plan-scoped tab unread. Surface that on this worktree's unread indicator by
  // checking the explore scope of each of its tracked plans. The selectors
  // return primitives/stable arrays so streaming tokens never re-render the row.
  const trackedPlanIds = useActivityStore(
    useShallow((state) =>
      (state.trackedPlans[wtKey] ?? []).map((plan) => plan.id),
    ),
  );
  const hasUnreadPlanChat = useChatSidebarStore((state) =>
    trackedPlanIds.some((planId) => {
      const wc = state.worktrees[`${PLAN_EXPLORE_CHAT_PROJECT_ID}/${planId}`];
      return wc ? wc.tabs.some((tab) => tab.unread === true) : false;
    }),
  );
  const effectiveHasUnread = hasUnread || hasUnreadPlanChat;

  const worktreeWatchers = useAppAdvisorWatchersStore(
    useShallow((state) =>
      state.watchers.filter(
        (watcher) =>
          watcher.destination.projectId === projectId &&
          watcher.destination.worktreeId === worktree.id &&
          watcher.status === 'active',
      ),
    ),
  );
  const hasIdleWatcherChats = useChatSidebarStore((state) =>
    hasIdleWatcherChat({
      projectId,
      worktreeId: worktree.id,
      tabs: state.worktrees[wtKey]?.tabs,
      watchers: worktreeWatchers,
    }),
  );

  const automationActivities = useAutomationsStore((state) => state.activities);
  const scheduledMessages = useMemo(
    () =>
      getScheduledMessagesForWorktree({
        activities: automationActivities,
        workspaceId: projectId,
        worktreeId: worktree.id,
      }),
    [automationActivities, projectId, worktree.id],
  );
  const hasScheduledMessages = scheduledMessages.length > 0;
  const scheduledMessageRows = useMemo<ChatPreviewRow[]>(
    () =>
      buildScheduledMessagePreviewRows({
        wtKey,
        messages: scheduledMessages,
      }),
    [scheduledMessages, wtKey],
  );
  const pipelineSummaries: PipelineStatusPopoverEntry[] | undefined =
    usePipelineRunsStore((state) => state.pipelineSummariesByWorktree[wtKey]);
  const {
    launchScriptKey,
    isLaunchStopping,
    stopLaunch: handleStopLaunch,
  } = useWorktreeLaunchStop(projectId, worktree.id);
  // Script (rocket) popover hover state. Shows whichever setup/launch/teardown/
  // run scripts are currently active for this worktree, mirroring the terminal
  // and pipeline badges.
  const [scriptHoverRect, setScriptHoverRect] = useState<DOMRect | null>(null);
  const activeScriptRuns = useScriptsStore(
    useShallow((state): ScriptRunState[] => {
      const runs = state.runs[wtKey];
      if (!runs) return EMPTY_SCRIPT_RUNS;
      const active = Object.values(runs).filter((run) =>
        isScriptRunActive(run.status),
      );
      return active.length > 0 ? active : EMPTY_SCRIPT_RUNS;
    }),
  );
  const hasRunningScript = activeScriptRuns.length > 0;
  // Live "graph building" indicator — lit for the whole time a code-graph
  // build is in flight for this worktree, whether triggered by the
  // worktree-create scheduler or an agent-invoked BuildOrUpdateCodeGraph.
  // No selection/loaded-worktree gate: the badge must render for any row.
  const isBuildingCodeGraph = useCodeGraphBuildStore(
    (state) => state.building[wtKey] === true,
  );
  const scriptPopoverRows = useMemo<RunBadgeRow[]>(
    () => buildScriptRunBadgeRows(activeScriptRuns),
    [activeScriptRuns],
  );
  const showScriptPopover = useCallback((element: HTMLElement): void => {
    setScriptHoverRect(element.getBoundingClientRect());
  }, []);
  const hideScriptPopover = useCallback((): void => {
    setScriptHoverRect(null);
  }, []);
  const handleScriptIconMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      showScriptPopover(event.currentTarget);
    },
    [showScriptPopover],
  );
  const handleScriptIconFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      showScriptPopover(event.currentTarget);
    },
    [showScriptPopover],
  );
  const handleScriptIconKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== 'Escape') return;
      hideScriptPopover();
      event.currentTarget.blur();
    },
    [hideScriptPopover],
  );

  // Hook (link icon) popover hover state. Shows whichever hook executions are
  // currently running for this worktree, mirroring the script badge.
  const [hookHoverRect, setHookHoverRect] = useState<DOMRect | null>(null);
  const activeHookRuns = useHooksStore(
    useShallow((state): HookRunState[] => {
      const runs = state.runs[wtKey];
      if (!runs) return EMPTY_HOOK_RUNS;
      const active = Object.values(runs).filter(
        (run) => run.status === 'running',
      );
      return active.length > 0 ? active : EMPTY_HOOK_RUNS;
    }),
  );
  const hasRunningHook = activeHookRuns.length > 0;
  const hookPopoverRows = useMemo<RunBadgeRow[]>(
    () => buildHookRunBadgeRows(activeHookRuns),
    [activeHookRuns],
  );
  const showHookPopover = useCallback((element: HTMLElement): void => {
    setHookHoverRect(element.getBoundingClientRect());
  }, []);
  const hideHookPopover = useCallback((): void => {
    setHookHoverRect(null);
  }, []);
  const handleHookIconMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      showHookPopover(event.currentTarget);
    },
    [showHookPopover],
  );
  const handleHookIconFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      showHookPopover(event.currentTarget);
    },
    [showHookPopover],
  );
  const handleHookIconKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== 'Escape') return;
      hideHookPopover();
      event.currentTarget.blur();
    },
    [hideHookPopover],
  );

  // A long entry list turns the pipeline popover into a scroll region, so
  // leaving the badge cannot close it instantly — the pointer needs a moment
  // to cross the gap into the list, which then cancels the pending hide.
  const pipelineHideTimerRef = useRef<number | null>(null);
  const pipelineFocusWithinRef = useRef(false);
  const pipelineBadgeRef = useRef<HTMLElement | null>(null);
  const suppressNextPipelineFocusRef = useRef(false);
  const pipelinePendingListFocusRef = useRef(false);
  const pipelinePopoverListId = useId();
  const cancelPipelinePopoverHide = useCallback((): void => {
    if (pipelineHideTimerRef.current !== null) {
      window.clearTimeout(pipelineHideTimerRef.current);
      pipelineHideTimerRef.current = null;
    }
  }, []);
  const showPipelinePopover = useCallback(
    (element: HTMLElement): void => {
      pipelineBadgeRef.current = element;
      cancelPipelinePopoverHide();
      setPipelineHoverRect(element.getBoundingClientRect());
    },
    [cancelPipelinePopoverHide],
  );
  const hidePipelinePopover = useCallback((): void => {
    pipelinePendingListFocusRef.current = false;
    cancelPipelinePopoverHide();
    setPipelineHoverRect(null);
  }, [cancelPipelinePopoverHide]);
  const schedulePipelinePopoverHide = useCallback((): void => {
    cancelPipelinePopoverHide();
    pipelineHideTimerRef.current = window.setTimeout((): void => {
      pipelineHideTimerRef.current = null;
      if (pipelineFocusWithinRef.current) return;
      pipelinePendingListFocusRef.current = false;
      setPipelineHoverRect(null);
    }, PIPELINE_POPOVER_HIDE_DELAY_MS);
  }, [cancelPipelinePopoverHide]);
  useEffect(
    (): (() => void) => cancelPipelinePopoverHide,
    [cancelPipelinePopoverHide],
  );
  const handlePipelineIconMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      showPipelinePopover(event.currentTarget);
    },
    [showPipelinePopover],
  );
  const handlePipelineIconFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      if (suppressNextPipelineFocusRef.current) {
        suppressNextPipelineFocusRef.current = false;
        return;
      }
      pipelineFocusWithinRef.current = true;
      showPipelinePopover(event.currentTarget);
    },
    [showPipelinePopover],
  );
  const handlePipelineIconBlur = useCallback((): void => {
    pipelineFocusWithinRef.current = false;
    schedulePipelinePopoverHide();
  }, [schedulePipelinePopoverHide]);
  const handlePipelineIconClick = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      if (event.detail !== 0) return;
      event.stopPropagation();
      if (pipelineHoverRect) {
        pipelineFocusWithinRef.current = false;
        hidePipelinePopover();
      } else {
        pipelineFocusWithinRef.current = true;
        showPipelinePopover(event.currentTarget);
      }
    },
    [hidePipelinePopover, pipelineHoverRect, showPipelinePopover],
  );
  const handlePipelineIconKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key === 'ArrowDown') {
        const list = document.getElementById(pipelinePopoverListId);
        if (list instanceof HTMLElement && list.tabIndex >= 0) {
          event.preventDefault();
          list.focus();
        } else {
          event.preventDefault();
          pipelinePendingListFocusRef.current = true;
          showPipelinePopover(event.currentTarget);
        }
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (pipelineHoverRect) {
          pipelineFocusWithinRef.current = false;
          hidePipelinePopover();
        } else {
          pipelineFocusWithinRef.current = true;
          showPipelinePopover(event.currentTarget);
        }
        return;
      }
      if (event.key === 'Escape') {
        pipelineFocusWithinRef.current = false;
        hidePipelinePopover();
        event.currentTarget.blur();
      }
    },
    [
      hidePipelinePopover,
      pipelineHoverRect,
      pipelinePopoverListId,
      showPipelinePopover,
    ],
  );
  const handlePipelineListDismiss = useCallback((): void => {
    pipelineFocusWithinRef.current = false;
    hidePipelinePopover();
    const badge = pipelineBadgeRef.current;
    if (badge) {
      suppressNextPipelineFocusRef.current = true;
      badge.focus();
    }
  }, [hidePipelinePopover]);
  const handlePipelineListReady = useCallback((list: HTMLElement): void => {
    if (!pipelinePendingListFocusRef.current) return;
    pipelinePendingListFocusRef.current = false;
    list.focus();
  }, []);

  // Terminal popover hover state
  const [terminalHoverRect, setTerminalHoverRect] = useState<DOMRect | null>(
    null,
  );

  // Terminal indicator data (entries are pruned after the worktree is selected,
  // so an empty bucket is a real possibility for short-lived popover content).
  const terminalEntries = useTerminalActivityStore(
    useShallow((state) => {
      const bucket = state.entriesByWorktree[wtKey];
      return bucket ? Object.values(bucket) : [];
    }),
  );

  // Read label sources from useTerminalStore so renames stay in sync without
  // bookkeeping in the activity store. The shallow selector + useMemo
  // resolution keeps the row computation cheap and stable.
  const terminalLabelSources = useTerminalStore(
    useShallow((state) => {
      const bucket = state.worktrees[wtKey];
      return {
        terminalCustomNames: state.terminalCustomNames,
        groupCustomNames: state.groupCustomNames,
        groupOrdinals: bucket?.groupOrdinals ?? EMPTY_GROUP_ORDINALS,
        groups: bucket?.groups ?? EMPTY_GROUPS,
        sessions: bucket?.sessions ?? EMPTY_SESSIONS,
      };
    }),
  );

  const terminalPopoverRows = useMemo<TerminalPopoverRow[]>(() => {
    return terminalEntries
      .map((entry: TerminalActivityEntry): TerminalPopoverRow => {
        const label = resolveTerminalRowLabel(
          entry.terminalId,
          entry.groupId,
          terminalLabelSources,
        );

        let statusText: string;
        let statusClass: string;
        let dotTone: DotTone;
        if (entry.running) {
          statusText = entry.processName ?? 'running';
          statusClass = OPERATIONAL_STATUS_COLORS.active.foreground;
          dotTone = 'working';
        } else if (entry.exitCode !== null || entry.signal !== null) {
          const session = terminalLabelSources.sessions[entry.terminalId];
          const labelFromSession = session
            ? getTerminalListStateLabel(session)
            : null;
          statusText =
            labelFromSession ??
            (entry.signal !== null
              ? entry.signal.toLowerCase()
              : entry.exitCode !== null
                ? `exit ${String(entry.exitCode)}`
                : 'closed');
          const isFailure =
            (entry.exitCode !== null && entry.exitCode > 0) ||
            entry.signal !== null;
          statusClass = isFailure
            ? OPERATIONAL_STATUS_COLORS.failed.foreground
            : OPERATIONAL_STATUS_COLORS.success.foreground;
          // A finished run you have not seen is unread; a failure is red.
          dotTone = isFailure ? 'danger' : 'unread';
        } else {
          statusText = 'idle';
          statusClass = OPERATIONAL_STATUS_COLORS.paused.foreground;
          dotTone = 'filter';
        }

        return {
          terminalId: entry.terminalId,
          label,
          statusText,
          statusClass,
          dotTone,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [terminalEntries, terminalLabelSources]);

  const showTerminalPopover = useCallback((element: HTMLElement): void => {
    setTerminalHoverRect(element.getBoundingClientRect());
  }, []);
  const hideTerminalPopover = useCallback((): void => {
    setTerminalHoverRect(null);
  }, []);
  const handleTerminalIconMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      showTerminalPopover(event.currentTarget);
    },
    [showTerminalPopover],
  );
  const handleTerminalIconFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      showTerminalPopover(event.currentTarget);
    },
    [showTerminalPopover],
  );
  const handleTerminalIconKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== 'Escape') return;
      hideTerminalPopover();
      event.currentTarget.blur();
    },
    [hideTerminalPopover],
  );

  // Awaiting-approval popover hover state. Rows are snapshotted from the chat
  // store on hover (see buildChatPreviewRows) so the row never subscribes to
  // streaming chat updates.
  const [approvalHoverRect, setApprovalHoverRect] = useState<DOMRect | null>(
    null,
  );
  const [approvalRows, setApprovalRows] = useState<ChatPreviewRow[]>([]);
  const showApprovalPopover = useCallback(
    (element: HTMLElement): void => {
      setApprovalRows(buildChatPreviewRows(wtKey, 'approval'));
      setApprovalHoverRect(element.getBoundingClientRect());
    },
    [wtKey],
  );
  const hideApprovalPopover = useCallback((): void => {
    setApprovalHoverRect(null);
  }, []);
  const handleApprovalIconMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      showApprovalPopover(event.currentTarget);
    },
    [showApprovalPopover],
  );
  const handleApprovalIconFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      showApprovalPopover(event.currentTarget);
    },
    [showApprovalPopover],
  );
  const handleApprovalIconKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== 'Escape') return;
      hideApprovalPopover();
      event.currentTarget.blur();
    },
    [hideApprovalPopover],
  );

  // Tool-approval popover hover state.
  const [toolApprovalHoverRect, setToolApprovalHoverRect] =
    useState<DOMRect | null>(null);
  const [toolApprovalRows, setToolApprovalRows] = useState<ChatPreviewRow[]>(
    [],
  );
  const showToolApprovalPopover = useCallback(
    (element: HTMLElement): void => {
      setToolApprovalRows(
        buildToolApprovalPreviewRows(wtKey, projectId, worktree.id),
      );
      setToolApprovalHoverRect(element.getBoundingClientRect());
    },
    [projectId, worktree.id, wtKey],
  );
  const hideToolApprovalPopover = useCallback((): void => {
    setToolApprovalHoverRect(null);
  }, []);
  const handleToolApprovalIconMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      showToolApprovalPopover(event.currentTarget);
    },
    [showToolApprovalPopover],
  );
  const handleToolApprovalIconFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      showToolApprovalPopover(event.currentTarget);
    },
    [showToolApprovalPopover],
  );
  const handleToolApprovalIconKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== 'Escape') return;
      hideToolApprovalPopover();
      event.currentTarget.blur();
    },
    [hideToolApprovalPopover],
  );

  // Unread popover hover state.
  const [unreadHoverRect, setUnreadHoverRect] = useState<DOMRect | null>(null);
  const [unreadRows, setUnreadRows] = useState<ChatPreviewRow[]>([]);
  const showUnreadPopover = useCallback(
    (element: HTMLElement): void => {
      setUnreadRows(buildChatPreviewRows(wtKey, 'unread'));
      setUnreadHoverRect(element.getBoundingClientRect());
    },
    [wtKey],
  );
  const hideUnreadPopover = useCallback((): void => {
    setUnreadHoverRect(null);
  }, []);
  const handleUnreadIconMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      showUnreadPopover(event.currentTarget);
    },
    [showUnreadPopover],
  );
  const handleUnreadIconFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      showUnreadPopover(event.currentTarget);
    },
    [showUnreadPopover],
  );
  const handleUnreadIconKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== 'Escape') return;
      hideUnreadPopover();
      event.currentTarget.blur();
    },
    [hideUnreadPopover],
  );

  // Idle watcher-chat popover hover state. Like the unread preview, rows are
  // snapshotted only when the icon is hovered so streaming message deltas do
  // not make every worktree row rebuild tooltip content.
  const [watcherHoverRect, setWatcherHoverRect] = useState<DOMRect | null>(
    null,
  );
  const [watcherRows, setWatcherRows] = useState<ChatPreviewRow[]>([]);
  const showWatcherPopover = useCallback(
    (element: HTMLElement): void => {
      setWatcherRows(
        buildIdleWatcherChatRows({
          projectId,
          worktreeId: worktree.id,
          tabs: useChatStore.getState().worktreeChats[wtKey]?.tabs,
          watchers: useAppAdvisorWatchersStore.getState().watchers,
        }),
      );
      setWatcherHoverRect(element.getBoundingClientRect());
    },
    [projectId, worktree.id, wtKey],
  );
  const hideWatcherPopover = useCallback((): void => {
    setWatcherHoverRect(null);
  }, []);
  const handleWatcherIconMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      showWatcherPopover(event.currentTarget);
    },
    [showWatcherPopover],
  );
  const handleWatcherIconFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      showWatcherPopover(event.currentTarget);
    },
    [showWatcherPopover],
  );
  const handleWatcherIconKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== 'Escape') return;
      hideWatcherPopover();
      event.currentTarget.blur();
    },
    [hideWatcherPopover],
  );

  // Scheduled-message popover hover state.
  const [scheduledMessagesHoverRect, setScheduledMessagesHoverRect] =
    useState<DOMRect | null>(null);
  const showScheduledMessagesPopover = useCallback(
    (element: HTMLElement): void => {
      setScheduledMessagesHoverRect(element.getBoundingClientRect());
    },
    [],
  );
  const hideScheduledMessagesPopover = useCallback((): void => {
    setScheduledMessagesHoverRect(null);
  }, []);
  const handleScheduledMessagesIconMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      showScheduledMessagesPopover(event.currentTarget);
    },
    [showScheduledMessagesPopover],
  );
  const handleScheduledMessagesIconFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void => {
      showScheduledMessagesPopover(event.currentTarget);
    },
    [showScheduledMessagesPopover],
  );
  const handleScheduledMessagesIconKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== 'Escape') return;
      hideScheduledMessagesPopover();
      event.currentTarget.blur();
    },
    [hideScheduledMessagesPopover],
  );

  // Open branch info modal (and optionally seed a rename) via store requests.
  const branchRenameRequest = useProjectsStore(
    (state) => state.branchRenameRequest,
  );
  const clearBranchRenameRequest = useProjectsStore(
    (state) => state.clearBranchRenameRequest,
  );
  useEffect(() => {
    if (pinnedCopy) return;
    if (
      branchRenameRequest &&
      branchRenameRequest.projectId === projectId &&
      branchRenameRequest.worktreeId === worktree.id
    ) {
      clearBranchRenameRequest();
      setShowBranchesModal(true);
      if (isMultiRepo) {
        setPendingBranchInfoRename({
          id: 'all',
          branch:
            repoBranches && repoBranches.length > 0
              ? repoBranches[0].branch
              : worktree.branchName,
        });
      } else {
        setPendingBranchInfoRename({
          id: 'single',
          branch: worktree.branchName,
        });
      }
    }
  }, [
    branchRenameRequest,
    clearBranchRenameRequest,
    projectId,
    worktree.id,
    worktree.branchName,
    isMultiRepo,
    pinnedCopy,
    repoBranches,
  ]);

  const branchInfoRequest = useProjectsStore(
    (state) => state.branchInfoRequest,
  );
  const clearBranchInfoRequest = useProjectsStore(
    (state) => state.clearBranchInfoRequest,
  );
  useEffect(() => {
    if (pinnedCopy) return;
    if (
      branchInfoRequest &&
      branchInfoRequest.projectId === projectId &&
      branchInfoRequest.worktreeId === worktree.id
    ) {
      clearBranchInfoRequest();
      setShowBranchesModal(true);
    }
  }, [
    branchInfoRequest,
    clearBranchInfoRequest,
    pinnedCopy,
    projectId,
    worktree.id,
  ]);

  const uniqueBranches =
    repoBranches && repoBranches.length > 0
      ? new Set(repoBranches.map((rb) => rb.branch))
      : null;
  const hasMultipleBranches =
    uniqueBranches !== null && uniqueBranches.size > 1;
  const rawBranch =
    isMultiRepo && uniqueBranches !== null && repoBranches
      ? hasMultipleBranches
        ? 'Multiple branches'
        : repoBranches[0].branch
      : worktree.branchName;

  const getDisplayName = useBranchDisplayStore((s) => s.getDisplayName);
  // Subscribe to version so we re-render when mappings change
  // (getDisplayName is a stable function ref on its own)
  const mappingsVersion = useBranchDisplayStore((s) => s.mappingsVersion);
  // Skip mapping for synthetic labels and generated default branch names.
  const displayBranch = useMemo((): string => {
    return getWorktreeBranchDisplayName({
      rawBranch,
      worktreeId: worktree.id,
      hasMultipleBranches,
      getBranchDisplayName: getDisplayName,
      defaultDisplayName: NEW_WORKTREE_DISPLAY_NAME,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mappingsVersion invalidates cache
  }, [
    rawBranch,
    worktree.id,
    hasMultipleBranches,
    getDisplayName,
    mappingsVersion,
  ]);

  // A custom label (when set) overrides the computed branch display name as the
  // row's primary name; the raw branch stays available as the label tooltip.
  const primaryLabel = worktree.label?.trim() || displayBranch;
  const workspaceName = useProjectsStore(
    (state) =>
      state.projects.find((project) => project.id === projectId)?.name ??
      projectId,
  );
  // The preview card's project glyph, drawn as the project header draws it.
  const previewProject = useProjectsStore(
    useShallow((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) return null;
      return {
        kind: previewProjectKind(project.type),
        color: project.color,
        temporary: project.type === 'multi-repo' && project.temporary === true,
        repoPath: project.type === 'single-repo' ? project.repoPath : undefined,
      };
    }),
  );
  const currentArchiveTarget = useMemo<WorktreeArchiveConfirmationTarget>(
    () => ({
      workspaceId: projectId,
      workspaceName,
      worktreeId: worktree.id,
      worktreeName: primaryLabel,
      worktreeCreatedAt: worktree.createdAt,
      branchName: worktree.branchName,
    }),
    [
      primaryLabel,
      projectId,
      workspaceName,
      worktree.branchName,
      worktree.createdAt,
      worktree.id,
    ],
  );
  const archiveTargetMatchesCurrentIdentity =
    archiveConfirmationTarget !== null &&
    archiveConfirmationTarget.workspaceId ===
      currentArchiveTarget.workspaceId &&
    archiveConfirmationTarget.worktreeId === currentArchiveTarget.worktreeId &&
    archiveConfirmationTarget.worktreeCreatedAt ===
      currentArchiveTarget.worktreeCreatedAt &&
    archiveConfirmationTarget.branchName === currentArchiveTarget.branchName;

  // PR badge data — read directly from github store
  const isCreatingPr = useGitHubStore((state) =>
    state.creatingPr.has(`${projectId}/${worktree.id}`),
  );
  // True while the user's "Merge" click is being processed for this worktree's
  // PR. Drives the purple merge spinner shown next to the `PR #123` badge.
  const isMergingPr = useGitHubStore((state) =>
    state.mergingPr.has(`${projectId}/${worktree.id}`),
  );
  const lastKnownPrStatus = useMemo<WorktreeRowPrStatus | undefined>(
    () => deriveDesktopPrBadgeStatus(prStatus, isMultiRepo === true),
    [prStatus, isMultiRepo],
  );

  // Mismatch detection: compare workspace config repos vs what's on disk.
  // `repoBranches === undefined` means "not loaded yet" (skip detection); the
  // dialog itself recomputes the per-bucket lists internally.
  const hasMismatch = useMemo((): boolean => {
    if (!isMultiRepo || !configRepos || !repoBranches) return false;
    const onDiskRepoIds = new Set(repoBranches.map((rb) => rb.repoId));
    if (configRepos.some((r) => !onDiskRepoIds.has(r.id))) return true;
    const configRepoIds = new Set(configRepos.map((r) => r.id));
    return repoBranches.some(
      (rb) =>
        rb.repoId !== WORKSPACE_ROOT_REPO_ID && !configRepoIds.has(rb.repoId),
    );
  }, [isMultiRepo, configRepos, repoBranches]);

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const style = sortableDisabled ? undefined : sortableStyle;

  // After a pointer drag ends, the dnd-kit drag handle can retain focus, so
  // `group-focus-within:` styles keep the hover-only buttons visible and the
  // diff stats hidden until the user clicks away. Preserve focus-visible
  // keyboard focus so keyboard drag-and-drop can continue naturally.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLDivElement | null): void => {
      containerRef.current = node;
      setNodeRef?.(node);
    },
    [setNodeRef],
  );
  const wasDraggingRef = useRef(isDragging);
  useEffect(() => {
    if (wasDraggingRef.current && !isDragging) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        containerRef.current?.contains(active) &&
        !active.matches(':focus-visible')
      ) {
        active.blur();
      }
    }
    wasDraggingRef.current = isDragging;
  }, [isDragging]);

  // Effective deletion-retention window for the owning workspace: how long a
  // deleted worktree's chats, Git state, and pipeline history are kept before
  // removal. Deletion retention is always on; cowork workspaces never own
  // worktrees, so a missing project simply falls back to the default window.
  const archiveRetention = useProjectsStore(
    useShallow((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project || project.type === 'cowork') {
        return null;
      }
      return {
        workspaceType: project.type,
        persistedDays: project.archiveRetentionDays,
      };
    }),
  );
  const effectiveRetentionDays =
    archiveRetention === null
      ? resolveArchiveRetentionDays('single-repo', undefined)
      : resolveArchiveRetentionDays(
          archiveRetention.workspaceType,
          archiveRetention.persistedDays,
        );
  // Chip / rail labels always describe the Delete action; the confirmation
  // dialog follows whichever removal mode opened it.
  const deleteLabels = getWorktreeDeleteLabels(
    'delete',
    effectiveRetentionDays,
    worktree.branchName,
  );
  const dialogLabels = getWorktreeDeleteLabels(
    removalMode,
    effectiveRetentionDays,
    worktree.branchName,
  );

  const deleteAction = getDeleteAction({
    isDone,
    hasActiveSession,
    isArchiveInProgress,
    isPendingGitSetup,
    isRunningSetup,
    isTearingDown,
    stats,
    hasUncommittedChanges,
    hasCommitsAhead,
    hasUnpushedCommits,
  });
  // Visibility is more permissive than the confirm-bypass check: a freshly
  // created worktree shows the Delete button immediately (before stats and
  // `hasUncommittedChanges` have loaded). On app startup every worktree
  // briefly has `stats === undefined`, so we gate the missing-stats case on
  // `createdAt` recency to avoid showing the button across the whole sidebar
  // during that window. The confirmation dialog still appears until the stats
  // batch confirms no uncommitted work, at which point clicking skips the
  // dialog and deletes directly.
  const canDeleteStandalone = canShowStandaloneDeleteButton({
    isDone,
    isPendingGitSetup,
    isRunningSetup,
    isTearingDown,
    stats,
    hasUncommittedChanges,
    hasCommitsAhead,
    hasUnpushedCommits,
    isFreshWorktree: isWorktreeFresh(worktree.createdAt),
  });

  const performRemoval = useCallback(
    (mode: WorktreeRemovalMode): void => {
      if (deleteAction === 'disabled' || isArchiveInProgress) return;
      if (mode === 'delete' && deleteAction === 'delete') {
        // No local work to confirm: the store's "archive" operation is the
        // single worktree removal path. Delete lands the retained container
        // in the retention countdown. Archive is a durable state choice, so it
        // still confirms even when Delete is safe to perform immediately.
        onArchive(worktree.id, { deleteWithoutRetentionIfMissing: true });
        return;
      }
      setArchiveConfirmationTarget(currentArchiveTarget);
      setRemovalMode(mode);
      setShowConfirm(true);
    },
    [
      currentArchiveTarget,
      deleteAction,
      isArchiveInProgress,
      onArchive,
      worktree.id,
    ],
  );
  const performDelete = useCallback((): void => {
    performRemoval('delete');
  }, [performRemoval]);

  const confirmRemoval = useCallback(
    (deleteBranch: boolean): void => {
      const confirmationTarget = archiveConfirmationTarget;
      if (
        deleteAction === 'disabled' ||
        isArchiveInProgress ||
        splitLocked ||
        !confirmationTarget ||
        !archiveTargetMatchesCurrentIdentity
      ) {
        return;
      }
      setShowConfirm(false);
      setArchiveConfirmationTarget(null);
      onArchive(worktree.id, {
        deleteBranch,
        expectedBranchName: confirmationTarget.branchName,
        ...(removalMode === 'archive' ? { lockAfterArchive: true } : {}),
        ...(removalMode === 'delete'
          ? { deleteWithoutRetentionIfMissing: true }
          : {}),
      });
    },
    [
      archiveConfirmationTarget,
      archiveTargetMatchesCurrentIdentity,
      deleteAction,
      isArchiveInProgress,
      onArchive,
      removalMode,
      splitLocked,
      worktree.id,
    ],
  );
  const handleDeleteClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    performDelete();
  };

  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const contextMenuPlacement = useContextMenuPlacement();
  /**
   * The "…" menu rows, in the sidebar worktree menu's order and recipe: an
   * icon on every row, Show/Hide in its own group, and Archive and Delete in
   * their own last group. Early access folds the rare rows into "More ›",
   * as the sidebar's menu does. Built only while the menu is open.
   */
  const buildActionsMenuItems = (): WorktreeMenuItem[] => {
    const removalBlocked =
      deleteAction === 'disabled' || isArchiveInProgress || splitLocked;
    const removalTooltip = (verb: 'archiving' | 'deleting'): string | null =>
      isArchiveInProgress
        ? 'Removal is already in progress'
        : splitLocked
          ? `A Split PR is in progress; it must finish before ${verb}.`
          : deleteAction === 'disabled'
            ? `Stop all sessions before ${verb}`
            : null;
    const earlyAccess = contextMenuPlacement === 'cursor';
    const items: WorktreeMenuItem[] = [
      {
        key: 'toggle-pin',
        label: worktree.pinned === true ? 'Unpin' : 'Pin to top',
        icon: <PinIcon />,
        onSelect: (): void => {
          void setWorktreePinned(
            projectId,
            worktree.id,
            worktree.pinned !== true,
          );
        },
        testId: automationId('worktree-actions-menu-toggle-pin'),
      },
      {
        key: 'set-label',
        // Early access: "Rename" with a pencil, as the shared sidebar's row
        // menu reads.
        label: earlyAccess ? 'Rename' : 'Set label',
        icon: earlyAccess ? <PencilIcon /> : <LabelIcon />,
        onSelect: (): void => {
          setPendingBranchInfoLabelEdit(true);
          setShowBranchesModal(true);
        },
        testId: automationId('worktree-actions-menu-set-label'),
      },
      {
        key: 'branch-info',
        label: 'Branch info',
        icon: <InfoIcon />,
        onSelect: (): void => {
          setPendingBranchInfoLabelEdit(false);
          setShowBranchesModal(true);
        },
        testId: automationId('worktree-actions-menu-info'),
      },
    ];
    if (sharedContainerInviteVisible) {
      items.push({
        key: 'invite',
        label: 'Share',
        icon: <ShareIcon />,
        onSelect: (): void => setShowInviteTeammateModal(true),
        testId: automationId('worktree-actions-menu-invite'),
      });
    }
    if (onLaunch) {
      items.push({
        key: 'launch',
        label: 'Launch',
        icon: <RocketLaunchIcon />,
        onSelect: onLaunch,
        disabled: isLaunchActive,
        tooltip: isLaunchActive
          ? 'Launch script is already running'
          : undefined,
        testId: automationId('worktree-actions-menu-launch'),
      });
    }
    if (onDispatchPipeline) {
      items.push({
        key: 'dispatch-pipeline',
        label: 'Dispatch workflow',
        icon: <PipelineIcon />,
        onSelect: (): void => onDispatchPipeline(worktree.id),
        testId: automationId('worktree-actions-menu-dispatch-pipeline'),
      });
    }
    if (canSplitPr) {
      const blockers = splitLocked
        ? ['A Split PR is already in progress for this worktree.']
        : splitPrReadiness.blockers.map(
            (blocker) => SPLIT_PR_BLOCKER_COPY[blocker],
          );
      items.push({
        key: 'split-pr',
        label: 'Split PR…',
        icon: <SplitPrIcon />,
        disabled: blockers.length > 0,
        richTooltip:
          blockers.length > 0 ? (
            <SplitPrBlockedTooltip reasons={blockers} />
          ) : undefined,
        onSelect: (): void => {
          // Select the worktree so the PR activity panel (which owns the
          // plan-review modal and progress UI) is visible, then open the
          // shared pre-flight modal — every split-PR launch surface routes
          // through it instead of calling `planSplitPr` directly (see
          // `SplitPreflightModalHost`).
          onSelect(projectId, worktree.id);
          useActivityStore
            .getState()
            .openSplitPreflight(projectId, worktree.id);
        },
        testId: automationId('worktree-actions-menu-split-pr'),
      });
    }
    if (onCreateBranchWorktree) {
      items.push({
        key: 'create-branch',
        label: 'Branch from',
        icon: <BranchIcon size="md" />,
        onSelect: (): void => onCreateBranchWorktree(worktree.id),
        testId: automationId('worktree-actions-menu-create-branch'),
      });
    }
    if (branchGroupingMenu) {
      items.push({
        key: branchGroupingMenu.kind,
        label: branchGroupingMenu.label,
        icon: WORKTREE_GROUPING_GLYPHS[branchGroupingMenu.kind],
        onSelect: (): void => {
          void branchGroupingMenu.onSelect();
        },
        testId: automationId(branchGroupingMenu.testId),
      });
    }
    if (onAddRepoToWorktreeAdhoc) {
      items.push(
        addRepoMenuItem({
          hasActiveSession,
          isDone,
          isPendingGitSetup,
          isRunningSetup,
          onAddRepoToWorktreeAdhoc: (): void =>
            onAddRepoToWorktreeAdhoc(worktree.id),
        }),
      );
    }
    if (onSplitWorkspace) {
      items.push(
        splitWorkspaceMenuItem({
          hasActiveSession,
          hasActivePipelines:
            pipelineStatus === 'running' || pipelineStatus === 'paused',
          isDone,
          isPendingGitSetup,
          isRunningSetup,
          onSplitWorkspace: (): void => onSplitWorkspace(worktree.id),
        }),
      );
    }
    if (onToggleHidden) {
      items.push({
        key: 'toggle-hidden',
        label: worktree.hidden ? 'Show' : 'Hide',
        icon: worktree.hidden ? <EyeIcon /> : <EyeOffIcon />,
        onSelect: (): void => onToggleHidden(worktree.id, !worktree.hidden),
        separatorBefore: true,
        testId: automationId('worktree-actions-menu-toggle-hidden'),
      });
    }
    // Delete keeps the worktree's chats, Git state, and pipeline history for
    // the retention window; Archive keeps them until the archive is deleted.
    // Both share the same availability gate and route through the same
    // removal confirmation.
    items.push(
      {
        key: 'archive',
        label: 'Archive',
        icon: <ArchiveIcon />,
        disabled: removalBlocked,
        tooltip: removalTooltip('archiving') ?? 'Kept until you delete it',
        onSelect: (): void => performRemoval('archive'),
        separatorBefore: true,
        testId: automationId('worktree-actions-menu-archive'),
      },
      {
        key: 'delete',
        label: 'Delete',
        icon: <TrashIcon />,
        disabled: removalBlocked,
        tooltip:
          removalTooltip('deleting') ??
          `Kept for ${effectiveRetentionDays} ${effectiveRetentionDays === 1 ? 'day' : 'days'}, then removed`,
        onSelect: (): void => performRemoval('delete'),
        testId: automationId('worktree-actions-menu-delete'),
      },
    );
    return earlyAccess ? foldWorktreeMenuIntoMore(items) : items;
  };
  useSuspendSidebarHovers(actionsMenuOpen);
  const actionsMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsMenuPointAnchorRef = useRef<HTMLSpanElement>(null);
  /** Right-click origin; null anchors the menu to the ••• button instead. */
  const [actionsMenuAnchorPoint, setActionsMenuAnchorPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // Early access opens a right-click menu beside the pointer; otherwise the
  // menu hangs from the pointer as it hangs from the ••• button.
  const pointerMenuBesideCursor =
    actionsMenuAnchorPoint !== null && contextMenuPlacement === 'cursor';
  const actionsMenuPlacement: FloatingMenuPlacement = pointerMenuBesideCursor
    ? 'bottom-left'
    : 'bottom-right';
  const actionsMenuGap = pointerMenuBesideCursor
    ? CONTEXT_MENU_POINTER_OFFSET
    : FLOATING_MENU_GAP;
  useEffect(() => {
    if (actionsMenuOpen) onActionsMenuOpen?.();
  }, [actionsMenuOpen, onActionsMenuOpen]);

  const handleActionsMenuOpenChange = useCallback((next: boolean): void => {
    setActionsMenuOpen(next);
    if (!next) setActionsMenuAnchorPoint(null);
  }, []);

  const isListMode = displayMode === 'list';
  const isSortable = !sortableDisabled;
  // Compact sidebar style uses the focused status model (see
  // docs/sidebar-worktree-status.md); Advanced keeps the classic row.
  const focusedRowStatus = useLabsExperimentEnabled('sidebar');
  // List: the actions chip is hover-revealed; the menu trigger is the only
  // affordance until the row is hovered or its dropdown is open.
  // Kanban: the chip is always inline at the bottom-right.
  // Completed and hidden worktrees use the same hover/focus-revealed actions
  // as active rows. While the dropdown is open the controls stay visible so
  // the user does not lose context after moving the pointer.
  // Chips stay hover/focus-gated even while the actions menu is open: the
  // sidebar surface is inert during an open menu (no hover), so pinning them
  // visible would only overlap the title. The cursor-anchored menu no longer
  // needs its trigger to stay painted.
  const isHoverRevealed = isListMode;
  // Archive from the row runs exactly when the menu's Archive item would.
  const canArchiveFromRow =
    deleteAction !== 'disabled' && !isArchiveInProgress && !splitLocked;
  // Why Archive can't run, in the menu item's words.
  const archiveUnavailableReason = isArchiveInProgress
    ? 'Removal is already in progress'
    : splitLocked
      ? 'A Split PR is in progress; it must finish before archiving.'
      : 'Stop all sessions before archiving';
  const archiveButtonLabel = hasActiveSession
    ? 'Stop all sessions before deleting'
    : isDone || canDeleteStandalone
      ? deleteLabels.standaloneActionLabel
      : deleteLabels.archiveActionLabel;

  const sortablePointerDown = listeners?.onPointerDown as
    | ((event: PointerEvent<HTMLDivElement>) => void)
    | undefined;
  const handleDragPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (!isSortable || !sortablePointerDown) return;
      const target = event.target as HTMLElement;
      if (
        target.closest(
          'button, input, textarea, select, a, [contenteditable="true"]',
        )
      ) {
        return;
      }
      sortablePointerDown(event);
    },
    [isSortable, sortablePointerDown],
  );

  // Rows fold the run spinner and the worktree id into a single stop
  // control, so the whole `spinner + animal name` cluster reads as one running
  // launch script: sky while it runs, destructive with a stop glyph on hover.
  const showInlineLaunchStop =
    isListMode && isRunningRun ? launchScriptKey !== null : false;
  const stopLaunchLabel = isLaunchStopping
    ? 'Stopping launch script'
    : 'Stop launch script';

  const runStatusSlot = showInlineLaunchStop ? undefined : isRunningRun &&
    launchScriptKey ? (
    <Tooltip label={stopLaunchLabel}>
      <ControlButton
        type="button"
        onClick={handleStopLaunch}
        disabled={isLaunchStopping}
        aria-label={stopLaunchLabel}
        presentation="worktree-stop-launch"
        appearance={isLaunchStopping}
      >
        <StopLaunchFaces isLaunchStopping={isLaunchStopping} />
      </ControlButton>
    </Tooltip>
  ) : isRunningRun ? (
    <WorktreeIdRunSpinner className="fg-info" />
  ) : undefined;

  const worktreeIdSlot = showInlineLaunchStop ? (
    <WorktreeIdStopLaunchButton
      worktreeId={worktree.id}
      isLaunchStopping={isLaunchStopping}
      onStop={handleStopLaunch}
      testId={automationId('worktree-row-stop-launch')}
    />
  ) : (
    <span>{worktree.id}</span>
  );

  // While a PR is being created, the right rail shows one loader. The subtitle
  // carries the readable status, while hover retains the rich progress detail.
  const prCreatingSlot = isCreatingPr ? (
    <WorktreePrCreatingIndicator
      projectId={projectId}
      worktreeId={worktree.id}
      testId={automationId('worktree-row-pr-creating')}
    />
  ) : undefined;

  // PR merging uses the same single-loader right rail and progress tooltip.
  const prMergingSlot = isMergingPr ? (
    <WorktreePrMergingIndicator
      projectId={projectId}
      worktreeId={worktree.id}
      testId={automationId('worktree-row-pr-merging')}
    />
  ) : undefined;

  const pipelinePopoverSlot =
    pipelineHoverRect && pipelineStatus ? (
      <PipelineStatusPopover
        anchorRect={pipelineHoverRect}
        entries={pipelineSummaries ?? []}
        status={pipelineStatus}
        listId={pipelinePopoverListId}
        onListMouseEnter={cancelPipelinePopoverHide}
        onListMouseLeave={schedulePipelinePopoverHide}
        onListFocus={() => {
          pipelineFocusWithinRef.current = true;
          cancelPipelinePopoverHide();
        }}
        onListBlur={() => {
          pipelineFocusWithinRef.current = false;
          schedulePipelinePopoverHide();
        }}
        onListDismiss={handlePipelineListDismiss}
        onScrollableListReady={handlePipelineListReady}
      />
    ) : undefined;

  const terminalPopoverSlot =
    terminalHoverRect && terminalStatus ? (
      <TerminalStatusPopover
        anchorRect={terminalHoverRect}
        rows={terminalPopoverRows}
        status={terminalStatus}
      />
    ) : undefined;

  const scriptPopoverSlot =
    scriptHoverRect && hasRunningScript ? (
      <RunBadgePopover
        anchorRect={scriptHoverRect}
        rows={scriptPopoverRows}
        heading="Scripts running"
        emptyText="No script details"
      />
    ) : undefined;

  const hookPopoverSlot =
    hookHoverRect && hasRunningHook ? (
      <RunBadgePopover
        anchorRect={hookHoverRect}
        rows={hookPopoverRows}
        heading="Hooks running"
        emptyText="No hook details"
      />
    ) : undefined;

  const approvalPopoverSlot =
    approvalHoverRect && awaitingApproval ? (
      <ChatPreviewPopover
        anchorRect={approvalHoverRect}
        rows={approvalRows}
        heading="Review plan"
      />
    ) : undefined;

  const unreadPopoverSlot =
    unreadHoverRect && effectiveHasUnread ? (
      <ChatPreviewPopover
        anchorRect={unreadHoverRect}
        rows={unreadRows}
        heading={`Unread ${CHAT_UNIT_LABEL_PLURAL}`}
      />
    ) : undefined;

  const toolApprovalPopoverSlot =
    toolApprovalHoverRect && hasPendingToolApproval ? (
      <ChatPreviewPopover
        anchorRect={toolApprovalHoverRect}
        rows={toolApprovalRows}
        heading="Approval needed"
      />
    ) : undefined;

  const watcherPopoverSlot =
    watcherHoverRect && hasIdleWatcherChats ? (
      <ChatPreviewPopover
        anchorRect={watcherHoverRect}
        rows={watcherRows}
        heading={`${CHAT_UNIT_LABEL_PLURAL} with watchers`}
      />
    ) : undefined;

  const scheduledMessagesPopoverSlot =
    scheduledMessagesHoverRect && hasScheduledMessages ? (
      <ChatPreviewPopover
        anchorRect={scheduledMessagesHoverRect}
        rows={scheduledMessageRows}
        heading="Scheduled messages"
      />
    ) : undefined;

  const actionChipSlot = (
    <WorktreeRowActionChip
      displayMode={displayMode}
      menuOpen={actionsMenuOpen}
      // Early access: the row stays lit while its menu is open.
      marksRowWhileOpen={contextMenuPlacement === 'cursor'}
      testIdSuffix={pinnedSurface ? `-${pinnedSurface}` : undefined}
    >
      {!isListMode && hasLineChanges && !isDone && diffStatsForRow && (
        <span className="inline-flex shrink-0">
          <DiffStatsBadge stats={diffStatsForRow} />
        </span>
      )}
      <span
        className={`flex items-center gap-0.5 ${isListMode ? '' : 'ml-auto'}`}
      >
        {worktree.hidden && onToggleHidden && (
          <RailIconButton
            icon={EyeIcon}
            revealOnItemHover={isHoverRevealed}
            coarsePointerTarget
            onClick={(e) => {
              e.stopPropagation();
              onToggleHidden(worktree.id, false);
            }}
            data-testid={automationId('worktree-show-button')}
            aria-label="Show"
          />
        )}
        {/* A disabled (greyed) archive chip is hover noise — when the action
            cannot run (active session, split in progress, removal already
            running), the button does not render at all; the actions menu
            still explains why the action is unavailable. */}
        {/* Early access: the hover offers Pin and Archive; the full menu
            moves to right-click (and stays on ••• for touch, which has no
            right-click). Archive stays in place when it can't run, greyed
            out with the reason in its tooltip. */}
        {focusedRowStatus && isListMode && (
          <RailIconButton
            icon={worktree.pinned === true ? PinFilledIcon : PinIcon}
            tooltipLabel={worktree.pinned === true ? 'Unpin' : 'Pin'}
            tone="neutral"
            revealOnItemHover={isHoverRevealed}
            onClick={(e) => {
              e.stopPropagation();
              void setWorktreePinned(
                projectId,
                worktree.id,
                worktree.pinned !== true,
              );
            }}
            visibility="fine-pointer"
            data-testid={automationId('worktree-pin-button')}
            aria-label={worktree.pinned === true ? 'Unpin' : 'Pin'}
            aria-pressed={worktree.pinned === true}
          />
        )}
        {focusedRowStatus && isListMode && canArchiveFromRow && (
          <RailIconButton
            icon={ArchiveBoxIcon}
            tooltipLabel="Archive"
            tone="neutral"
            revealOnItemHover={isHoverRevealed}
            onClick={(e) => {
              e.stopPropagation();
              performRemoval('archive');
            }}
            visibility="fine-pointer"
            data-testid={automationId('worktree-archive-row-button')}
            aria-label="Archive"
          />
        )}
        {/* When it can't run, Archive stays in place, greyed out, and its
            tooltip says why. */}
        {focusedRowStatus && isListMode && !canArchiveFromRow && (
          <RailIconButton
            icon={ArchiveBoxIcon}
            tooltipLabel={archiveUnavailableReason}
            tone="neutral"
            revealOnItemHover={isHoverRevealed}
            disabled
            visibility="fine-pointer"
            data-testid={automationId('worktree-archive-row-button')}
            aria-label={`Archive: ${archiveUnavailableReason}`}
          />
        )}
        {!(focusedRowStatus && isListMode) &&
          (isDone || canDeleteStandalone) &&
          deleteAction !== 'disabled' &&
          !splitLocked &&
          !isArchiveInProgress && (
            <RailIconButton
              icon={TrashIcon}
              tooltipLabel="Delete"
              tone="neutral"
              revealOnItemHover={isHoverRevealed}
              onClick={handleDeleteClick}
              visibility="fine-pointer"
              data-testid={automationId('worktree-archive-button')}
              aria-label={archiveButtonLabel}
            />
          )}
        <RailIconButton
          ref={actionsMenuTriggerRef}
          icon={MoreHorizontalIcon}
          iconSize={12}
          revealOnItemHover={isHoverRevealed}
          coarsePointerTarget
          visibility={focusedRowStatus && isListMode ? 'coarse-pointer' : 'all'}
          onClick={(e) => {
            e.stopPropagation();
            setActionsMenuAnchorPoint(null);
            setActionsMenuOpen((prev) => !prev);
          }}
          data-testid={automationId('worktree-actions-menu-button')}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={actionsMenuOpen}
        />
        {actionsMenuOpen && actionsMenuAnchorPoint && (
          <FloatingMenuPointAnchor
            ref={actionsMenuPointAnchorRef}
            x={actionsMenuAnchorPoint.x}
            y={actionsMenuAnchorPoint.y}
            ownerDocument={document}
          />
        )}
        <FloatingMenu
          open={actionsMenuOpen}
          onOpenChange={handleActionsMenuOpenChange}
          anchorRef={
            actionsMenuAnchorPoint
              ? actionsMenuPointAnchorRef
              : actionsMenuTriggerRef
          }
          returnFocusRef={actionsMenuTriggerRef}
          anchorPoint={actionsMenuAnchorPoint ?? undefined}
          // A right-click menu closes on a window resize or blur, appears at
          // once and leaves focus put, like a native context menu.
          closeOnWindowChange={actionsMenuAnchorPoint !== null}
          motion={actionsMenuAnchorPoint ? 'none' : 'enter'}
          focusOnOpen={actionsMenuAnchorPoint === null}
          placement={actionsMenuPlacement}
          gap={actionsMenuGap}
          interaction="menu"
          // Rows close the menu themselves.
          closeOnSelect={false}
          data-testid={automationId('worktree-actions-menu')}
          // The menu is portaled; keep its clicks off the row underneath.
          onClick={(e) => e.stopPropagation()}
          className="min-w-45"
        >
          {/* Quieter rows (small text, tertiary icons) where menus open
              at the pointer (early access). */}
          <ActionMenuRowStyle>
            <WorktreeActionMenuItems
              items={buildActionsMenuItems()}
              onSelect={(item): void => {
                if (item.disabled || !item.onSelect) return;
                handleActionsMenuOpenChange(false);
                item.onSelect();
              }}
            />
          </ActionMenuRowStyle>
        </FloatingMenu>
      </span>
    </WorktreeRowActionChip>
  );
  // Must mirror the chip render conditions exactly — counting a button that
  // does not render (e.g. the archive chip while removal is unavailable)
  // oversizes the hover reserve and over-truncates the title.
  const actionChipButtonCount =
    focusedRowStatus && isListMode
      ? // Show (hidden rows) + Pin + Archive (or its held slot); ••• is
        // touch-only here.
        Number(Boolean(worktree.hidden && onToggleHidden)) + 2
      : Number(Boolean(worktree.hidden && onToggleHidden)) +
        Number(
          (isDone || canDeleteStandalone) &&
            deleteAction !== 'disabled' &&
            !splitLocked &&
            !isArchiveInProgress,
        ) +
        1;

  const sharedSetupPhase: SharedWorktreeSetupPhase | undefined = isRunningSetup
    ? 'running-setup'
    : isTearingDown
      ? 'running-teardown'
      : isPendingGitSetup
        ? 'git-pending'
        : undefined;

  const sharedPipelineStatus: SharedWorktreePipelineStatus | undefined =
    pipelineStatus;
  const sharedTerminalStatus: SharedWorktreeTerminalStatus | undefined =
    terminalStatus;
  const sharedScriptStatus: SharedWorktreeScriptStatus | undefined =
    hasRunningScript ? 'running' : undefined;
  const sharedHookStatus: SharedWorktreeHookStatus | undefined = hasRunningHook
    ? 'running'
    : undefined;
  const sharedGraphBuildStatus: SharedWorktreeGraphBuildStatus | undefined =
    isBuildingCodeGraph ? 'building' : undefined;
  const {
    splitStatus: sharedSplitStatus,
    splitStatusMessage: sharedSplitStatusMessage,
  } = deriveWorktreeSplitRowStatus({
    splitLocked,
    sessionOpen: splitWorkflowSessionOpen,
    planning: isPlanningSplit,
    splitting: isSplitting,
    planPresent: splitPlanPresent,
    completed: splitCompleted,
    runningLine: splitRunningLine,
  });
  return (
    <>
      <SharedWorktreeRow
        ref={setRefs}
        dataTestId={pinnedCopy ? 'worktree-row-pinned' : 'worktree-row'}
        dataBranch={rawBranch}
        style={style}
        branchLabel={primaryLabel}
        branchName={rawBranch}
        testIdSuffix={pinnedSurface ? `-${pinnedSurface}` : undefined}
        uiStatus={uiStatus}
        statusModel={focusedRowStatus ? 'focused' : 'classic'}
        selected={isSelected}
        isStreaming={isStreaming}
        backgroundTasks={backgroundTasks}
        isRunningRun={isRunningRun}
        isDiscovering={isDiscovering}
        pipelineStatus={sharedPipelineStatus}
        terminalStatus={sharedTerminalStatus}
        scriptStatus={sharedScriptStatus}
        hookStatus={sharedHookStatus}
        graphBuildStatus={sharedGraphBuildStatus}
        splitStatus={sharedSplitStatus}
        splitStatusMessage={sharedSplitStatusMessage}
        awaitingApproval={awaitingApproval}
        hasPendingQuestion={hasPendingQuestion}
        hasPendingToolApproval={hasPendingToolApproval}
        hasUnread={effectiveHasUnread}
        hasIdleWatcherChats={hasIdleWatcherChats}
        hasScheduledMessages={hasScheduledMessages}
        healthIssue={worktree.healthIssue}
        hasMismatch={hasMismatch}
        setupPhase={sharedSetupPhase}
        lastKnownPrStatus={lastKnownPrStatus}
        sharedWithTeammates={
          sharedContainerInviteVisible && isSharedWithTeammates
        }
        pinnedToTop={worktree.pinned === true}
        // Early access: the idle row shows its last-activity age, the same
        // watermark the Last updated sort uses.
        lastActivityAt={
          focusedRowStatus ? worktreeRecencyMs(worktree) : undefined
        }
        // Early access: a short hover opens the row's preview card.
        hoverPreview={
          focusedRowStatus && isListMode
            ? {
                projectName: workspaceName,
                // The project header's own glyph: avatar or kind badge.
                projectIcon: previewProject ? (
                  <ProjectIcon
                    kind={previewProject.kind}
                    color={previewProject.color}
                    temporary={previewProject.temporary}
                    repoPath={previewProject.repoPath}
                    testIdSuffix="-preview"
                  />
                ) : undefined,
                baseBranch: baseBranchProp ?? undefined,
              }
            : undefined
        }
        isCreatingPr={isCreatingPr}
        prCreatingSlot={prCreatingSlot}
        prMergingSlot={prMergingSlot}
        diffStats={diffStatsForRow}
        diffStatsStyle={worktreeDiffStatsStyle}
        runtimeState={isDone ? 'done' : undefined}
        doneLabel={doneLabel}
        displayMode={displayMode}
        textScale={isListMode ? 'sidebar' : 'default'}
        nested={nested}
        nestedChildDepth={nestedChildDepth}
        isDragging={isDragging}
        nonSortableInteraction={sortableDisabled}
        isTearingDownVisual={isTearingDown}
        onClick={() => onSelect(projectId, worktree.id)}
        onContextMenu={(event) => {
          // Right-click opens the same actions menu the ••• button opens,
          // anchored at the pointer position.
          event.preventDefault();
          setActionsMenuAnchorPoint({ x: event.clientX, y: event.clientY });
          setActionsMenuOpen(true);
        }}
        onDragPointerDown={isSortable ? handleDragPointerDown : undefined}
        worktreeIdSlot={worktreeIdSlot}
        runStatusSlot={runStatusSlot}
        depthBadge={depthBadge}
        pipelinePopoverSlot={pipelinePopoverSlot}
        pipelinePopoverListId={pipelinePopoverListId}
        terminalPopoverSlot={terminalPopoverSlot}
        scriptPopoverSlot={scriptPopoverSlot}
        hookPopoverSlot={hookPopoverSlot}
        approvalPopoverSlot={approvalPopoverSlot}
        unreadPopoverSlot={unreadPopoverSlot}
        toolApprovalPopoverSlot={toolApprovalPopoverSlot}
        watcherPopoverSlot={watcherPopoverSlot}
        scheduledMessagesPopoverSlot={scheduledMessagesPopoverSlot}
        onWarningClick={(e) => {
          e.stopPropagation();
          setShowBranchesModal(true);
        }}
        onPipelineIconMouseEnter={handlePipelineIconMouseEnter}
        onPipelineIconMouseLeave={schedulePipelinePopoverHide}
        onPipelineIconFocus={handlePipelineIconFocus}
        onPipelineIconBlur={handlePipelineIconBlur}
        onPipelineIconClick={handlePipelineIconClick}
        onPipelineIconKeyDown={handlePipelineIconKeyDown}
        onTerminalIconMouseEnter={handleTerminalIconMouseEnter}
        onTerminalIconMouseLeave={hideTerminalPopover}
        onTerminalIconFocus={handleTerminalIconFocus}
        onTerminalIconBlur={hideTerminalPopover}
        onTerminalIconKeyDown={handleTerminalIconKeyDown}
        onScriptIconMouseEnter={handleScriptIconMouseEnter}
        onScriptIconMouseLeave={hideScriptPopover}
        onScriptIconFocus={handleScriptIconFocus}
        onScriptIconBlur={hideScriptPopover}
        onScriptIconKeyDown={handleScriptIconKeyDown}
        onHookIconMouseEnter={handleHookIconMouseEnter}
        onHookIconMouseLeave={hideHookPopover}
        onHookIconFocus={handleHookIconFocus}
        onHookIconBlur={hideHookPopover}
        onHookIconKeyDown={handleHookIconKeyDown}
        onApprovalIconMouseEnter={handleApprovalIconMouseEnter}
        onApprovalIconMouseLeave={hideApprovalPopover}
        onApprovalIconFocus={handleApprovalIconFocus}
        onApprovalIconBlur={hideApprovalPopover}
        onApprovalIconKeyDown={handleApprovalIconKeyDown}
        onToolApprovalIconMouseEnter={handleToolApprovalIconMouseEnter}
        onToolApprovalIconMouseLeave={hideToolApprovalPopover}
        onToolApprovalIconFocus={handleToolApprovalIconFocus}
        onToolApprovalIconBlur={hideToolApprovalPopover}
        onToolApprovalIconKeyDown={handleToolApprovalIconKeyDown}
        onUnreadIconMouseEnter={handleUnreadIconMouseEnter}
        onUnreadIconMouseLeave={hideUnreadPopover}
        onUnreadIconFocus={handleUnreadIconFocus}
        onUnreadIconBlur={hideUnreadPopover}
        onUnreadIconKeyDown={handleUnreadIconKeyDown}
        onWatcherIconMouseEnter={handleWatcherIconMouseEnter}
        onWatcherIconMouseLeave={hideWatcherPopover}
        onWatcherIconFocus={handleWatcherIconFocus}
        onWatcherIconBlur={hideWatcherPopover}
        onWatcherIconKeyDown={handleWatcherIconKeyDown}
        onScheduledMessagesIconMouseEnter={
          handleScheduledMessagesIconMouseEnter
        }
        onScheduledMessagesIconMouseLeave={hideScheduledMessagesPopover}
        onScheduledMessagesIconFocus={handleScheduledMessagesIconFocus}
        onScheduledMessagesIconBlur={hideScheduledMessagesPopover}
        onScheduledMessagesIconKeyDown={handleScheduledMessagesIconKeyDown}
        actionChipSlot={actionChipSlot}
        actionChipButtonCount={actionChipButtonCount}
        // Pinned copies must not carry the flow row's identifying attributes:
        // automation, the pending-scroll consumer, and dnd tooling all query
        // `[data-project-id][data-worktree-id]`, and a (usually hidden) copy
        // earlier in the DOM would shadow the real row.
        dataWorktreeId={pinnedCopy ? undefined : worktree.id}
        dataProjectId={pinnedCopy ? undefined : projectId}
      />

      {showConfirm && (
        <WorktreeRemovalConfirmDialog
          target={archiveConfirmationTarget ?? currentArchiveTarget}
          labels={dialogLabels}
          hasLocalWork={hasLocalWork}
          hasLineChanges={hasLineChanges}
          stats={stats}
          archiveInProgress={isArchiveInProgress}
          blocked={
            deleteAction === 'disabled' ||
            splitLocked ||
            !archiveTargetMatchesCurrentIdentity
          }
          testIdSuffix={pinnedSurface ? `-${pinnedSurface}` : undefined}
          onCancel={() => {
            setShowConfirm(false);
            setArchiveConfirmationTarget(null);
            setRemovalMode('delete');
          }}
          onConfirm={confirmRemoval}
        />
      )}

      {showInviteTeammateModal && (
        <InviteTeammateModal
          projectId={projectId}
          worktreeId={worktree.id}
          containerType="CODE_WORKTREE"
          containerName={displayBranch}
          onClose={() => {
            setShowInviteTeammateModal(false);
          }}
        />
      )}

      {showBranchesModal && (
        <WorktreeBranchInfoDialog
          open
          worktree={worktree}
          projectId={projectId}
          isMultiRepo={isMultiRepo}
          repoBranches={repoBranches}
          configRepos={configRepos}
          hasBranchBeenPushed={hasBranchBeenPushed}
          baseBranch={baseBranchProp}
          baseBranchExistsLocally={baseBranchExistsLocally}
          baseBranchExistsInRemote={baseBranchExistsInRemote}
          branchMutationsDisabled={isPendingGitSetup || isRunningSetup}
          labelFallback={displayBranch}
          onAddRepoToWorktree={onAddRepoToWorktree}
          onRemoveRepoFromWorktree={onRemoveRepoFromWorktree}
          onClose={() => {
            setShowBranchesModal(false);
            setPendingBranchInfoLabelEdit(false);
          }}
          pendingRename={pendingBranchInfoRename}
          onPendingRenameConsumed={() => setPendingBranchInfoRename(null)}
          pendingLabelEdit={pendingBranchInfoLabelEdit}
          onPendingLabelEditConsumed={() =>
            setPendingBranchInfoLabelEdit(false)
          }
        />
      )}
    </>
  );
}
