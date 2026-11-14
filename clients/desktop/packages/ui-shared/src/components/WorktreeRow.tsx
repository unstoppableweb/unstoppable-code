import type { WorkEntryAutoDeleteRowState } from '@canopy/protocol';
import { SidebarAutoDeleteBadge } from './SidebarAutoDeleteBadge';
import { Dot, type DotTone } from './Badge';
import { ChoiceMark } from './Choice';
import type {
  CSSProperties,
  FocusEvent,
  ForwardedRef,
  JSX,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
} from 'react';
import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { LoadingSpinner } from './LoadingSpinner';
import { Button } from './Button';
import { GroupedDiffStats } from './GroupedDiffStats';
import {
  ITEM_PREVIEW_OPEN_DELAY_MS,
  PREVIEW_CARD_SURFACE,
  RichHoverTooltip,
} from './RichHoverTooltip';
import {
  isPrStatusInMergeQueue,
  PR_STATUS_ICONS,
  prHasSuccessIndicator,
  prStatusColorClass,
  prStatusIconKind,
  type WorktreePrBadgeCheckStatus,
  type WorktreeRowMergeQueuePhase,
  type WorktreeRowPrStatus,
} from './pr-status-glyph';
import { SharedWithTeammatesBadge } from './SharedWithTeammatesBadge';
import { SidebarPinnedBadge } from './SidebarPinnedBadge';
import { SidebarRowAge } from './SidebarRowAge';
import { formatCompactAge } from '../lib/format-relative-time';
import { useMinuteClock } from '../lib/useMinuteClock';
import { trackInputModality, wasFocusVisible } from '../lib/input-modality';
import { CometSpinner } from './CometSpinner';
import { RunSpinner } from './RunSpinner';
import { ThinkingSpinner } from './ThinkingSpinner';
import { AgentStateGlyph, backgroundTasksLabel } from './AgentStateGlyph';
import { AppAdvisorWatcherIcon } from '../icons/AppAdvisorWatcherIcon';
import { HoverCardIconSlot } from './HoverCardIconSlot';
import { PlanMapIcon } from '../icons/PlanMapIcon';
import { DoneCheckIcon } from '../icons/DoneCheckIcon';
import {
  BranchIcon,
  GitForkIcon,
  FolderIcon,
  GitDraftIcon,
  GitMergeConflictIcon,
  CircleCheckIcon,
  GitMergeIcon,
  GitMergeQueueIcon,
  PinFilledIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  GraphIcon,
  HookIcon,
  PipelineIcon,
  QuestionMarkIcon,
  RocketLaunchIcon,
  SplitPrIcon,
  TerminalIcon,
  TimeFliesIcon,
  ShareIcon,
  WarningIcon,
  CheckIcon as AppCatalogCheckIcon,
} from '../icons/AppIcons';
import { formatCondensedCount } from '../lib/condensedCount';
import {
  OPERATIONAL_STATUS_COLORS,
  SIDEBAR_INDICATOR_COLORS,
} from '../lib/operational-status-colors';
import { STATUS_GLYPHS } from '../lib/status-glyph';
import { StatusGlyph } from './StatusGlyph';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

export type WorktreeRowUiStatus =
  | 'idle'
  | 'planning'
  | 'working'
  | 'unread'
  | 'done';

export type WorktreePipelineStatus =
  | 'running'
  | 'unseen'
  | 'unseen-failure'
  | 'paused';

export type WorktreeTerminalStatus = 'running' | 'unseen' | 'unseen-failure';

/**
 * Script-row badge state. Scripts only surface a single `running` state in the
 * sidebar (setup, launch, teardown, and ad-hoc run scripts all collapse into
 * one rocket badge); completion/failure is communicated through the activity
 * panel and toasts rather than a lingering row badge.
 */
export type WorktreeScriptStatus = 'running';

/**
 * Hook-row badge state. Like scripts, hook executions only surface a single
 * `running` state in the sidebar; completion/failure is reported through the
 * activity panel and toasts rather than a lingering row badge.
 */
export type WorktreeHookStatus = 'running';

/**
 * Graph-build-row badge state. `'building'` shows a neutral hub icon in the
 * leading metadata slot and an activity loader in the right rail while a
 * code-graph build is in flight. There is no separate completion/failure
 * state; the indicator disappears once the build settles.
 */
export type WorktreeGraphBuildStatus = 'building';

/**
 * Split-PR-row badge state. The leading page-break glyph stays neutral in
 * every state. `'active'` drives the right-rail loader; `'review'` and `'done'`
 * drive the right-rail attention dot.
 */
export type WorktreeSplitStatus = 'active' | 'review' | 'done';

export type WorktreeSetupPhase =
  | 'idle'
  | 'git-pending'
  | 'running-setup'
  | 'running-teardown'
  /**
   * A server-run archive (cloud repository worktrees): shown like teardown,
   * worded as archiving. The desktop's teardown keeps its own copy.
   */
  | 'running-archive'
  /**
   * A cloud task this window opened before the web core created it
   * (CAN-6098): shown like setup, worded as creating the task.
   */
  | 'creating';

/** A cloud task the web core refused to create, and how to try again. */
export interface WorktreeCreationFailure {
  /** Why the task does not exist, as the web core said. */
  readonly reason: string;
  /** Creates the task again under the same id; absent offers no retry. */
  readonly onRetry?: () => void;
  /**
   * Discards what the row still keeps, such as the draft of a task deleted
   * on another device (CAN-6614); absent offers no Discard.
   */
  readonly onDiscard?: () => void;
}

export type WorktreeRowRuntimeState = 'fresh' | 'done' | 'archived';

export type {
  WorktreePrBadgeCheckStatus,
  WorktreeRowMergeQueuePhase,
  WorktreeRowPrStatus,
} from './pr-status-glyph';

/** Appends a row's disambiguating suffix to a base test id, when it has one. */
function withTestIdSuffix(testId: string, suffix?: string): string {
  return suffix ? `${testId}${suffix}` : testId;
}

/** Host-supplied facts for the row's hover preview card. */
export interface WorktreeRowHoverPreview {
  /** The project the worktree belongs to. */
  projectName?: string;
  /**
   * The project's 16px identity glyph, as its sidebar header draws it (the
   * avatar or kind badge). Without one the line shows a folder.
   */
  projectIcon?: ReactNode;
  /** The branch the worktree was created from. */
  baseBranch?: string;
}

export interface WorktreeRowDiffStats {
  insertions: number;
  deletions: number;
}

export interface WorktreeRowHealthIssue {
  status: 'broken' | 'mismatch';
  reason?: string;
}

/** Depth-badge data for a worktree nested under a base-branch ancestor. */
export interface WorktreeRowDepthBadge {
  /** Hops below the top-most base-branch ancestor (always >= 1 when present). */
  depth: number;
  /** The top-most base-branch ancestor's branch name and animal (worktree) id. */
  topMost: { branchName: string; animalName: string };
  /**
   * The direct parent's branch name and animal id. Present only when the direct
   * parent differs from the top-most ancestor (i.e. `depth >= 2`).
   */
  directParent?: { branchName: string; animalName: string };
}

/**
 * Bulk selection on a sidebar row (CAN-3975), separate from the navigation
 * `selected`. Rows join a selection from the section's modifier clicks, keys,
 * and row menu; the row only shows that it is in one.
 */
export interface WorktreeRowMultiSelect {
  readonly selectMode?: boolean;
  readonly selectable?: boolean;
  readonly selected: boolean;
}

/**
 * The row surface: a multi-selected row takes the open row's fill, as a
 * Finder list draws every selected row alike; null keeps the resting look.
 */
function rowHighlightClassName(
  selected: boolean,
  multiSelected: boolean,
): string | null {
  if (multiSelected || selected) return 'bg-muted fg-primary';
  return null;
}

export interface WorktreeRowProps {
  /** Display label to show. */
  branchLabel: string;
  /** Raw branch name used as the tooltip on the label, when the row has one. */
  branchName?: string;
  /** Worktree id used as the sub-label after status badges. */
  worktreeId?: string;
  /** Suffix applied to descendant automation ids for mounted visual copies. */
  testIdSuffix?: string;
  /** Coarse-grained UI status driving the leading dot. */
  uiStatus: WorktreeRowUiStatus;
  /**
   * How a sidebar list row presents its status. `classic` (default) is the
   * full subject chain in `docs/sidebar-worktree-status.md`. `focused`
   * answers two questions only: the leading glyph appears only when the row
   * needs the user (question, tool approval, plan review, paused pipeline,
   * split review), and the trailing slot shows one spinner (work running) or
   * one dot (red failed, blue unseen), never both. Terminals, scripts, hooks,
   * code graph, watchers, scheduled messages, and discovery stay out of the
   * row, and routine metadata (PR label, diff stats, Done) is plain.
   */
  statusModel?: 'classic' | 'focused';
  /** Whether the row is currently the selected target. */
  selected?: boolean;
  /** Bulk selection; omitted where the host offers none. */
  multiSelect?: WorktreeRowMultiSelect;
  /** True when chat is actively streaming. Drives the thinking spinner. */
  isStreaming?: boolean;
  /**
   * Live background tasks in the worktree's chats: the neutral background
   * spinner while no turn runs (turn-state D15). Hosts without the data omit
   * it.
   */
  backgroundTasks?: number;
  /** True when a pipeline run is currently executing. */
  isRunningRun?: boolean;
  /** True when desktop is mid-discovery; shows a small spinner. */
  isDiscovering?: boolean;
  /** Pipeline-row badge state. */
  pipelineStatus?: WorktreePipelineStatus;
  /** Terminal-row badge state. */
  terminalStatus?: WorktreeTerminalStatus;
  /** Script-row badge state. `'running'` shows the rocket badge. */
  scriptStatus?: WorktreeScriptStatus;
  /** Hook-row badge state. `'running'` shows the hook badge. */
  hookStatus?: WorktreeHookStatus;
  /** Graph-build-row badge state. `'building'` shows a neutral hub icon on the
   * left and an activity loader in the right rail. */
  graphBuildStatus?: WorktreeGraphBuildStatus;
  /** Split-PR-row badge state. The left icon stays neutral; status is shown by
   * the loader or attention dot in the right rail. */
  splitStatus?: WorktreeSplitStatus;
  /** Optional one-line status detail rendered under the split badge tooltip
   * header (e.g. the current phase — "Carving child branch (2/4)"). */
  splitStatusMessage?: string;
  /**
   * True when the agent has proposed a plan and is waiting for the user to
   * approve it. Every producer feeds this from `pendingPlanExit`, and the row
   * labels it "Review plan" — it is NOT the tool-approval prompt, which is
   * {@link WorktreeRowProps.hasPendingToolApproval}.
   */
  awaitingApproval?: boolean;
  /**
   * True when a Canopy tool-approval prompt (shell command, file write,
   * network fetch, MCP call) is blocking a chat in this worktree. Renders the
   * needs-input orange dot; outranked only by a pending question.
   *
   * Dot-only by design: the leading slot names what the row is *doing*, and an
   * approval adds no icon vocabulary the severity colour does not already
   * carry. See `docs/sidebar-worktree-status.md`.
   */
  hasPendingToolApproval?: boolean;
  /** True when an agent question (interactive ask-user prompt) is waiting for
   * an answer. Renders the orange question dot; outranked only by the
   * plan-approval shield. */
  hasPendingQuestion?: boolean;
  /** True when the worktree has at least one unread chat update. */
  hasUnread?: boolean;
  /** True when the worktree has an idle chat that owns active watchers. */
  hasIdleWatcherChats?: boolean;
  /** True when the worktree has at least one scheduled chat message. */
  hasScheduledMessages?: boolean;
  /** Health issue indicator. */
  healthIssue?: WorktreeRowHealthIssue;
  /** Worktree health: mismatch detected (multi-repo). */
  hasMismatch?: boolean;
  /** Coarse-grained setup phase. */
  setupPhase?: WorktreeSetupPhase;
  /**
   * A cloud task the web core refused to create (CAN-6098), or one deleted
   * on another device whose draft the host keeps (CAN-6614): the status
   * line reads why, with Try again or Discard when the host offers it.
   */
  creationFailure?: WorktreeCreationFailure;
  /**
   * The row waits in a bulk removal queue for this removal. A host setup
   * phase (teardown included) takes precedence once its own removal starts.
   */
  queuedRemoval?: 'archive' | 'delete';
  /** PR status, if any. */
  lastKnownPrStatus?: WorktreeRowPrStatus;
  /**
   * True when this worktree is published to teammates through a shared
   * container. Persistent metadata, not an activity subject: it renders as a
   * subtitle badge alongside the PR badge and deliberately never competes for
   * the single leading-icon slot (see `docs/sidebar-worktree-status.md`).
   */
  sharedWithTeammates?: boolean;
  /**
   * True when the user pinned this worktree to the top of its project. Like
   * {@link sharedWithTeammates} it is persistent metadata, not an activity
   * subject: the classic sidebar row shows a quiet pin at the trailing edge of
   * its title line, left of the shared badge and any live status, and the
   * leading slot keeps its priority chain. Other layouts ignore it.
   */
  pinnedToTop?: boolean;
  /** Agent-armed removal intent, outside the live-status priority chain. */
  autoDelete?: WorkEntryAutoDeleteRowState;
  onAutoDeleteActivate?: () => void;
  autoDeleteReadOnly?: boolean;
  /**
   * When the worktree last had activity (epoch ms or ISO string). Set, an
   * idle sidebar row shows its compact age (`5m`, `3h`, `2d`) on the right of
   * the title line; a live status takes that spot, and the hover actions
   * replace it.
   */
  lastActivityAt?: string | number;
  /**
   * Set, a short hover opens a preview card beside the row with what the
   * truncated row cannot show: the full title, age, project, branch, worktree
   * id, and pull request. The project name is the one fact the row lacks.
   */
  hoverPreview?: WorktreeRowHoverPreview;
  /** True when a PR creation is in flight. */
  isCreatingPr?: boolean;
  /**
   * Optional replacement for the default `PR <spinner>` creating indicator.
   * Hosts mount a tooltip-wrapped spinner (with the create-PR progress
   * checklist) here. Only rendered while `isCreatingPr` is true; falls back to
   * the plain inline indicator when not provided.
   */
  prCreatingSlot?: ReactNode;
  /**
   * Optional slot rendered immediately after the PR badge while a PR merge is
   * in flight. Hosts mount a purple merge spinner (with the merge-progress
   * tooltip) here so it sits next to `PR #123`.
   */
  prMergingSlot?: ReactNode;
  /** Latest diff stats. */
  diffStats?: WorktreeRowDiffStats;
  /** Number formatting for left-nav diff stats. Defaults to `short`. */
  diffStatsStyle?: 'short' | 'complete';
  /** Runtime state. `'done'` mutes the row; `'archived'` hides badges. */
  runtimeState?: WorktreeRowRuntimeState;
  /** Label for the done runtime state. Defaults to `"Done"`. */
  doneLabel?: string;
  /** Whether the row is rendered in list mode (default) or kanban mode. */
  displayMode?: 'list' | 'kanban';
  /** Restrict visible rail typography to the sidebar's sm/xs scale. */
  textScale?: 'default' | 'sidebar';
  /** Collapse an empty subtitle track in quiet cloud sidebar rows. */
  compact?: boolean;
  /** Indent row content while keeping the interactive surface full-width. */
  nested?: boolean;
  /** Branch-ancestry depth when rendered as a nested child. */
  nestedChildDepth?: number;
  /** When true, render with `opacity-60` to indicate an active drag. */
  isDragging?: boolean;
  /** Show full-row drag cursors on fine pointers. */
  dragCursor?: boolean;
  /**
   * Preserve the default cursor and prevent text selection for a selectable
   * row that intentionally has no pointer-down drag binding.
   */
  nonSortableInteraction?: boolean;
  /**
   * When true, disable interaction and fade the row content while keeping the
   * operational status rail at full opacity.
   */
  isTearingDownVisual?: boolean;
  /** Host-neutral intent to open this row; does not select or move focus. */
  onIntent?: (phase: 'start' | 'end', source: 'pointer' | 'focus') => void;
  /** Click handler for selecting this worktree. */
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Right-click handler — hosts open the same menu the ••• button opens. */
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Pointer-down activator for full-row drag reordering. */
  onDragPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  /**
   * Optional host-owned leading slot used only as a drag activator. Keep its
   * visual content empty; operational status is rendered in the right rail.
   */
  dragHandleSlot?: ReactNode;
  /** Optional action chip slot rendered at the row tail (delete, etc.). */
  actionChipSlot?: ReactNode;
  /** Number of compact action buttons rendered inside `actionChipSlot`. */
  actionChipButtonCount?: number;
  /**
   * Preserve resting space and hide the overlapping status rail when the
   * action chip contains a control that is visible without hover or focus.
   */
  actionChipAlwaysVisible?: boolean;
  /** Optional slot rendered to the right of the pipeline icon. Hosts mount
   * popovers anchored to the icon here. */
  pipelinePopoverSlot?: ReactNode;
  /** Id of the pipeline popover controlled by the pipeline badge. */
  pipelinePopoverListId?: string;
  /** Optional slot rendered to the right of the terminal icon. */
  terminalPopoverSlot?: ReactNode;
  /** Optional slot hosting a popover anchored to the script (rocket) icon. */
  scriptPopoverSlot?: ReactNode;
  /** Optional slot hosting a popover anchored to the hook icon. */
  hookPopoverSlot?: ReactNode;
  /** Optional slot hosting a popover anchored to the awaiting-approval icon. */
  approvalPopoverSlot?: ReactNode;
  /** Optional slot hosting a popover anchored to the unread icon. */
  unreadPopoverSlot?: ReactNode;
  /** Optional slot hosting a popover anchored to the tool-approval dot. */
  toolApprovalPopoverSlot?: ReactNode;
  /** Optional slot hosting a popover anchored to the watcher icon. */
  watcherPopoverSlot?: ReactNode;
  /** Optional slot hosting a popover anchored to the scheduled-message icon. */
  scheduledMessagesPopoverSlot?: ReactNode;
  /** Focusable depth indicator shown inline before the sub-text identity. */
  depthBadge?: WorktreeRowDepthBadge;
  /** Custom rendering for the worktree id chunk; e.g. desktop renders a
   * host-specific identifier label there. */
  worktreeIdSlot?: ReactNode;
  /** Optional host-owned operational status control shown in the right rail. */
  runStatusSlot?: ReactNode;
  /** Optional host-owned persistent status shown in the title-line status rail. */
  statusSlot?: ReactNode;
  /** Click handler on the warning button (e.g. open branch info modal). */
  onWarningClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Mouse-enter handler on the pipeline icon (popover trigger).
   *
   * Contract for this and every sibling `on*IconMouseEnter` below: supplying
   * the handler declares that the host owns the badge's hover surface (a rich
   * popover mounted via the matching `*PopoverSlot`), which suppresses the
   * shared fallback tooltip. Leave it undefined to get the built-in tooltip
   * showing the badge's accessible label.
   */
  onPipelineIconMouseEnter?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Mouse-leave handler on the pipeline icon. */
  onPipelineIconMouseLeave?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Focus handler on the pipeline icon. */
  onPipelineIconFocus?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Blur handler on the pipeline icon. */
  onPipelineIconBlur?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Click handler on an interactive pipeline disclosure. */
  onPipelineIconClick?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Keyboard handler on the pipeline icon. */
  onPipelineIconKeyDown?: (event: KeyboardEvent<HTMLSpanElement>) => void;
  /** Mouse-enter handler on the terminal icon. */
  onTerminalIconMouseEnter?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Mouse-leave handler on the terminal icon. */
  onTerminalIconMouseLeave?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Focus handler on the terminal icon. */
  onTerminalIconFocus?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Blur handler on the terminal icon. */
  onTerminalIconBlur?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Keyboard handler on the terminal icon. */
  onTerminalIconKeyDown?: (event: KeyboardEvent<HTMLSpanElement>) => void;
  /** Mouse-enter handler on the script (rocket) icon (popover trigger). */
  onScriptIconMouseEnter?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Mouse-leave handler on the script icon. */
  onScriptIconMouseLeave?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Focus handler on the script icon. */
  onScriptIconFocus?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Blur handler on the script icon. */
  onScriptIconBlur?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Keyboard handler on the script icon. */
  onScriptIconKeyDown?: (event: KeyboardEvent<HTMLSpanElement>) => void;
  /** Mouse-enter handler on the hook icon (popover trigger). */
  onHookIconMouseEnter?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Mouse-leave handler on the hook icon. */
  onHookIconMouseLeave?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Focus handler on the hook icon. */
  onHookIconFocus?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Blur handler on the hook icon. */
  onHookIconBlur?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Keyboard handler on the hook icon. */
  onHookIconKeyDown?: (event: KeyboardEvent<HTMLSpanElement>) => void;
  /** Mouse-enter handler on the awaiting-approval icon (popover trigger). */
  onApprovalIconMouseEnter?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Mouse-leave handler on the awaiting-approval icon. */
  onApprovalIconMouseLeave?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Focus handler on the awaiting-approval icon. */
  onApprovalIconFocus?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Blur handler on the awaiting-approval icon. */
  onApprovalIconBlur?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Keyboard handler on the awaiting-approval icon. */
  onApprovalIconKeyDown?: (event: KeyboardEvent<HTMLSpanElement>) => void;
  /** Mouse-enter handler on the unread icon (popover trigger). */
  onToolApprovalIconMouseEnter?: (event: MouseEvent<HTMLSpanElement>) => void;
  onToolApprovalIconMouseLeave?: (event: MouseEvent<HTMLSpanElement>) => void;
  onToolApprovalIconFocus?: (event: FocusEvent<HTMLSpanElement>) => void;
  onToolApprovalIconBlur?: (event: FocusEvent<HTMLSpanElement>) => void;
  onToolApprovalIconKeyDown?: (event: KeyboardEvent<HTMLSpanElement>) => void;
  onUnreadIconMouseEnter?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Mouse-leave handler on the unread icon. */
  onUnreadIconMouseLeave?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Focus handler on the unread icon. */
  onUnreadIconFocus?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Blur handler on the unread icon. */
  onUnreadIconBlur?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Keyboard handler on the unread icon. */
  onUnreadIconKeyDown?: (event: KeyboardEvent<HTMLSpanElement>) => void;
  /** Mouse-enter handler on the idle watcher-chat icon. */
  onWatcherIconMouseEnter?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Mouse-leave handler on the idle watcher-chat icon. */
  onWatcherIconMouseLeave?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Focus handler on the idle watcher-chat icon. */
  onWatcherIconFocus?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Blur handler on the idle watcher-chat icon. */
  onWatcherIconBlur?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Keyboard handler on the idle watcher-chat icon. */
  onWatcherIconKeyDown?: (event: KeyboardEvent<HTMLSpanElement>) => void;
  /** Mouse-enter handler on the scheduled-message icon (popover trigger). */
  onScheduledMessagesIconMouseEnter?: (
    event: MouseEvent<HTMLSpanElement>,
  ) => void;
  /** Mouse-leave handler on the scheduled-message icon. */
  onScheduledMessagesIconMouseLeave?: (
    event: MouseEvent<HTMLSpanElement>,
  ) => void;
  /** Focus handler on the scheduled-message icon. */
  onScheduledMessagesIconFocus?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Blur handler on the scheduled-message icon. */
  onScheduledMessagesIconBlur?: (event: FocusEvent<HTMLSpanElement>) => void;
  /** Keyboard handler on the scheduled-message icon. */
  onScheduledMessagesIconKeyDown?: (
    event: KeyboardEvent<HTMLSpanElement>,
  ) => void;
  /** Data-worktree-id forwarded for automation. */
  dataWorktreeId?: string;
  /** Data-project-id forwarded so worktree rows are uniquely addressable. */
  dataProjectId?: string;
  /** Data-branch forwarded for automation row selection by branch name. */
  dataBranch?: string;
  /** Stable testid hook for automation on the outer wrapper. */
  dataTestId?: string;
  /** Inline style forwarded to the outer wrapper (dnd-kit transforms). */
  style?: CSSProperties;
  /**
   * Enforce a ≥44px touch target on the row (CAN-1206). Opt-in so the desktop
   * rail stays pixel-identical; the web portal passes it only for the
   * mobile-drawer variant. Two-line rows already exceed 44px, so this is a
   * floor for the compact single-line cases.
   */
  touchTarget?: boolean;
}

/**
 * Optical size of the branch-style PR glyphs (draft, merged, merge queue) on a focused
 * row. Their nodes sit in the corners of the box, so at the check circle's
 * 16px they read larger than it; 14px in the same 16px slot evens them out
 * and keeps the trailing group's spacing.
 */
const BRANCH_GLYPH_SIZE_PX = 14;
const CLASSIC_LEADING_GLYPH_CLASS =
  'relative inline-flex h-6 w-6 items-center justify-center rounded-sm';
const CLASSIC_TRAILING_DOT_CLASS =
  'relative inline-flex h-5 w-6 shrink-0 items-center justify-center rounded-sm';
/**
 * Grows a warning button to a 24px-tall touch target on coarse pointers. It
 * grows only into the gap beside it: a taller area would cover the title line
 * above and send taps meant for the row to the warning.
 */
const HEALTH_WARNING_COARSE_HIT_AREA =
  "relative before:absolute before:inset-0 before:content-[''] pointer-coarse:before:-inset-x-1.5 pointer-coarse:before:-inset-y-1";
/**
 * Grows a 12px subtitle badge's hover and click target to 16x20 without moving
 * its neighbours; the badges' 6px gap keeps the grown areas apart.
 */
const SUBTITLE_BADGE_HIT_AREA =
  "relative before:absolute before:-inset-x-0.5 before:-inset-y-1 before:content-['']";
const TRAILING_GLYPH_SLOT_CLASS =
  'inline-flex h-4 w-4 shrink-0 items-center justify-center box-content';

const WorktreeRowDragCursorContext = createContext({
  enabled: false,
  isDragging: false,
});

export function WorktreeRowDragCursorProvider({
  isDragging,
  children,
}: {
  isDragging: boolean;
  children: ReactNode;
}): JSX.Element {
  // Rows keep the plain arrow cursor at rest and on hover — a hand/grab
  // cursor on every row makes the whole rail look draggable-only instead of
  // clickable (CAN-3053 regression). The grabbing cursor is reserved for a
  // drag that is actually in progress, matching the legacy desktop rail.
  return (
    <WorktreeRowDragCursorContext.Provider
      value={{ enabled: isDragging, isDragging }}
    >
      {children}
    </WorktreeRowDragCursorContext.Provider>
  );
}

function statusDotTokens(status: WorktreeRowUiStatus): {
  color: string;
  label: string;
} {
  switch (status) {
    case 'planning':
      return {
        color: SIDEBAR_INDICATOR_COLORS.warning,
        label: 'Planning',
      };
    case 'working':
      return {
        color: SIDEBAR_INDICATOR_COLORS.purple,
        label: 'Working',
      };
    case 'unread':
      return {
        color: SIDEBAR_INDICATOR_COLORS.blue,
        label: 'Unread',
      };
    case 'done':
      return {
        color: STATUS_GLYPHS.done.ink,
        label: 'Done',
      };
    case 'idle':
    default:
      return {
        color: SIDEBAR_INDICATOR_COLORS.neutral,
        label: 'Idle',
      };
  }
}

/**
 * Canonical right-rail status: active setup phases use one loader; idle
 * attention states use one solid 8px dot. The wrapper stays 24px so its center
 * exactly matches the right-most compact action button.
 */
export function WorktreeRowPrimaryIndicator({
  uiStatus,
  setupPhase,
  doneLabel = 'Done',
  planningLabel = 'Planning',
  layout = 'compact',
  merged = false,
  testIdSuffix,
}: {
  uiStatus: WorktreeRowUiStatus;
  setupPhase?: WorktreeSetupPhase;
  doneLabel?: string;
  /**
   * The done worktree's pull request merged: Done then draws the shared
   * Merged glyph, not the finished check.
   */
  merged?: boolean;
  /** Tooltip/aria for the planning shield, naming what is waiting. */
  planningLabel?: string;
  layout?: 'classic' | 'compact';
  testIdSuffix?: string;
}): JSX.Element {
  const isCreating = setupPhase === 'creating';
  const isRunningSetup = setupPhase === 'running-setup' || isCreating;
  const isArchiving = setupPhase === 'running-archive';
  const isTearingDown = setupPhase === 'running-teardown' || isArchiving;
  const isPendingGitSetup = setupPhase === 'git-pending';
  const statusTitle = isTearingDown
    ? isArchiving
      ? 'Archiving worktree…'
      : 'Deleting worktree…'
    : isRunningSetup
      ? isCreating
        ? 'Creating task…'
        : 'Running setup…'
      : isPendingGitSetup
        ? 'Setting up worktree (git operations in progress)'
        : null;
  if (statusTitle) {
    if (layout === 'classic') {
      return withStatusTooltip(
        statusTitle,
        <span
          className="inline-flex h-3 w-3 items-center justify-center"
          aria-label={statusTitle}
        >
          <LoadingSpinner tone="accent" className="-translate-y-px" />
        </span>,
      );
    }
    return withStatusTooltip(
      statusTitle,
      <span
        className="inline-flex h-6 w-6 items-center justify-center"
        aria-label={statusTitle}
      >
        <span className="inline-flex h-4 w-4 items-center justify-center">
          <LoadingSpinner tone="accent" />
        </span>
      </span>,
    );
  }

  if (uiStatus === 'done') {
    // Done is the shared status glyph: the green circled check, the same
    // mark a finished run or subagent wears, or Merged when its PR merged.
    return withStatusTooltip(
      doneLabel,
      <span
        className={
          layout === 'classic'
            ? 'inline-flex h-4 w-4 items-center justify-center'
            : 'inline-flex h-6 w-6 items-center justify-center'
        }
        aria-label={doneLabel}
        data-testid={withTestIdSuffix('worktree-row-done', testIdSuffix)}
      >
        <StatusGlyph state={merged ? 'merged' : 'done'} />
      </span>,
    );
  }

  if (uiStatus === 'idle') {
    // Idle is deliberately empty space, not a dot. The classic placeholder
    // keeps the old dot footprint so the drag-handle overlay stays hittable.
    return (
      <span
        className={
          layout === 'classic' ? 'inline-flex h-3 w-3' : 'inline-flex h-6 w-6'
        }
        aria-hidden="true"
        data-testid={withTestIdSuffix(
          'worktree-idle-status-placeholder',
          testIdSuffix,
        )}
      />
    );
  }

  if (uiStatus === 'planning') {
    // Planning means a plan/pipeline is waiting on the user, so the
    // indicator promotes the approval shield — in the planning orange —
    // over an anonymous dot. The label names the trigger.
    return withStatusTooltip(
      planningLabel,
      <span
        className={
          layout === 'classic'
            ? 'inline-flex h-4 w-4 items-center justify-center fg-warning'
            : 'inline-flex h-6 w-6 items-center justify-center fg-warning'
        }
        aria-label={planningLabel}
        data-testid={withTestIdSuffix(
          'worktree-row-planning-approval',
          testIdSuffix,
        )}
      >
        <PlanMapIcon size="sm" aria-hidden="true" />
      </span>,
    );
  }

  if (uiStatus === 'working') {
    // Working means a workflow is running in the background (a streaming
    // chat shows the accent spinner instead, upstream of this branch), so the
    // indicator is the shared Running glyph: the neutral spinner the sidebar
    // already uses for background work, never the accent.
    return withStatusTooltip(
      'Working',
      <span
        className={
          layout === 'classic'
            ? 'inline-flex h-4 w-4 items-center justify-center'
            : 'inline-flex h-6 w-6 items-center justify-center'
        }
        aria-label="Working"
        data-testid={withTestIdSuffix(
          'worktree-row-working-pipeline',
          testIdSuffix,
        )}
      >
        <StatusGlyph state="running" spinnerSize={12} />
      </span>,
    );
  }

  return withStatusTooltip(
    'Unread',
    <span
      aria-label="Unread"
      className={
        layout === 'classic'
          ? 'inline-flex'
          : 'inline-flex h-6 w-6 items-center justify-center'
      }
    >
      <Dot tone="unread" />
    </span>,
  );
}

interface OperationalStatusDotProps {
  label: string;
  tone: DotTone;
  testId?: string;
  host?: RowStatusBadgeHostHandlers;
  describedBy?: string;
}

function OperationalStatusDot({
  label,
  tone,
  testId,
  host,
  describedBy,
}: OperationalStatusDotProps): JSX.Element {
  return (
    <RowStatusBadge
      label={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md"
      testId={testId}
      host={host}
      describedBy={describedBy}
    >
      <Dot tone={tone} />
    </RowStatusBadge>
  );
}

function OperationalStatusLoader({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}): JSX.Element {
  return withStatusTooltip(
    label,
    <span
      className="inline-flex h-6 w-6 items-center justify-center fg-accent"
      aria-label={label}
    >
      <span className="inline-flex h-4 w-4 items-center justify-center">
        {children ?? <LoadingSpinner />}
      </span>
    </span>,
  );
}

interface WatcherStatusIndicatorProps {
  testIdSuffix?: string;
  host?: RowStatusBadgeHostHandlers;
  describedBy?: string;
}

function WatcherStatusIndicator({
  testIdSuffix,
  host,
  describedBy,
}: WatcherStatusIndicatorProps): JSX.Element {
  return (
    <RowStatusBadge
      label="Chats with watchers"
      className="inline-flex h-6 w-6 items-center justify-center rounded-md fg-blue"
      testId={withTestIdSuffix('worktree-row-watchers', testIdSuffix)}
      host={host}
      describedBy={describedBy}
    >
      <AppAdvisorWatcherIcon size="sm" />
    </RowStatusBadge>
  );
}

function PrBadgeContent({
  label,
  testIdSuffix,
}: {
  label: string;
  testIdSuffix?: string;
}): JSX.Element {
  return (
    <span
      className="fg-tertiary"
      data-testid={withTestIdSuffix('worktree-row-pr-label', testIdSuffix)}
    >
      {label}
    </span>
  );
}

/** Classic subtitle glyph for an open PR waiting in its merge queue. */
function ClassicMergeQueueIcon({
  status,
  testIdSuffix,
}: {
  status: WorktreeRowPrStatus;
  testIdSuffix?: string;
}): JSX.Element {
  return (
    <span
      className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
      role="img"
      aria-label={mergeQueueAriaLabel(status)}
      data-testid={withTestIdSuffix(
        'worktree-row-pr-merge-queue',
        testIdSuffix,
      )}
    >
      <GitMergeQueueIcon size={12} />
    </span>
  );
}

function ClassicApprovedReviewIcon({
  isMergeReady,
  hasUnresolvedComments,
  plain = false,
  testIdSuffix,
}: {
  isMergeReady: boolean;
  hasUnresolvedComments: boolean;
  /** Focused rows keep the check's shape and drop its tint. */
  plain?: boolean;
  testIdSuffix?: string;
}): JSX.Element {
  const colorClass = plain
    ? ''
    : !isMergeReady
      ? 'fg-secondary'
      : hasUnresolvedComments
        ? 'fg-warning'
        : 'fg-success';
  const label = !isMergeReady
    ? 'Has PR approval but is not ready to merge'
    : hasUnresolvedComments
      ? 'Approved and ready to merge, with unresolved comments'
      : 'Approved and ready to merge';
  return (
    <span
      className={`inline-flex h-3 w-3 shrink-0 items-center justify-center ${colorClass}`}
      role="img"
      aria-label={label}
      data-testid={withTestIdSuffix('worktree-row-pr-approved', testIdSuffix)}
    >
      <AppCatalogCheckIcon size="xs" aria-hidden="true" />
    </span>
  );
}

function truncateText(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed;
}

function ciStatusLabel(status: WorktreePrBadgeCheckStatus | undefined): string {
  switch (status) {
    case 'passing':
      return 'Passing';
    case 'failing':
      return 'Failing';
    case 'pending':
      return 'Running';
    case 'neutral':
      return 'Neutral';
    default:
      return 'No checks';
  }
}

function reviewStatusLabel(
  status: WorktreeRowPrStatus['reviewStatus'],
): string {
  switch (status) {
    case 'approved':
      return 'Approved';
    case 'changes_requested':
      return 'Changes requested';
    case 'pending':
      return 'Review pending';
    default:
      return 'No reviews';
  }
}

export function PrBadgeTooltipContent({
  pr,
  textScale = 'default',
}: {
  pr: WorktreeRowPrStatus;
  textScale?: 'default' | 'sidebar';
}): JSX.Element {
  const title = pr.title ? truncateText(pr.title, 50) : undefined;
  const description = pr.description
    ? truncateText(pr.description.replace(/\s+/g, ' '), 100)
    : undefined;
  const unresolved = pr.unresolvedCommentCount ?? 0;
  const readyToMerge = pr.isMergeReady === true;
  // "Yes" is green when clean, yellow when there are unresolved comments;
  // "No" stays the default/neutral value color.
  const readyToMergeColorClass = !readyToMerge
    ? ''
    : unresolved > 0
      ? 'fg-warning'
      : 'fg-success';
  const mergeQueuePhase = isPrStatusInMergeQueue(pr)
    ? mergeQueuePhaseLabel(pr.mergeQueuePhase)
    : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {title && (
        <div
          className={`${textScale === 'sidebar' ? 'font-normal' : 'font-medium'} fg-primary`}
        >
          {title}
        </div>
      )}
      {description && (
        <div
          className={`${textScale === 'sidebar' ? 'text-xs' : 'text-2xs'} leading-snug fg-secondary`}
        >
          {description}
        </div>
      )}
      <div
        className={`flex flex-col gap-0.5 ${textScale === 'sidebar' ? 'text-xs' : 'text-2xs'} fg-secondary`}
      >
        <div className="grid grid-cols-2 gap-x-3">
          <div>
            <span className="fg-primary/70">CI checks:</span>{' '}
            {ciStatusLabel(pr.ciStatus)}
          </div>
          <div>
            <span className="fg-primary/70">Ready to merge:</span>{' '}
            <span className={readyToMergeColorClass}>
              {readyToMerge ? 'Yes' : 'No'}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-3">
          <div>
            <span className="fg-primary/70">Review:</span>{' '}
            {reviewStatusLabel(pr.reviewStatus)}
          </div>
          {unresolved > 0 && (
            <div>
              <span className="fg-primary/70">Unresolved comments:</span>{' '}
              {unresolved}
            </div>
          )}
        </div>
        {pr.hasConflicts && (
          <div className="fg-warning">Has merge conflicts</div>
        )}
        {isPrStatusInMergeQueue(pr) && (
          <div data-testid="pr-tooltip-merge-queue">
            {mergeQueueTooltipLabel(pr)}
          </div>
        )}
        {mergeQueuePhase && (
          <div data-testid="pr-tooltip-merge-queue-phase">
            <span className="fg-primary/70">Queue:</span>{' '}
            <span className={mergeQueuePhase.colorClass}>
              {mergeQueuePhase.label}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function pipelineStatusAriaLabel(status: WorktreePipelineStatus): string {
  if (status === 'running') return 'Workflow running';
  if (status === 'unseen-failure') return 'Workflow failed';
  if (status === 'unseen') return 'Workflow completed';
  return 'Workflow paused';
}

/**
 * Leading pipeline glyph color: running keeps the neutral sidebar grey (the
 * running state itself carries the activity signal); paused takes the
 * needs-input orange; unseen results carry their outcome — green completed,
 * red failed.
 */
function pipelineGlyphColorClass(status: WorktreePipelineStatus): string {
  if (status === 'paused') return SIDEBAR_INDICATOR_COLORS.warning;
  if (status === 'unseen') return SIDEBAR_INDICATOR_COLORS.success;
  if (status === 'unseen-failure') return SIDEBAR_INDICATOR_COLORS.destructive;
  return 'fg-secondary';
}

function terminalStatusAriaLabel(status: WorktreeTerminalStatus): string {
  if (status === 'running') return 'Terminal running';
  if (status === 'unseen-failure') return 'Terminal failed';
  return 'Terminal completed';
}

/**
 * Terminal glyph tint. Running and unseen share the info blue in the status
 * rail, where a spinner and a dot tell them apart; the glyph has no shape cue,
 * so a running terminal stays neutral and only its result is tinted, like
 * pipelines.
 */
function terminalStatusColorClass(status: WorktreeTerminalStatus): string {
  if (status === 'running') return 'fg-secondary';
  if (status === 'unseen-failure') {
    return OPERATIONAL_STATUS_COLORS.failed.foreground;
  }
  return OPERATIONAL_STATUS_COLORS.unread.foreground;
}

function scriptStatusAriaLabel(): string {
  return 'Scripts running';
}

function hookStatusAriaLabel(): string {
  return 'Hooks running';
}

function splitStatusAriaLabel(status: WorktreeSplitStatus): string {
  if (status === 'active') return 'Split PR in progress';
  if (status === 'review') return 'Split PR awaiting plan approval';
  return 'Split PR complete';
}

/** Header suffix for the split badge tooltip, mirroring the pipeline tooltip's
 * `Pipelines {statusLabel}` header. */
function splitStatusHeaderLabel(status: WorktreeSplitStatus): string {
  if (status === 'active') return 'in progress';
  if (status === 'review') return 'in review';
  return 'complete';
}

/** Status-dot color for the tooltip's detail row. */
function splitStatusDotTone(status: WorktreeSplitStatus): DotTone {
  return status === 'review' ? 'attention' : 'unread';
}

/** Split badge tint: an active run stays neutral (the rail spinner marks it),
 * review needs-input orange, complete results the unread blue until looked
 * at. */
function splitStatusColorClass(status: WorktreeSplitStatus): string {
  if (status === 'active') return 'fg-secondary';
  if (status === 'review') return 'fg-warning';
  return OPERATIONAL_STATUS_COLORS.unread.foreground;
}

function mergeQueueAriaLabel(status: WorktreeRowPrStatus): string {
  return status.mergeQueuePosition === undefined
    ? 'In merge queue'
    : `In merge queue, position ${status.mergeQueuePosition}`;
}

function mergeQueueTooltipLabel(status: WorktreeRowPrStatus): string {
  return status.mergeQueuePosition === undefined
    ? 'In merge queue'
    : `In merge queue (#${status.mergeQueuePosition})`;
}

/** Focused rows color the PR label only when it needs action. */
function focusedPrStatusColor(status: WorktreeRowPrStatus): string {
  return status.checkStatus === 'failing' || status.hasConflicts === true
    ? 'fg-destructive'
    : '';
}

/**
 * Tooltip copy for a queued PR's entry phase; none for `unknown` or an older
 * snapshot without a phase. Never says "merged": only the PR state proves that.
 */
function mergeQueuePhaseLabel(
  phase: WorktreeRowMergeQueuePhase | undefined,
): { label: string; colorClass: string } | undefined {
  switch (phase) {
    case 'queued':
      return { label: 'Waiting in queue', colorClass: '' };
    case 'awaiting_checks':
      return { label: 'Awaiting queue checks', colorClass: '' };
    case 'mergeable':
      return { label: 'Queue checks passed', colorClass: '' };
    case 'locked':
      return { label: 'Locked for merge', colorClass: '' };
    case 'unmergeable':
      return { label: "Can't merge from queue", colorClass: 'fg-warning' };
    default:
      return undefined;
  }
}

/**
 * The focused queue glyph's name: the classic name plus the known phase, which
 * the row otherwise shows only in its pointer-hover card.
 */
function focusedMergeQueueAriaLabel(status: WorktreeRowPrStatus): string {
  const phase = mergeQueuePhaseLabel(status.mergeQueuePhase);
  const queue = mergeQueueAriaLabel(status);
  return phase ? `${queue}. ${phase.label}` : queue;
}

/** The preview card's queue line: the tooltip's position copy and phase. */
function previewMergeQueueDetail(
  status: WorktreeRowPrStatus,
): string | undefined {
  if (!isPrStatusInMergeQueue(status)) return undefined;
  const phase = mergeQueuePhaseLabel(status.mergeQueuePhase);
  const queue = mergeQueueTooltipLabel(status);
  return phase ? `${queue} · ${phase.label}` : queue;
}

/** PR facts stay with their PR, beneath its title rather than in the activity list. */
function previewPrDetail(
  pr: WorktreeRowPrStatus,
  row: WorktreeRowProps,
): string | undefined {
  if (pr.state === 'merged') return 'Merged';
  if (pr.state === 'closed')
    return row.runtimeState === 'done' || row.uiStatus === 'done'
      ? `Closed · ${row.doneLabel ?? 'Done'}`
      : 'Closed';
  const details: string[] = [];
  if (row.isCreatingPr) details.push('Creating pull request');
  if (row.prMergingSlot != null) details.push('Merging pull request');
  if (pr.state === 'open') {
    const checks = pr.ciStatus ?? pr.checkStatus;
    if (pr.hasConflicts) details.push('Merge conflicts');
    else if (isPrStatusInMergeQueue(pr)) {
      const queue = previewMergeQueueDetail(pr);
      if (queue) details.push(queue);
    } else {
      if (checks === 'pending') details.push('Checks running');
      if (checks === 'failing') details.push('Checks failing');
      if (
        checks === 'passing' &&
        !pr.isMergeReady &&
        pr.reviewStatus !== 'approved'
      )
        details.push('Checks passing');
      if (pr.reviewStatus === 'changes_requested')
        details.push('Changes requested');
      else {
        if (pr.reviewStatus === 'approved') details.push('Approved');
        if (pr.isMergeReady) details.push('Ready to merge');
      }
    }
    const comments = pr.unresolvedCommentCount ?? 0;
    if (comments > 0)
      details.push(
        `${comments} unresolved ${comments === 1 ? 'comment' : 'comments'}`,
      );
  }
  if (row.runtimeState === 'done' || row.uiStatus === 'done')
    details.push(row.doneLabel ?? 'Done');
  return details.length ? details.join(' · ') : undefined;
}

function classicPrStatusColor(status: WorktreeRowPrStatus): string {
  // Queued: GitHub is running the queue's checks, so it reads as pending.
  if (status.hasConflicts !== true && isPrStatusInMergeQueue(status)) {
    return 'fg-warning';
  }
  if (status.checkStatus === 'passing') return 'fg-success';
  if (status.checkStatus === 'failing') return 'fg-destructive';
  if (status.checkStatus === 'pending') return 'fg-warning';
  return 'fg-secondary';
}

function prStatusAriaLabel(status: WorktreeRowPrStatus): string {
  const prLabel = status.label ?? 'Pull request';
  // The name carries the state the glyph draws.
  if (status.hasConflicts === true) return `${prLabel}, has merge conflicts`;
  if (isPrStatusInMergeQueue(status)) return mergeQueueAriaLabel(status);
  if (status.state === 'merged') return `${prLabel}, merged`;
  if (status.reviewStatus !== 'approved') return prLabel;

  if (status.isMergeReady !== true) {
    return 'Has PR approval but is not ready to merge';
  }

  return (status.unresolvedCommentCount ?? 0) > 0
    ? 'Approved and ready to merge, with unresolved comments'
    : 'Approved and ready to merge';
}

/** One shared formatter: constructing an `Intl.NumberFormat` per cell was the
 * hottest renderer frame in the capability-picker profile, and the sidebar
 * renders this badge once per worktree row. */
const GROUPED_COUNT_FORMAT = new Intl.NumberFormat('en-US');

export interface DiffStatsBadgeProps {
  stats: WorktreeRowDiffStats;
  /**
   * `default` prints every digit. `condensed` shortens counts of 1,000 or more
   * to a truncated bracket label (`1234` -> `1k`, `999999` -> `999k`,
   * `1234567` -> `1M`) and moves the exact totals into the hover title. Use it
   * only where horizontal space is scarce, such as the sidebar worktree row.
   */
  variant?: 'default' | 'condensed';
  /**
   * `semantic` (default) tints insertions success and deletions destructive.
   * `plain` inherits the surrounding ink, for routine metadata on a focused
   * sidebar row.
   */
  tone?: 'semantic' | 'plain';
}

export function DiffStatsBadge({
  stats,
  variant = 'default',
  tone = 'semantic',
}: DiffStatsBadgeProps): JSX.Element {
  const plain = tone === 'plain';
  const hasInsertions = stats.insertions > 0;
  const hasDeletions = stats.deletions > 0;
  const condensed = variant === 'condensed';
  const insertionsLabel = condensed
    ? formatCondensedCount(stats.insertions)
    : String(stats.insertions);
  const deletionsLabel = condensed
    ? formatCondensedCount(stats.deletions)
    : String(stats.deletions);

  // Only offer the hover title when a rendered side actually lost digits;
  // repeating an already-exact label as a tooltip is noise. Building the title
  // lazily keeps the shared `Intl.NumberFormat` off the render path of every
  // sidebar row that has nothing to condense.
  const abbreviated =
    (hasInsertions && insertionsLabel !== String(stats.insertions)) ||
    (hasDeletions && deletionsLabel !== String(stats.deletions));
  let exactTitle: string | undefined;
  if (abbreviated) {
    const parts: string[] = [];
    if (hasInsertions) {
      parts.push(`+${GROUPED_COUNT_FORMAT.format(stats.insertions)}`);
    }
    if (hasDeletions) {
      parts.push(`-${GROUPED_COUNT_FORMAT.format(stats.deletions)}`);
    }
    exactTitle = parts.join(' ');
  }

  return (
    <span
      data-testid="diff-stats-badge"
      title={exactTitle}
      className="inline-flex items-center gap-1 whitespace-nowrap text-2xs font-normal leading-4 tabular-nums"
    >
      {hasInsertions && (
        <span className={plain ? undefined : 'fg-success'}>
          +{insertionsLabel}
        </span>
      )}
      {hasDeletions && (
        <span className={plain ? undefined : 'fg-destructive'}>
          -{deletionsLabel}
        </span>
      )}
      {!hasInsertions && !hasDeletions && (
        <span className="fg-secondary">0</span>
      )}
    </span>
  );
}

/**
 * Class for a button inside {@link WorktreeRowActionChip}. When
 * `hoverRevealed` is true the button rests invisible and appears on row
 * hover/focus — except on coarse pointers (touch), where there is no hover so
 * the button is always visible.
 */
export function worktreeRowActionButtonClass(hoverRevealed: boolean): string {
  return hoverRevealed
    ? 'focus-ring inline-flex shrink-0 items-center justify-center rounded-md p-1.5 fg-secondary opacity-0 transition-opacity hover:fg-primary focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:opacity-100'
    : 'focus-ring inline-flex shrink-0 items-center justify-center rounded-md p-1.5 fg-secondary transition-opacity hover:fg-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11';
}

export interface WorktreeRowActionChipProps {
  /** Row display mode. `list` floats the chip over the row tail; `kanban`
   * renders it as an inline full-width strip at the card bottom. */
  displayMode?: 'list' | 'kanban';
  /** True while the host's actions dropdown is open: lifts the chip above
   * sibling rows and keeps its surface visible. */
  menuOpen?: boolean;
  /**
   * While the menu is open, keep the row on its hover surface, the way Finder
   * outlines the item a context menu acts on, so the user can still tell which
   * row the menu is for once it covers the row.
   */
  marksRowWhileOpen?: boolean;
  /** Marks that the chip contains a control visible without hover or focus.
   * Pair with `WorktreeRow.actionChipAlwaysVisible` so the row reserves space. */
  alwaysVisible?: boolean;
  /** Suffix applied when the chip belongs to a mounted visual copy. */
  testIdSuffix?: string;
  children: ReactNode;
}

/**
 * Shared action host mounted into {@link WorktreeRow}'s `actionChipSlot`. In
 * list mode it is an absolutely-positioned overlay at the row's right edge, so
 * it consumes no layout width. Individual actions own their hover treatment;
 * the host deliberately adds no surface, border, or shadow.
 */
const WorktreeRowInlineActions = createContext(false);

export function WorktreeRowActionChip({
  displayMode = 'list',
  menuOpen = false,
  marksRowWhileOpen = false,
  alwaysVisible = false,
  testIdSuffix,
  children,
}: WorktreeRowActionChipProps): JSX.Element {
  const inline = useContext(WorktreeRowInlineActions);
  return (
    <div
      data-testid={withTestIdSuffix('worktree-row-action-chip', testIdSuffix)}
      data-row-menu-open={menuOpen && marksRowWhileOpen ? 'true' : undefined}
      data-row-menu-active={menuOpen ? 'true' : undefined}
      data-always-visible={alwaysVisible || undefined}
      className={
        inline
          ? 'relative inline-flex shrink-0 items-center justify-end gap-0.5'
          : displayMode === 'list'
            ? // The controls sit as far from the row's right edge as from its
              // top: 2px beside the label line, 4px centered in a one-line row.
              // Fine-pointer controls align with the label line: the subtitle
              // block below it is a fixed mt-0.5 + h-4 = 1.125rem. Coarse
              // pointers instead center the 44px hitbox in the 44px row; lifting
              // that full hitbox overlaps the workspace-header actions above it.
              `absolute right-0.5 top-[calc(50%-0.5625rem)] flex -translate-y-1/2 items-center justify-end gap-0.5 group-data-[worktree-single-line=true]:right-1 group-data-[worktree-single-line=true]:top-1/2 pointer-coarse:top-1/2 ${
                // While the row's own menu is open the actions are hidden: the
                // menu already identifies its row, and its trigger holds focus,
                // so `group-focus-within` would otherwise keep the whole cluster
                // lit for as long as the menu is up. Opacity on the chip beats
                // the children's own reveal classes, and every control stays
                // mounted and focusable — the trigger is the menu's anchor.
                // The old z-40 lift (so a hovered sibling row could not paint
                // over these) is redundant once they are invisible.
                menuOpen ? 'opacity-0' : ''
              }`
            : `flex w-full items-center gap-0.5 ${menuOpen ? 'opacity-0' : ''}`
      }
    >
      {children}
    </div>
  );
}

/**
 * Wrap a status indicator in the shared rich hover tooltip carrying its
 * accessible label. Status glyphs used to rely on a native `title`, which
 * lags noticeably on macOS (CAN-2799); the rich tooltip opens on
 * mouseenter/focus. Returns the badge bare when there is no label to show.
 */
function withStatusTooltip(
  label: string | undefined,
  badge: JSX.Element,
): JSX.Element {
  if (!label) return badge;
  return (
    <RichHoverTooltip
      surfaceClassName="w-max"
      surfacePadding="relaxed"
      content={<div className="text-xs fg-primary">{label}</div>}
    >
      {badge}
    </RichHoverTooltip>
  );
}

/** A host's hover, focus, and key handlers for a badge's own popover. */
interface RowStatusBadgeHostHandlers {
  onMouseEnter?: (event: MouseEvent<HTMLSpanElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLSpanElement>) => void;
  onFocus?: (event: FocusEvent<HTMLSpanElement>) => void;
  onBlur?: (event: FocusEvent<HTMLSpanElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLSpanElement>) => void;
  onClick?: (event: MouseEvent<HTMLSpanElement>) => void;
}

type RowStatusBadgeData = Readonly<
  Record<`data-${string}`, string | number | undefined>
>;

interface RowStatusBadgeProps {
  label: string;
  className: string;
  testId?: string;
  data?: RowStatusBadgeData;
  /**
   * Supplying `onMouseEnter` declares that the host owns the badge's hover
   * surface, so the badge renders bare and always takes focus.
   */
  host?: RowStatusBadgeHostHandlers;
  /** The open host popover's id: it describes the badge while it shows. */
  describedBy?: string;
  /**
   * The pipeline badge is a real disclosure: Enter toggles its popover and
   * ArrowDown moves into the list it controls.
   */
  disclosure?: { readonly expanded: boolean; readonly listId?: string };
  /**
   * Whether a badge with only a tooltip takes focus. Loaders pass false: they
   * only report progress, so there is nothing to read or open.
   */
  tooltipFocusable?: boolean;
  /** Rich tooltip content; the label alone by default. */
  tooltip?: ReactNode;
  children: ReactNode;
}

/**
 * Every row status badge: a labelled glyph that either hosts its own popover
 * (desktop wires `on*IconMouseEnter` + `*PopoverSlot`) or explains itself in a
 * shared tooltip.
 */
function RowStatusBadge({
  label,
  className,
  testId,
  data,
  host,
  describedBy,
  disclosure,
  tooltipFocusable = true,
  tooltip,
  children,
}: RowStatusBadgeProps): JSX.Element {
  const hostOwnsSurface = host?.onMouseEnter !== undefined;
  const badge = (
    <span
      className={`focus-ring outline-none ${className}`}
      role={disclosure ? 'button' : 'img'}
      aria-label={label}
      aria-describedby={describedBy}
      aria-expanded={disclosure?.expanded}
      aria-controls={disclosure?.expanded ? disclosure.listId : undefined}
      tabIndex={
        disclosure !== undefined || hostOwnsSurface || tooltipFocusable
          ? 0
          : undefined
      }
      // A press must not focus a disclosure: focus would pin its popover open.
      onMouseDown={
        disclosure ? (event): void => event.preventDefault() : undefined
      }
      {...host}
      data-testid={testId}
      {...data}
    >
      {children}
    </span>
  );
  if (hostOwnsSurface) return badge;
  if (tooltip === undefined) return withStatusTooltip(label, badge);
  return (
    <RichHoverTooltip
      content={tooltip}
      surfaceClassName="min-w-40 max-w-65"
      surfacePadding="card"
    >
      {badge}
    </RichHoverTooltip>
  );
}

/** Gives a host popover the id its badge names in `aria-describedby`. */
function withPopoverId(slot: ReactNode, id: string): ReactNode {
  return isValidElement<{ id?: string }>(slot)
    ? cloneElement(slot, { id })
    : slot;
}

function SplitStatusTooltip({
  status,
  message,
  textScale,
}: {
  status: WorktreeSplitStatus;
  message?: string;
  textScale: 'default' | 'sidebar';
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div
        className={`${textScale === 'sidebar' ? 'text-xs font-normal' : 'text-3xs font-semibold'} fg-secondary`}
      >
        Split PR {splitStatusHeaderLabel(status)}
      </div>
      {message && (
        <div className="flex items-center gap-1.5 text-xs">
          <Dot tone={splitStatusDotTone(status)} />
          <span className="fg-primary">{message}</span>
        </div>
      )}
    </div>
  );
}

const GRAPH_TOOLTIP = (
  <div className="text-xs fg-primary">Updating project graph…</div>
);

export function buildDepthBadgeAriaLabel(badge: WorktreeRowDepthBadge): string {
  return `Depth ${badge.depth} under top-most parent ${badge.topMost.branchName}`;
}

export function DepthBadgeTooltipContent({
  badge,
  textScale = 'default',
}: {
  badge: WorktreeRowDepthBadge;
  textScale?: 'default' | 'sidebar';
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <p
        className={`${textScale === 'sidebar' ? 'font-normal' : 'font-semibold'} fg-primary`}
      >
        Depth {badge.depth} under the top-most parent
      </p>
      <p className="fg-secondary">
        {`Top-most parent: ${badge.topMost.branchName} (${badge.topMost.animalName})`}
      </p>
      {badge.directParent && (
        <p className="fg-secondary">
          {`Direct parent: ${badge.directParent.branchName} (${badge.directParent.animalName})`}
        </p>
      )}
    </div>
  );
}

function DepthBadgeTrigger({
  badge,
  value,
  textScale,
  testId,
}: {
  badge: WorktreeRowDepthBadge;
  value: number;
  textScale: 'default' | 'sidebar';
  testId: string;
}): JSX.Element {
  return (
    <RichHoverTooltip
      content={<DepthBadgeTooltipContent badge={badge} textScale={textScale} />}
    >
      <span
        data-testid={testId}
        data-depth={badge.depth}
        role="img"
        tabIndex={0}
        aria-label={buildDepthBadgeAriaLabel(badge)}
        // Inherits the subtitle's font size, weight, and gray so the depth
        // number reads with the same optical weight as its neighbors.
        className="focus-ring -mx-2.25 inline-flex h-4 min-w-6 items-center justify-center rounded-sm px-2.25 outline-none"
      >
        {value}
      </span>
    </RichHoverTooltip>
  );
}

/**
 * Shared worktree row visual primitive. Renders the leading status column,
 * the truncated label, and the conditional badge row (warning, pipeline,
 * terminal, busy spinner, setup/teardown, PR, awaiting approval, unread,
 * discovering, diff stats). The host owns stateful concerns: drag handles,
 * popovers, action chips. They mount via the slot props.
 */
function WorktreeRowImpl(
  {
    branchLabel,
    branchName,
    hoverPreview,
    worktreeId,
    testIdSuffix,
    uiStatus,
    statusModel = 'classic',
    selected = false,
    multiSelect,
    isStreaming = false,
    backgroundTasks = 0,
    isRunningRun = false,
    isDiscovering: isDiscoveringProp = false,
    pipelineStatus,
    terminalStatus: terminalStatusProp,
    scriptStatus: scriptStatusProp,
    hookStatus: hookStatusProp,
    graphBuildStatus: graphBuildStatusProp,
    splitStatus: splitStatusProp,
    splitStatusMessage,
    awaitingApproval = false,
    hasPendingQuestion = false,
    hasPendingToolApproval = false,
    hasUnread = false,
    hasIdleWatcherChats: hasIdleWatcherChatsProp = false,
    hasScheduledMessages: hasScheduledMessagesProp = false,
    healthIssue,
    hasMismatch = false,
    setupPhase,
    creationFailure,
    queuedRemoval,
    lastKnownPrStatus,
    sharedWithTeammates = false,
    pinnedToTop = false,
    autoDelete,
    onAutoDeleteActivate,
    autoDeleteReadOnly = false,
    lastActivityAt,
    isCreatingPr = false,
    prCreatingSlot,
    prMergingSlot,
    diffStats,
    diffStatsStyle = 'short',
    runtimeState,
    doneLabel = 'Done',
    displayMode = 'list',
    textScale = 'default',
    compact = false,
    nested = false,
    nestedChildDepth,
    isDragging = false,
    dragCursor = false,
    nonSortableInteraction = false,
    isTearingDownVisual = false,
    onClick,
    onIntent,
    onContextMenu,
    onDragPointerDown,
    dragHandleSlot,
    actionChipSlot,
    actionChipButtonCount = 2,
    actionChipAlwaysVisible = false,
    pipelinePopoverSlot,
    pipelinePopoverListId,
    terminalPopoverSlot,
    scriptPopoverSlot,
    hookPopoverSlot,
    approvalPopoverSlot,
    unreadPopoverSlot,
    toolApprovalPopoverSlot,
    watcherPopoverSlot,
    scheduledMessagesPopoverSlot,
    depthBadge,
    worktreeIdSlot,
    runStatusSlot,
    statusSlot,
    onWarningClick,
    onPipelineIconMouseEnter,
    onPipelineIconMouseLeave,
    onPipelineIconFocus,
    onPipelineIconBlur,
    onPipelineIconClick,
    onPipelineIconKeyDown,
    onTerminalIconMouseEnter,
    onTerminalIconMouseLeave,
    onTerminalIconFocus,
    onTerminalIconBlur,
    onTerminalIconKeyDown,
    onScriptIconMouseEnter,
    onScriptIconMouseLeave,
    onScriptIconFocus,
    onScriptIconBlur,
    onScriptIconKeyDown,
    onHookIconMouseEnter,
    onHookIconMouseLeave,
    onHookIconFocus,
    onHookIconBlur,
    onHookIconKeyDown,
    onApprovalIconMouseEnter,
    onApprovalIconMouseLeave,
    onApprovalIconFocus,
    onApprovalIconBlur,
    onApprovalIconKeyDown,
    onToolApprovalIconMouseEnter,
    onToolApprovalIconMouseLeave,
    onToolApprovalIconFocus,
    onToolApprovalIconBlur,
    onToolApprovalIconKeyDown,
    onUnreadIconMouseEnter,
    onUnreadIconMouseLeave,
    onUnreadIconFocus,
    onUnreadIconBlur,
    onUnreadIconKeyDown,
    onWatcherIconMouseEnter,
    onWatcherIconMouseLeave,
    onWatcherIconFocus,
    onWatcherIconBlur,
    onWatcherIconKeyDown,
    onScheduledMessagesIconMouseEnter,
    onScheduledMessagesIconMouseLeave,
    onScheduledMessagesIconFocus,
    onScheduledMessagesIconBlur,
    onScheduledMessagesIconKeyDown,
    dataWorktreeId,
    dataProjectId,
    dataBranch,
    dataTestId,
    style,
    touchTarget = false,
  }: WorktreeRowProps,
  ref: ForwardedRef<HTMLDivElement>,
): JSX.Element {
  const dragCursorContext = useContext(WorktreeRowDragCursorContext);
  const showsDragCursor = dragCursor || dragCursorContext.enabled;
  const rowIsDragging = isDragging || dragCursorContext.isDragging;
  // Focus on nested status/menu controls is not intent to open the row.
  const intentHandlers = onIntent
    ? {
        onPointerEnter: (): void => onIntent('start', 'pointer'),
        onPointerLeave: (): void => onIntent('end', 'pointer'),
        onFocus: (event: FocusEvent<HTMLDivElement>): void => {
          if (event.target === event.currentTarget) onIntent('start', 'focus');
        },
        onBlur: (event: FocusEvent<HTMLDivElement>): void => {
          if (event.target === event.currentTarget) onIntent('end', 'focus');
        },
      }
    : undefined;
  const [isRightStatusFocused, setIsRightStatusFocused] = useState(false);
  const isDone = runtimeState === 'done';
  const isListMode = displayMode === 'list';
  // Sidebar list rows always use the classic hierarchy; the second render
  // path below serves kanban cards and default-text-scale rows.
  const isClassicSidebar = isListMode && textScale === 'sidebar';
  const multiSelected = multiSelect?.selected === true;
  const highlightClassName = rowHighlightClassName(selected, multiSelected);
  // The focused model keeps housekeeping subjects out of the row entirely, so
  // they are dropped here and no badge, promotion, or subtitle line sees them.
  // A finished split leaves the row too; a carving split shows as the working
  // spinner and a split in review keeps its glyph.
  const focusedStatus = isClassicSidebar && statusModel === 'focused';
  const isDiscovering = focusedStatus ? false : isDiscoveringProp;
  const terminalStatus = focusedStatus ? undefined : terminalStatusProp;
  const scriptStatus = focusedStatus ? undefined : scriptStatusProp;
  const hookStatus = focusedStatus ? undefined : hookStatusProp;
  const graphBuildStatus = focusedStatus ? undefined : graphBuildStatusProp;
  const splitStatus =
    focusedStatus && splitStatusProp === 'done' ? undefined : splitStatusProp;
  const hasIdleWatcherChats = focusedStatus ? false : hasIdleWatcherChatsProp;
  const hasScheduledMessages = focusedStatus ? false : hasScheduledMessagesProp;
  const isPendingGitSetup = setupPhase === 'git-pending';
  // A task still being created reads as setup, in its own words (CAN-6098).
  const isCreating = setupPhase === 'creating';
  const isRunningSetup = setupPhase === 'running-setup' || isCreating;
  const setupLabel = isCreating ? 'Creating task' : 'Running setup';
  const isArchiving = setupPhase === 'running-archive';
  const isTearingDown = setupPhase === 'running-teardown' || isArchiving;
  // Waiting, not working: read still, with no loader.
  const queuedRemovalLabel =
    queuedRemoval === undefined ||
    isTearingDown ||
    isRunningSetup ||
    isPendingGitSetup
      ? null
      : queuedRemoval === 'archive'
        ? 'Queued for archiving'
        : 'Queued for deletion';
  const hasLineChanges =
    diffStats !== undefined &&
    (diffStats.insertions > 0 || diffStats.deletions > 0);
  // Setup can temporarily leave a checkout incomplete. Keep the setup
  // indicator authoritative until creation finishes, then surface real health
  // failures if the worktree remains broken.
  const showHealthWarning =
    !isPendingGitSetup &&
    !isRunningSetup &&
    (hasMismatch || healthIssue?.status === 'broken');
  const actionChipRestingPadding =
    actionChipButtonCount <= 1
      ? 'pr-8'
      : actionChipButtonCount === 2
        ? 'pr-15.5'
        : actionChipButtonCount === 3
          ? 'pr-23'
          : 'pr-30.5';
  const actionChipHoverPadding =
    actionChipButtonCount <= 1
      ? 'pointer-fine:group-hover:pr-8 pointer-fine:group-focus-within:pr-8'
      : actionChipButtonCount === 2
        ? 'pointer-fine:group-hover:pr-15.5 pointer-fine:group-focus-within:pr-15.5'
        : actionChipButtonCount === 3
          ? 'pointer-fine:group-hover:pr-23 pointer-fine:group-focus-within:pr-23'
          : 'pointer-fine:group-hover:pr-30.5 pointer-fine:group-focus-within:pr-30.5';
  const showPrBadge = lastKnownPrStatus !== undefined && !isDone;
  const prColorClass = lastKnownPrStatus
    ? prStatusColorClass(lastKnownPrStatus)
    : 'fg-secondary';
  const prLabel =
    lastKnownPrStatus?.label ??
    (lastKnownPrStatus !== undefined ? 'PR' : undefined);
  const prIconKind = lastKnownPrStatus
    ? prStatusIconKind(lastKnownPrStatus)
    : 'pull-request';
  const PrStatusIcon = PR_STATUS_ICONS[prIconKind];
  const isPrApproved = lastKnownPrStatus?.reviewStatus === 'approved';
  // A queued PR swaps the approval check for the merge queue glyph: it is
  // past approval, and "not ready to merge" would misdescribe it.
  const showClassicMergeQueueIcon =
    lastKnownPrStatus !== undefined &&
    lastKnownPrStatus.hasConflicts !== true &&
    isPrStatusInMergeQueue(lastKnownPrStatus);
  const showClassicApprovalIcon =
    isPrApproved &&
    lastKnownPrStatus?.state === 'open' &&
    !showClassicMergeQueueIcon;
  const pipelineDisclosureEnabled =
    onPipelineIconMouseEnter !== undefined ||
    onPipelineIconClick !== undefined ||
    onPipelineIconKeyDown !== undefined ||
    pipelinePopoverSlot !== undefined;
  const pipelineDisclosure = pipelineDisclosureEnabled
    ? {
        expanded: Boolean(pipelinePopoverSlot),
        listId: pipelinePopoverListId,
      }
    : undefined;
  // A badge names its host popover while it shows; `popoverSlots` gives each
  // popover the matching id.
  const popoverIdBase = useId();
  const popoverId = (kind: string): string => `${popoverIdBase}${kind}`;
  const describedByPopover = (
    slot: ReactNode,
    kind: string,
  ): string | undefined => (isValidElement(slot) ? popoverId(kind) : undefined);
  const popoverSlots = (
    <>
      {pipelinePopoverSlot}
      {withPopoverId(terminalPopoverSlot, popoverId('terminal'))}
      {withPopoverId(scriptPopoverSlot, popoverId('script'))}
      {withPopoverId(hookPopoverSlot, popoverId('hook'))}
      {withPopoverId(approvalPopoverSlot, popoverId('approval'))}
      {withPopoverId(unreadPopoverSlot, popoverId('unread'))}
      {withPopoverId(toolApprovalPopoverSlot, popoverId('tool-approval'))}
      {withPopoverId(watcherPopoverSlot, popoverId('watcher'))}
      {withPopoverId(scheduledMessagesPopoverSlot, popoverId('scheduled'))}
    </>
  );
  const pipelineHost: RowStatusBadgeHostHandlers = {
    onMouseEnter: onPipelineIconMouseEnter,
    onMouseLeave: onPipelineIconMouseLeave,
    onFocus: onPipelineIconFocus,
    onBlur: onPipelineIconBlur,
    onClick: onPipelineIconClick,
    onKeyDown: onPipelineIconKeyDown,
  };
  const terminalBadge = {
    host: {
      onMouseEnter: onTerminalIconMouseEnter,
      onMouseLeave: onTerminalIconMouseLeave,
      onFocus: onTerminalIconFocus,
      onBlur: onTerminalIconBlur,
      onKeyDown: onTerminalIconKeyDown,
    },
    describedBy: describedByPopover(terminalPopoverSlot, 'terminal'),
  };
  const scriptBadge = {
    host: {
      onMouseEnter: onScriptIconMouseEnter,
      onMouseLeave: onScriptIconMouseLeave,
      onFocus: onScriptIconFocus,
      onBlur: onScriptIconBlur,
      onKeyDown: onScriptIconKeyDown,
    },
    describedBy: describedByPopover(scriptPopoverSlot, 'script'),
  };
  const hookBadge = {
    host: {
      onMouseEnter: onHookIconMouseEnter,
      onMouseLeave: onHookIconMouseLeave,
      onFocus: onHookIconFocus,
      onBlur: onHookIconBlur,
      onKeyDown: onHookIconKeyDown,
    },
    describedBy: describedByPopover(hookPopoverSlot, 'hook'),
  };
  const approvalBadge = {
    host: {
      onMouseEnter: onApprovalIconMouseEnter,
      onMouseLeave: onApprovalIconMouseLeave,
      onFocus: onApprovalIconFocus,
      onBlur: onApprovalIconBlur,
      onKeyDown: onApprovalIconKeyDown,
    },
    describedBy: describedByPopover(approvalPopoverSlot, 'approval'),
  };
  const toolApprovalBadge = {
    host: {
      onMouseEnter: onToolApprovalIconMouseEnter,
      onMouseLeave: onToolApprovalIconMouseLeave,
      onFocus: onToolApprovalIconFocus,
      onBlur: onToolApprovalIconBlur,
      onKeyDown: onToolApprovalIconKeyDown,
    },
    describedBy: describedByPopover(toolApprovalPopoverSlot, 'tool-approval'),
  };
  const unreadBadge = {
    host: {
      onMouseEnter: onUnreadIconMouseEnter,
      onMouseLeave: onUnreadIconMouseLeave,
      onFocus: onUnreadIconFocus,
      onBlur: onUnreadIconBlur,
      onKeyDown: onUnreadIconKeyDown,
    },
    describedBy: describedByPopover(unreadPopoverSlot, 'unread'),
  };
  const watcherBadge = {
    host: {
      onMouseEnter: onWatcherIconMouseEnter,
      onMouseLeave: onWatcherIconMouseLeave,
      onFocus: onWatcherIconFocus,
      onBlur: onWatcherIconBlur,
      onKeyDown: onWatcherIconKeyDown,
    },
    describedBy: describedByPopover(watcherPopoverSlot, 'watcher'),
  };
  const scheduledBadge = {
    host: {
      onMouseEnter: onScheduledMessagesIconMouseEnter,
      onMouseLeave: onScheduledMessagesIconMouseLeave,
      onFocus: onScheduledMessagesIconFocus,
      onBlur: onScheduledMessagesIconBlur,
      onKeyDown: onScheduledMessagesIconKeyDown,
    },
    describedBy: describedByPopover(scheduledMessagesPopoverSlot, 'scheduled'),
  };
  const leadingMetadataIndicator = showHealthWarning ? (
    withStatusTooltip(
      healthIssue?.reason ?? 'Worktree issue',
      <button
        type="button"
        onClick={onWarningClick}
        className={`focus-ring inline-flex h-4 w-4 shrink-0 items-center justify-center rounded fg-warning ${HEALTH_WARNING_COARSE_HIT_AREA}`}
        aria-label="Worktree issue - click for details"
      >
        <WarningIcon size="xs" />
      </button>,
    )
  ) : showPrBadge ? (
    <span
      className={`shrink-0 rounded-sm ${prColorClass}`}
      role="img"
      aria-label={prStatusAriaLabel(lastKnownPrStatus)}
      data-testid={withTestIdSuffix('worktree-row-pr-icon', testIdSuffix)}
      data-pr-icon={prIconKind}
    >
      <PrStatusIcon size={16} />
    </span>
  ) : pipelineStatus ? (
    <RowStatusBadge
      label={pipelineStatusAriaLabel(pipelineStatus)}
      className="shrink-0 rounded-sm"
      testId={withTestIdSuffix('worktree-row-pipeline-badge', testIdSuffix)}
      host={pipelineHost}
      disclosure={pipelineDisclosure}
    >
      <PipelineIcon size={16} />
    </RowStatusBadge>
  ) : terminalStatus ? (
    <RowStatusBadge
      label={terminalStatusAriaLabel(terminalStatus)}
      className="shrink-0 rounded-sm"
      testId={withTestIdSuffix('worktree-row-terminal-badge', testIdSuffix)}
      {...terminalBadge}
    >
      <TerminalIcon size={16} />
    </RowStatusBadge>
  ) : scriptStatus ? (
    <RowStatusBadge
      label={scriptStatusAriaLabel()}
      className="shrink-0 rounded-sm"
      testId={withTestIdSuffix('worktree-row-script-badge', testIdSuffix)}
      {...scriptBadge}
    >
      <RocketLaunchIcon size={16} />
    </RowStatusBadge>
  ) : hookStatus ? (
    <RowStatusBadge
      label={hookStatusAriaLabel()}
      className="shrink-0 rounded-sm"
      testId={withTestIdSuffix('worktree-row-hook-badge', testIdSuffix)}
      {...hookBadge}
    >
      <HookIcon size={16} />
    </RowStatusBadge>
  ) : splitStatus ? (
    <RowStatusBadge
      label={splitStatusAriaLabel(splitStatus)}
      className="shrink-0 rounded-sm"
      testId={withTestIdSuffix('worktree-row-split-badge', testIdSuffix)}
      data={{ 'data-split-status': splitStatus }}
      tooltip={
        <SplitStatusTooltip
          status={splitStatus}
          message={splitStatusMessage}
          textScale={textScale}
        />
      }
    >
      <SplitPrIcon size={16} />
    </RowStatusBadge>
  ) : graphBuildStatus === 'building' ? (
    <RowStatusBadge
      label="Updating project graph…"
      className="shrink-0 rounded-sm"
      testId={withTestIdSuffix('worktree-row-graph-badge', testIdSuffix)}
      tooltip={GRAPH_TOOLTIP}
    >
      <GraphIcon size={16} />
    </RowStatusBadge>
  ) : null;

  const prNeedsAttention =
    showPrBadge &&
    (lastKnownPrStatus?.checkStatus === 'failing' ||
      lastKnownPrStatus?.reviewStatus === 'changes_requested' ||
      lastKnownPrStatus?.hasConflicts === true);
  const rightStatusIndicator =
    hasPendingQuestion && !isDone ? (
      // A pending question outranks the streaming loader: question chats are
      // excluded from streaming derivation, so isStreaming means a DIFFERENT
      // tab is working while this one still needs the user.
      <OperationalStatusDot
        label="Question waiting"
        tone="attention"
        testId="worktree-row-question"
        {...unreadBadge}
      />
    ) : hasPendingToolApproval && !isDone ? (
      // Same reasoning as the question above: an approval-blocked chat is
      // parked on the user, so the loader would misreport it as healthy.
      <OperationalStatusDot
        label="Approval needed"
        tone="attention"
        testId="worktree-row-tool-approval"
        {...toolApprovalBadge}
      />
    ) : isStreaming ? (
      <OperationalStatusLoader label="Working">
        <ThinkingSpinner tone="accent" />
      </OperationalStatusLoader>
    ) : isRunningRun ? (
      (runStatusSlot ?? (
        <OperationalStatusLoader label="Running">
          <RunSpinner />
        </OperationalStatusLoader>
      ))
    ) : prMergingSlot !== undefined && showPrBadge ? (
      prMergingSlot
    ) : isCreatingPr ? (
      (prCreatingSlot ?? (
        <OperationalStatusLoader label="Creating pull request" />
      ))
    ) : isRunningSetup || isTearingDown || isPendingGitSetup ? (
      <WorktreeRowPrimaryIndicator
        testIdSuffix={testIdSuffix}
        uiStatus={uiStatus}
        setupPhase={setupPhase}
        doneLabel={doneLabel}
        merged={lastKnownPrStatus?.state === 'merged'}
      />
    ) : pipelineStatus === 'running' ? (
      <OperationalStatusLoader
        label={pipelineStatusAriaLabel(pipelineStatus)}
      />
    ) : terminalStatus === 'running' ? (
      <OperationalStatusLoader
        label={terminalStatusAriaLabel(terminalStatus)}
      />
    ) : scriptStatus === 'running' ? (
      <OperationalStatusLoader label={scriptStatusAriaLabel()} />
    ) : hookStatus === 'running' ? (
      <OperationalStatusLoader label={hookStatusAriaLabel()} />
    ) : graphBuildStatus === 'building' ? (
      <OperationalStatusLoader label="Updating project graph" />
    ) : splitStatus === 'active' ? (
      <OperationalStatusLoader label={splitStatusAriaLabel(splitStatus)} />
    ) : isDiscovering ? (
      <OperationalStatusLoader label="Discovering environment" />
    ) : awaitingApproval && !isDone ? (
      <OperationalStatusDot
        label="Review plan"
        tone="unread"
        testId="worktree-row-awaiting-approval"
        {...approvalBadge}
      />
    ) : hasUnread && !isDone ? (
      <OperationalStatusDot
        label="Unread messages"
        tone="unread"
        testId="worktree-row-unread"
        {...unreadBadge}
      />
    ) : hasIdleWatcherChats && !isDone ? (
      <WatcherStatusIndicator testIdSuffix={testIdSuffix} {...watcherBadge} />
    ) : hasScheduledMessages && !isDone ? (
      <OperationalStatusDot
        label="Scheduled messages"
        tone="unread"
        testId="worktree-row-scheduled-messages"
        {...scheduledBadge}
      />
    ) : showHealthWarning ? (
      <OperationalStatusDot
        label={healthIssue?.reason ?? 'Worktree issue'}
        tone="danger"
      />
    ) : pipelineStatus === 'unseen-failure' ? (
      <OperationalStatusDot
        label={pipelineStatusAriaLabel(pipelineStatus)}
        tone="danger"
      />
    ) : pipelineStatus === 'unseen' ? (
      <OperationalStatusDot
        label={pipelineStatusAriaLabel(pipelineStatus)}
        tone="unread"
      />
    ) : pipelineStatus === 'paused' ? (
      <OperationalStatusDot
        label={pipelineStatusAriaLabel(pipelineStatus)}
        tone="filter"
      />
    ) : terminalStatus === 'unseen-failure' ? (
      <OperationalStatusDot
        label={terminalStatusAriaLabel(terminalStatus)}
        tone="danger"
      />
    ) : terminalStatus === 'unseen' ? (
      <OperationalStatusDot
        label={terminalStatusAriaLabel(terminalStatus)}
        tone="unread"
      />
    ) : splitStatus === 'review' || splitStatus === 'done' ? (
      <OperationalStatusDot
        label={splitStatusAriaLabel(splitStatus)}
        tone="unread"
      />
    ) : prNeedsAttention ? (
      <OperationalStatusDot
        label="Pull request needs attention"
        tone="danger"
      />
    ) : showPrBadge && lastKnownPrStatus?.ciStatus === 'pending' ? (
      <OperationalStatusLoader label="Pull request checks running" />
    ) : backgroundTasks > 0 ? (
      <AgentStateGlyph state="background" backgroundTasks={backgroundTasks} />
    ) : uiStatus !== 'idle' ? (
      <WorktreeRowPrimaryIndicator
        testIdSuffix={testIdSuffix}
        uiStatus={uiStatus}
        setupPhase={setupPhase}
        doneLabel={doneLabel}
        merged={lastKnownPrStatus?.state === 'merged'}
      />
    ) : null;
  const hasRightStatusIndicator = rightStatusIndicator !== null;
  const hasAlwaysVisibleActionChip =
    isListMode && actionChipAlwaysVisible && actionChipSlot !== undefined;
  const renderRightStatusIndicator =
    hasRightStatusIndicator && !hasAlwaysVisibleActionChip;

  // First match wins. Lifecycle phases come first; then a question or tool
  // approval, which outrank work in progress exactly as the status rail's
  // dot does, so the label never names a different state than the dot.
  const specialStatusLabel = (
    [
      [isTearingDown, isArchiving ? 'Archiving' : 'Running teardown'],
      [isRunningSetup, setupLabel],
      [isPendingGitSetup, 'Setting up'],
      [hasPendingQuestion && !isDone, 'Question waiting'],
      [hasPendingToolApproval && !isDone, 'Approval needed'],
      [isStreaming, 'Working'],
      [isRunningRun, 'Running'],
      [prMergingSlot !== undefined && showPrBadge, 'Merging PR'],
      [isCreatingPr, 'Creating PR'],
      [showHealthWarning, healthIssue?.reason ?? 'Worktree issue'],
      [
        pipelineStatus !== undefined,
        pipelineStatus && pipelineStatusAriaLabel(pipelineStatus),
      ],
      [
        terminalStatus !== undefined,
        terminalStatus && terminalStatusAriaLabel(terminalStatus),
      ],
      [scriptStatus !== undefined, scriptStatusAriaLabel()],
      [hookStatus !== undefined, hookStatusAriaLabel()],
      [graphBuildStatus === 'building', 'Updating project graph'],
      [
        splitStatus !== undefined,
        splitStatusMessage ??
          (splitStatus && splitStatusAriaLabel(splitStatus)),
      ],
      [awaitingApproval && !isDone, 'Awaiting approval'],
      [hasUnread && !isDone, 'Unread'],
      [hasIdleWatcherChats && !isDone, 'Watchers'],
      [hasScheduledMessages && !isDone, 'Scheduled'],
      [isDiscovering, 'Discovering'],
      [isDone, doneLabel],
      [prNeedsAttention, 'Needs attention'],
      [showPrBadge && isPrApproved, 'Approved'],
      [
        showPrBadge && lastKnownPrStatus?.ciStatus === 'pending',
        'Checks running',
      ],
      [uiStatus !== 'idle', statusDotTokens(uiStatus).label],
    ] satisfies ReadonlyArray<readonly [boolean, string | undefined]>
  ).find(([applies]) => applies)?.[1];
  const inlineDepthBadge =
    depthBadge &&
    nestedChildDepth === undefined &&
    leadingMetadataIndicator === null ? (
      <DepthBadgeTrigger
        badge={depthBadge}
        value={depthBadge.depth}
        textScale={textScale}
        testId="worktree-row-depth-badge"
      />
    ) : null;
  const nestedChildIndicator =
    nestedChildDepth !== undefined ? (
      depthBadge ? (
        <DepthBadgeTrigger
          badge={depthBadge}
          value={nestedChildDepth}
          textScale={textScale}
          testId="worktree-row-nested-child-depth"
        />
      ) : (
        <span
          data-testid={withTestIdSuffix(
            'worktree-row-nested-child-depth',
            testIdSuffix,
          )}
        >
          {nestedChildDepth}
        </span>
      )
    ) : null;
  // Persistent metadata, not an activity subject: it never enters the
  // leading-icon priority chain, so a shared worktree still shows its live
  // status glyph.
  //
  // Two placements, one component. The classic sidebar row puts it at the
  // trailing edge of the title line — the same slot the Cowork row uses, so
  // the two row types read alike — and fades it out while that row reveals
  // its hover actions over those pixels. The kanban/card path has different
  // rail geometry and keeps it on the subtitle line beside the PR badge,
  // where nothing is revealed on top of it.
  const sharedTitleBadge = sharedWithTeammates ? (
    <SharedWithTeammatesBadge fadeOnRowHover testIdSuffix={testIdSuffix} />
  ) : null;
  const sharedSubtitleBadge = sharedWithTeammates ? (
    <SharedWithTeammatesBadge testIdSuffix={testIdSuffix} />
  ) : null;
  const prSubtitleBadge =
    showPrBadge && prLabel !== undefined && lastKnownPrStatus !== undefined ? (
      <RichHoverTooltip
        surfaceClassName="min-w-65 max-w-85"
        surfacePadding="card"
        preferRightPlacement
        content={
          <PrBadgeTooltipContent pr={lastKnownPrStatus} textScale={textScale} />
        }
      >
        {lastKnownPrStatus.url ? (
          <a
            href={lastKnownPrStatus.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex items-center whitespace-nowrap text-2xs font-normal leading-4"
            data-testid={withTestIdSuffix(
              'worktree-row-pr-badge',
              testIdSuffix,
            )}
          >
            <PrBadgeContent label={prLabel} testIdSuffix={testIdSuffix} />
          </a>
        ) : (
          <span
            className="inline-flex items-center whitespace-nowrap text-2xs font-normal leading-4"
            data-testid={withTestIdSuffix(
              'worktree-row-pr-badge',
              testIdSuffix,
            )}
          >
            <PrBadgeContent label={prLabel} testIdSuffix={testIdSuffix} />
          </span>
        )}
      </RichHoverTooltip>
    ) : null;
  const subtitleMetadata =
    prSubtitleBadge !== null || sharedSubtitleBadge !== null ? (
      <>
        {prSubtitleBadge}
        {sharedSubtitleBadge}
      </>
    ) : null;
  const trailingDiffMetadata =
    isListMode &&
    hasLineChanges &&
    !isDone &&
    (!showPrBadge || isClassicSidebar) &&
    diffStats ? (
      <span
        data-testid={withTestIdSuffix(
          'worktree-row-trailing-diff',
          testIdSuffix,
        )}
        // Stays visible on hover: the +x/−x counters live on the subtitle
        // line, which the hover action chips never cover. 3px inset from the
        // row edge.
        className="pointer-events-auto ml-auto inline-flex shrink-0 pr-0.75"
      >
        {/* Condensed: the sidebar rail is narrow and the subtitle line already
            competes with the branch label, so large counts collapse to
            `1k`/`1M`/`1B` and expose their exact totals on hover. */}
        <DiffStatsBadge
          stats={diffStats}
          variant={diffStatsStyle === 'short' ? 'condensed' : 'default'}
          tone={focusedStatus ? 'plain' : 'semantic'}
        />
      </span>
    ) : null;
  // Focused rows keep the line changes beside the worktree name instead of
  // pinning them to the row edge, so they read as part of the identity line.
  const focusedDiffMetadata =
    focusedStatus && hasLineChanges && !isDone && diffStats ? (
      <span
        data-testid={withTestIdSuffix(
          'worktree-row-subtitle-diff',
          testIdSuffix,
        )}
        className="ml-1.5 inline-flex"
      >
        <DiffStatsBadge
          stats={diffStats}
          variant={diffStatsStyle === 'short' ? 'condensed' : 'default'}
        />
      </span>
    ) : null;
  // `null` is the host's explicit "this row has no identity line" — a repoless
  // chat row, whose id is an unreadable `cloud:task:<uuid>` and which has no
  // branch, PR, or diff to put there instead. `undefined` still means "not
  // supplied", which falls back to the raw id exactly as before.
  // The hover card shows the full title, branch, and worktree id, so a row
  // with one leaves its text without the OS tooltip.
  const nativeTitles = hoverPreview === undefined;
  const worktreeIdentity =
    worktreeIdSlot === null
      ? null
      : (worktreeIdSlot ?? (worktreeId !== undefined ? worktreeId : null));
  const subtitleBody =
    specialStatusLabel === 'Question waiting' ? (
      // Kanban cards (and other non-list rows) have no indicator rail, so the
      // pending-question state carries its orange dot inline with the label.
      <span
        className="inline-flex items-center gap-1"
        data-testid={withTestIdSuffix(
          'worktree-row-question-label',
          testIdSuffix,
        )}
      >
        <Dot tone="attention" />
        {specialStatusLabel}
      </span>
    ) : (
      (specialStatusLabel ??
      (worktreeIdentity !== null && worktreeIdentity !== undefined ? (
        <>
          {nestedChildDepth !== undefined && <>{nestedChildIndicator} · </>}
          <span className={REPLAY_MASK_CLASS}>{worktreeIdentity}</span>
        </>
      ) : null))
    );
  const subtitleContent =
    inlineDepthBadge !== null ? (
      <>
        {inlineDepthBadge}
        {subtitleBody !== null && subtitleBody !== undefined && <> · </>}
        {subtitleBody}
      </>
    ) : (
      subtitleBody
    );

  const prMetadataColor =
    lastKnownPrStatus === undefined
      ? ''
      : focusedStatus
        ? focusedPrStatusColor(lastKnownPrStatus)
        : classicPrStatusColor(lastKnownPrStatus);
  const classicPrMetadata =
    isClassicSidebar &&
    showPrBadge &&
    prLabel !== undefined &&
    lastKnownPrStatus !== undefined ? (
      <RichHoverTooltip
        surfaceClassName="min-w-65 max-w-85"
        surfacePadding="card"
        preferRightPlacement
        content={
          <PrBadgeTooltipContent pr={lastKnownPrStatus} textScale={textScale} />
        }
      >
        {lastKnownPrStatus.url ? (
          <a
            href={lastKnownPrStatus.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className={`inline-flex h-4 items-center gap-1 whitespace-nowrap rounded px-0.5 align-bottom font-normal leading-4 transition-colors ${prMetadataColor}`}
            data-testid={withTestIdSuffix(
              'worktree-row-pr-badge',
              testIdSuffix,
            )}
          >
            <span
              data-testid={withTestIdSuffix(
                'worktree-row-pr-label',
                testIdSuffix,
              )}
            >
              {prLabel}
            </span>
            {showClassicMergeQueueIcon && (
              <ClassicMergeQueueIcon
                status={lastKnownPrStatus}
                testIdSuffix={testIdSuffix}
              />
            )}
            {showClassicApprovalIcon && (
              <ClassicApprovedReviewIcon
                testIdSuffix={testIdSuffix}
                plain={focusedStatus}
                isMergeReady={lastKnownPrStatus.isMergeReady === true}
                hasUnresolvedComments={
                  (lastKnownPrStatus.unresolvedCommentCount ?? 0) > 0
                }
              />
            )}
          </a>
        ) : (
          <span
            className={`inline-flex h-4 items-center gap-1 whitespace-nowrap align-bottom font-normal leading-4 ${prMetadataColor}`}
            data-testid={withTestIdSuffix(
              'worktree-row-pr-badge',
              testIdSuffix,
            )}
          >
            <span
              data-testid={withTestIdSuffix(
                'worktree-row-pr-label',
                testIdSuffix,
              )}
            >
              {prLabel}
            </span>
            {showClassicMergeQueueIcon && (
              <ClassicMergeQueueIcon
                status={lastKnownPrStatus}
                testIdSuffix={testIdSuffix}
              />
            )}
            {showClassicApprovalIcon && (
              <ClassicApprovedReviewIcon
                testIdSuffix={testIdSuffix}
                plain={focusedStatus}
                isMergeReady={lastKnownPrStatus.isMergeReady === true}
                hasUnresolvedComments={
                  (lastKnownPrStatus.unresolvedCommentCount ?? 0) > 0
                }
              />
            )}
          </span>
        )}
      </RichHoverTooltip>
    ) : null;

  if (isClassicSidebar) {
    // Setup-phase loaders keep priority: while the worktree itself is being
    // created or torn down, chat states cannot meaningfully exist yet, so
    // the lifecycle spinner is the only trailing indicator.
    const classicHasSetupLoader =
      isPendingGitSetup || isRunningSetup || isTearingDown;
    // The live spinner covers chat streaming AND generic non-pipeline working
    // (portal `busy` / `isRunningRun`): the pipeline glyph below is reserved
    // for an actually running pipeline. Done does not mute it — a completed
    // row with a chat still streaming keeps the working spinner.
    const classicStreamingSpinner =
      !classicHasSetupLoader &&
      (isStreaming || (uiStatus === 'working' && pipelineStatus !== 'running'));
    // Background work alone draws the neutral spinner in the same slot.
    const classicBackgroundSpinner =
      !classicHasSetupLoader && !classicStreamingSpinner && backgroundTasks > 0;
    // Classic has no unread subtitle badge; the blue unread dot itself hosts
    // the chat-preview popover (hover/focus), so the wrapper around the
    // indicator + drag overlay becomes the interactive target.
    // LEADING (glyphs) and TRAILING (loader/dot) are independent slots and
    // may show simultaneously — a paused pipeline glyph next to an unread
    // dot, the plan shield next to the question dot, and so on. Each side
    // keys off its own facts rather than the winner-takes-all uiStatus, so
    // the two slots never fight.
    //
    // The working spinner coexists with ONE attention dot, picked by
    // priority: needs-input (question, orange) > pipeline failure (red) >
    // unread chat (blue) > unseen pipeline success (blue). Lower-priority
    // states defer to the dot's tooltip/popover and, for pipeline results,
    // to the state-colored leading glyph.
    const classicAttentionDot = classicHasSetupLoader
      ? null
      : hasPendingQuestion
        ? 'question'
        : hasPendingToolApproval
          ? 'tool-approval'
          : pipelineStatus === 'unseen-failure'
            ? 'pipeline'
            : hasUnread
              ? 'unread'
              : pipelineStatus === 'unseen'
                ? 'pipeline'
                : null;
    const classicUnreadPreviewDot = classicAttentionDot === 'unread';
    const classicToolApprovalDot = classicAttentionDot === 'tool-approval';
    const classicPipelineAttentionDot = classicAttentionDot === 'pipeline';
    // Leading pipeline glyphs key off the pipeline state alone — done no
    // longer gates them; the checkmark is only the fallback when nothing
    // else claims the slot. Unseen results also show the glyph — it names
    // the source of the trailing severity dot and hosts the pipeline
    // popover.
    const classicWorkingPipeline = pipelineStatus === 'running';
    const classicPausedPipelineShield = pipelineStatus === 'paused';
    const classicPipelineAttentionGlyph =
      pipelineStatus === 'unseen' || pipelineStatus === 'unseen-failure';
    // Awaiting plan approval outranks the pipeline glyphs in the leading
    // slot (chain order below).
    const classicApprovalShield = awaitingApproval;
    const classicQuestionDot = classicAttentionDot === 'question';
    // A pending question also names the leading slot with the question-mark
    // glyph — outranked only by the plan-review shield, and outranking the
    // pipeline glyphs (a turn blocked on the user is more actionable than a
    // running pipeline). The trailing orange dot keeps carrying the state.
    const classicQuestionGlyph = classicQuestionDot;
    const classicPlanningLabel = awaitingApproval
      ? 'Review plan'
      : pipelineStatus === 'paused'
        ? 'Workflow paused'
        : 'Planning';
    // The leading slot shows only glyph states (shield, pipeline glyphs,
    // done check, setup loaders); the working spinner and the attention dots
    // (question, unread, pipeline results) render at the RIGHT end of the
    // label line instead. Dot-bearing uiStatuses therefore resolve to the
    // idle placeholder on the left.
    const classicLeadingUiStatus =
      uiStatus === 'unread' || uiStatus === 'working' ? 'idle' : uiStatus;
    // Fallback leading subjects: when nothing higher claims the slot
    // (pipeline glyphs, question, plan shield, planning), the top-priority
    // remaining subject icon is promoted out of the subtitle. Every subject
    // is promotable; the full chain is: pipeline paused > pipeline result
    // (unseen) > pipeline running > question > plan review > planning >
    // split PR > watchers > scheduled > script > hook > terminal > code
    // graph > done check. Done is the final fallback — the checkmark only
    // shows when no other subject is active. The promoted subject's
    // subtitle badge is suppressed; overlapping lower subjects keep theirs.
    const classicLeadingFallback:
      | 'split'
      | 'watchers'
      | 'scheduled'
      | 'script'
      | 'hook'
      | 'terminal'
      | 'graph'
      | null =
      classicApprovalShield ||
      classicQuestionGlyph ||
      classicPausedPipelineShield ||
      classicPipelineAttentionGlyph ||
      classicWorkingPipeline ||
      classicLeadingUiStatus === 'planning'
        ? null
        : splitStatus !== undefined
          ? 'split'
          : hasIdleWatcherChats
            ? 'watchers'
            : hasScheduledMessages
              ? 'scheduled'
              : scriptStatus === 'running'
                ? 'script'
                : hookStatus === 'running'
                  ? 'hook'
                  : terminalStatus !== undefined
                    ? 'terminal'
                    : graphBuildStatus === 'building'
                      ? 'graph'
                      : null;
    const classicIndicator = (
      <WorktreeRowPrimaryIndicator
        testIdSuffix={testIdSuffix}
        uiStatus={classicLeadingUiStatus}
        // Setup-phase loaders render in the trailing slot with the other
        // spinners; the leading indicator never shows them.
        setupPhase={undefined}
        doneLabel={doneLabel}
        merged={lastKnownPrStatus?.state === 'merged'}
        planningLabel={classicPlanningLabel}
        layout="classic"
      />
    );
    // Setup/teardown loaders share the trailing slot and keep priority over
    // every other trailing status, mirroring the old leading-slot rule.
    const classicSetupStatusTitle = isTearingDown
      ? isArchiving
        ? 'Archiving worktree…'
        : 'Deleting worktree…'
      : isRunningSetup
        ? `${setupLabel}…`
        : isPendingGitSetup
          ? 'Setting up worktree (git operations in progress)'
          : null;
    // Right-side status: the working spinner and the attention dot render
    // at the end of the label line (inside the hover-padding reserve, so
    // they shift left with the title when the action chips appear and their
    // hover popovers stay reachable). Every slot shares the action-button
    // 24px slot (gap-0.5) and the row reserves 28px per hover action button, so the cluster lines up with the
    // hover action column; the dot keeps the anchor (right-most) slot.
    const classicSystemStatus =
      focusedStatus ? null : classicSetupStatusTitle ? (
        withStatusTooltip(
          classicSetupStatusTitle,
          <span
            className="inline-flex h-5 w-6 shrink-0 items-center justify-center"
            aria-label={classicSetupStatusTitle}
          >
            <span className="inline-flex h-3 w-3 items-center justify-center">
              <LoadingSpinner tone="accent" />
            </span>
          </span>,
        )
      ) : classicStreamingSpinner ||
        classicBackgroundSpinner ||
        classicAttentionDot !== null ? (
        <>
          {classicBackgroundSpinner && (
            <AgentStateGlyph
              state="background"
              backgroundTasks={backgroundTasks}
              slot="row"
              testId={withTestIdSuffix(
                'worktree-row-classic-background-spinner',
                testIdSuffix,
              )}
            />
          )}
          {classicStreamingSpinner &&
            withStatusTooltip(
              'Working',
              <span
                className="inline-flex h-5 w-6 shrink-0 items-center justify-center"
                aria-label="Working"
                data-testid={withTestIdSuffix(
                  'worktree-row-classic-streaming-spinner',
                  testIdSuffix,
                )}
              >
                <span className="inline-flex h-3 w-3 items-center justify-center">
                  <ThinkingSpinner tone="accent" />
                </span>
              </span>,
            )}
          {classicQuestionDot && (
            <RowStatusBadge
              label="Question waiting"
              className={CLASSIC_TRAILING_DOT_CLASS}
              testId={withTestIdSuffix('worktree-row-question', testIdSuffix)}
              {...unreadBadge}
            >
              <Dot tone="attention" />
            </RowStatusBadge>
          )}
          {classicToolApprovalDot && (
            <RowStatusBadge
              label="Approval needed"
              className={CLASSIC_TRAILING_DOT_CLASS}
              testId={withTestIdSuffix(
                'worktree-row-tool-approval',
                testIdSuffix,
              )}
              {...toolApprovalBadge}
            >
              <Dot tone="attention" />
            </RowStatusBadge>
          )}
          {classicUnreadPreviewDot && (
            <RowStatusBadge
              label="Unread messages"
              className={CLASSIC_TRAILING_DOT_CLASS}
              testId={withTestIdSuffix('worktree-row-unread', testIdSuffix)}
              {...unreadBadge}
            >
              <Dot tone="unread" />
            </RowStatusBadge>
          )}
          {classicPipelineAttentionDot && (
            <RowStatusBadge
              label={pipelineStatusAriaLabel(pipelineStatus ?? 'unseen')}
              className={CLASSIC_TRAILING_DOT_CLASS}
              testId={withTestIdSuffix(
                'worktree-row-pipeline-attention',
                testIdSuffix,
              )}
              host={pipelineHost}
              disclosure={pipelineDisclosure}
            >
              {/* Failure paints destructive (matching the leading glyph);
                  a successful unseen run keeps the calm blue. */}
              <Dot
                tone={pipelineStatus === 'unseen-failure' ? 'danger' : 'unread'}
              />
            </RowStatusBadge>
          )}
        </>
      ) : null;
    const classicTrailingStatus =
      statusSlot != null || classicSystemStatus !== null ? (
        <>
          {statusSlot}
          {classicSystemStatus}
        </>
      ) : null;
    const classicDragOverlay =
      dragHandleSlot != null && typeof dragHandleSlot !== 'boolean' ? (
        // Intentionally overlays the visible status indicator and captures its pointer events for dragging.
        <span
          className="absolute inset-0 inline-flex items-center justify-center"
          data-testid={withTestIdSuffix(
            'worktree-row-drag-overlay',
            testIdSuffix,
          )}
        >
          {dragHandleSlot}
        </span>
      ) : null;
    // Focused rows carry their whole status in one leading indicator, so the
    // trailing side is left to the age and the hover actions. Priority:
    // setup or teardown (loader), needs-you (orange: question > tool approval
    // > plan review > paused pipeline > split review), an unseen failure
    // (red), anything else running (loader), unread (blue), idle (grey).
    // Each state keeps the hover preview its classic glyph or dot hosted.
    const focusedNeedsInput: string | null = !focusedStatus
      ? null
      : hasPendingQuestion
        ? 'Question waiting'
        : hasPendingToolApproval
          ? 'Approval needed'
          : awaitingApproval
            ? 'Review plan'
            : pipelineStatus === 'paused'
              ? 'Workflow paused'
              : splitStatus === 'review'
                ? 'Split ready for review'
                : null;
    const focusedRunning =
      isStreaming ||
      uiStatus === 'working' ||
      pipelineStatus === 'running' ||
      splitStatus === 'active' ||
      hookStatusProp === 'running' ||
      graphBuildStatusProp === 'building' ||
      isCreatingPr;
    const focusedRowStatus:
      | 'needs-input'
      | 'failed'
      | 'working'
      | 'unread'
      | 'background'
      | 'idle'
      | null = !focusedStatus
      ? null
      : classicHasSetupLoader
        ? 'working'
        : focusedNeedsInput !== null
          ? 'needs-input'
          : pipelineStatus === 'unseen-failure'
            ? 'failed'
            : focusedRunning
              ? 'working'
              : hasUnread || pipelineStatus === 'unseen'
                ? 'unread'
                : // Below unread: a long-running server would hide it.
                  backgroundTasks > 0
                  ? 'background'
                  : 'idle';
    const focusedPipelineTarget =
      (focusedRowStatus === 'needs-input' &&
        focusedNeedsInput === 'Workflow paused') ||
      focusedRowStatus === 'failed' ||
      (focusedRowStatus === 'unread' && !hasUnread);
    const focusedBadge: {
      host?: RowStatusBadgeHostHandlers;
      describedBy?: string;
      tooltipFocusable?: boolean;
    } =
      focusedRowStatus === 'needs-input' &&
      focusedNeedsInput === 'Question waiting'
        ? unreadBadge
        : focusedRowStatus === 'needs-input' &&
            focusedNeedsInput === 'Approval needed'
          ? toolApprovalBadge
          : focusedRowStatus === 'needs-input' &&
              focusedNeedsInput === 'Review plan'
            ? approvalBadge
            : focusedPipelineTarget
              ? { host: pipelineHost }
              : focusedRowStatus === 'unread'
                ? unreadBadge
                : {
                    // A loader only reports progress; there is nothing to
                    // open, so it never takes a Tab stop.
                    tooltipFocusable:
                      focusedRowStatus !== 'working' &&
                      focusedRowStatus !== 'background',
                  };
    const focusedLabel =
      focusedRowStatus === 'needs-input'
        ? focusedNeedsInput
        : focusedRowStatus === 'failed'
          ? pipelineStatusAriaLabel('unseen-failure')
          : focusedRowStatus === 'working'
            ? (classicSetupStatusTitle ??
              (pipelineStatus === 'running' ? 'Workflow running' : 'Working'))
            : focusedRowStatus === 'unread'
              ? hasUnread
                ? 'Unread messages'
                : pipelineStatusAriaLabel('unseen')
              : focusedRowStatus === 'background'
                ? backgroundTasksLabel(backgroundTasks)
                : null;
    const focusedDotTone: DotTone =
      focusedRowStatus === 'needs-input'
        ? 'attention'
        : focusedRowStatus === 'failed'
          ? 'danger'
          : focusedRowStatus === 'unread'
            ? 'unread'
            : 'filter';
    const focusedGlyph =
      focusedRowStatus === 'working' || focusedRowStatus === 'background' ? (
        // Follows Labs → Comet spinners; the comet keeps its 12px slot.
        <ThinkingSpinner
          tone={focusedRowStatus === 'working' ? 'accent' : 'tertiary'}
          sizePx={12}
        />
      ) : (
        <Dot tone={focusedDotTone} />
      );
    const focusedIndicatorClassName =
      'relative inline-flex h-6 w-6 items-center justify-center rounded-sm';
    const focusedIndicator =
      focusedRowStatus === null ? null : focusedRowStatus === 'idle' ||
        focusedLabel === null ? (
        <span
          className={focusedIndicatorClassName}
          aria-hidden="true"
          data-testid={withTestIdSuffix('worktree-row-status', testIdSuffix)}
          data-row-status={focusedRowStatus}
        >
          {focusedGlyph}
          {classicDragOverlay}
        </span>
      ) : (
        <RowStatusBadge
          label={focusedLabel}
          className={focusedIndicatorClassName}
          testId={withTestIdSuffix('worktree-row-status', testIdSuffix)}
          data={{ 'data-row-status': focusedRowStatus }}
          disclosure={focusedPipelineTarget ? pipelineDisclosure : undefined}
          {...focusedBadge}
        >
          {focusedGlyph}
          {classicDragOverlay}
        </RowStatusBadge>
      );
    // Quiet cloud rows hide their identity subtitle. Retain the second line
    // only when it carries actual metadata, and keep popovers mounted below.
    const classicHasSubtitle = Boolean(
      worktreeIdentity != null ||
      (!focusedStatus && inlineDepthBadge != null) ||
      (!focusedStatus && nestedChildDepth !== undefined) ||
      showHealthWarning ||
      (terminalStatus && classicLeadingFallback !== 'terminal') ||
      (scriptStatus && classicLeadingFallback !== 'script') ||
      (hookStatus && classicLeadingFallback !== 'hook') ||
      (splitStatus && classicLeadingFallback !== 'split' && !focusedStatus) ||
      (graphBuildStatus === 'building' && classicLeadingFallback !== 'graph') ||
      (!focusedStatus && runStatusSlot) ||
      (hasIdleWatcherChats && classicLeadingFallback !== 'watchers') ||
      (hasScheduledMessages && classicLeadingFallback !== 'scheduled') ||
      isDiscovering ||
      splitStatusMessage ||
      isTearingDown ||
      isRunningSetup ||
      isPendingGitSetup ||
      creationFailure !== undefined ||
      queuedRemovalLabel !== null ||
      (!focusedStatus &&
        (isDone || classicPrMetadata || isCreatingPr || trailingDiffMetadata)),
    );
    // The trailing slot reflects the PR's actual state, independently of
    // worktree completion. It leaves with the age while hover actions appear.
    const focusedPinned = focusedStatus && pinnedToTop;
    const focusedClosed =
      focusedStatus && lastKnownPrStatus?.state === 'closed';
    const focusedMerged =
      focusedStatus && lastKnownPrStatus?.state === 'merged';
    const focusedDraft =
      focusedStatus && !focusedMerged && lastKnownPrStatus?.state === 'draft';
    const focusedPrConflicts =
      focusedStatus &&
      !focusedMerged &&
      lastKnownPrStatus?.state === 'open' &&
      lastKnownPrStatus.hasConflicts === true;
    // A queued PR is still pending the queue's checks, whatever its own CI
    // says. Conflicts outrank the queue, as in the classic badge.
    const focusedPrQueued =
      focusedStatus &&
      !focusedMerged &&
      lastKnownPrStatus !== undefined &&
      isPrStatusInMergeQueue(lastKnownPrStatus);
    const focusedMergeQueue =
      focusedPrQueued && lastKnownPrStatus?.hasConflicts !== true;
    // Use the same success rule as the preview, including review blockers
    // and authoritative CI status when the summary is stale.
    const focusedChecksPassing =
      focusedStatus && prHasSuccessIndicator(lastKnownPrStatus);
    const focusedOpenPr =
      focusedStatus &&
      !focusedMerged &&
      lastKnownPrStatus?.state === 'open' &&
      !focusedPrConflicts &&
      !focusedPrQueued &&
      !focusedChecksPassing;
    const hasTrailingMeta =
      classicTrailingStatus === null &&
      (focusedPinned ||
        focusedDraft ||
        focusedClosed ||
        focusedOpenPr ||
        focusedPrConflicts ||
        focusedMergeQueue ||
        focusedChecksPassing ||
        focusedMerged ||
        lastActivityAt !== undefined);
    const classicSingleLine = compact && !classicHasSubtitle;
    // Focused rows give the second line to a live status instead of the
    // branch. Work in progress shimmers; a split waiting on the user (or
    // finished) reads still.
    const focusedSubtitleStatus: { text: string; shimmer: boolean } | null =
      !focusedStatus
        ? null
        : isTearingDown
          ? {
              text: isArchiving ? 'Archiving…' : 'Running teardown…',
              shimmer: true,
            }
          : isRunningSetup
            ? { text: `${setupLabel}…`, shimmer: true }
            : isPendingGitSetup
              ? { text: 'Setting up…', shimmer: true }
              : queuedRemovalLabel
                ? { text: queuedRemovalLabel, shimmer: false }
                : splitStatusMessage
                  ? {
                      text: splitStatusMessage,
                      shimmer: splitStatus === 'active',
                    }
                  : null;
    return (
      <div
        ref={ref}
        data-testid={dataTestId}
        data-worktree-id={dataWorktreeId}
        data-project-id={dataProjectId}
        data-branch={dataBranch}
        data-display-mode={displayMode}
        data-multiselected={multiSelected || undefined}
        data-worktree-layout="classic"
        data-worktree-single-line={classicSingleLine || undefined}
        style={style}
        onClick={onClick}
        {...intentHandlers}
        onContextMenu={onContextMenu}
        onPointerDown={onDragPointerDown}
        className={`group group/sidebar-item relative w-full min-w-0 ${showsDragCursor ? (rowIsDragging ? 'pointer-fine:cursor-grabbing' : 'cursor-default pointer-fine:hover:cursor-grab') : onDragPointerDown ? 'cursor-default touch-none select-none' : nonSortableInteraction ? 'cursor-default select-none' : onClick ? 'cursor-pointer' : 'cursor-default'} rounded-row ${
          nested ? 'py-1.5 pl-4.5 pr-1.5' : 'px-1.5 py-1.5'
        } flex items-center gap-1.5 ${touchTarget ? 'min-h-11' : classicSingleLine ? 'min-h-9 pointer-coarse:min-h-11' : ''} ${rowIsDragging ? 'opacity-60' : ''} ${isTearingDownVisual ? 'pointer-events-none' : ''} ${highlightClassName ?? 'fg-secondary hover:bg-subtle has-[[data-row-menu-open]]:bg-subtle'}`}
      >
        <div
          // Only two-line rows lift the indicator to the title. Keep the
          // same horizontal slot in compact rows as status icons change.
          className={`flex w-5 shrink-0 ${classicSingleLine ? '' : '-translate-y-2.25'} items-center justify-center ${
            nested ? '-translate-x-3' : ''
          }`}
          data-testid={withTestIdSuffix(
            'worktree-row-leading-slot',
            testIdSuffix,
          )}
        >
          {multiSelect?.selectMode ? (
            <ChoiceMark
              kind="checkbox"
              checked={multiSelected}
              disabled={multiSelect.selectable === false}
            />
          ) : focusedIndicator !== null ? (
            focusedIndicator
          ) : classicPausedPipelineShield || classicPipelineAttentionGlyph ? (
            <RowStatusBadge
              label={pipelineStatusAriaLabel(pipelineStatus ?? 'paused')}
              className={CLASSIC_LEADING_GLYPH_CLASS}
              testId={
                classicPausedPipelineShield
                  ? 'worktree-row-paused-pipeline'
                  : 'worktree-row-pipeline-glyph'
              }
              host={pipelineHost}
              disclosure={pipelineDisclosure}
            >
              {/* The pipeline glyph carries its state in its color — paused
                  orange (waiting on input), completed green, failed red.
                  Pipeline states outrank the question/plan glyphs in the
                  finalized chain. This glyph also hosts the pipeline
                  popover, which stays mouse-reachable (the leading slot
                  does not hide on hover). */}
              <span
                className={`inline-flex h-4 w-4 items-center justify-center ${pipelineGlyphColorClass(pipelineStatus ?? 'paused')}`}
              >
                <PipelineIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : classicWorkingPipeline ? (
            <RowStatusBadge
              label="Workflow running"
              className={CLASSIC_LEADING_GLYPH_CLASS}
              host={pipelineHost}
              disclosure={pipelineDisclosure}
            >
              {/* Explicit glyph: dot-bearing uiStatuses resolve the shared
                  indicator to the idle placeholder now. */}
              <span
                // fg-secondary: the pipeline glyph keeps the neutral
                // sidebar-icon grey in classic rows; the running state
                // itself carries the activity signal.
                className="inline-flex h-4 w-4 items-center justify-center fg-secondary"
                data-testid={withTestIdSuffix(
                  'worktree-row-working-pipeline',
                  testIdSuffix,
                )}
              >
                <PipelineIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : classicQuestionGlyph ? (
            <RowStatusBadge
              label="Question waiting"
              className={CLASSIC_LEADING_GLYPH_CLASS}
              testId={withTestIdSuffix(
                'worktree-row-question-glyph',
                testIdSuffix,
              )}
              {...unreadBadge}
            >
              {/* Needs-input orange, matching the plan shield and the
                  trailing question dot. Hosts the chat-preview popover,
                  which stays mouse-reachable (the leading slot does not
                  hide on hover). */}
              <span className="inline-flex h-4 w-4 items-center justify-center fg-warning">
                <QuestionMarkIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : classicApprovalShield ? (
            <RowStatusBadge
              label="Review plan"
              className={CLASSIC_LEADING_GLYPH_CLASS}
              testId={withTestIdSuffix(
                'worktree-row-awaiting-approval',
                testIdSuffix,
              )}
              {...approvalBadge}
            >
              {/* Explicit shield: uiStatus may have been won by unread /
                  working, so the shared indicator cannot be reused here. */}
              <span className="inline-flex h-4 w-4 items-center justify-center fg-warning">
                <PlanMapIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : classicLeadingFallback === 'split' ? (
            <RowStatusBadge
              label={splitStatusAriaLabel(splitStatus ?? 'active')}
              className={`${CLASSIC_LEADING_GLYPH_CLASS} ${splitStatusColorClass(splitStatus ?? 'active')}`}
              testId={withTestIdSuffix(
                'worktree-row-split-badge',
                testIdSuffix,
              )}
              data={{ 'data-split-status': splitStatus }}
              tooltip={
                <SplitStatusTooltip
                  status={splitStatus ?? 'active'}
                  message={splitStatusMessage}
                  textScale={textScale}
                />
              }
            >
              <span className="inline-flex h-4 w-4 items-center justify-center">
                <SplitPrIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : classicLeadingFallback === 'watchers' ? (
            <RowStatusBadge
              label="Chats with watchers"
              className={CLASSIC_LEADING_GLYPH_CLASS}
              testId={withTestIdSuffix('worktree-row-watchers', testIdSuffix)}
              {...watcherBadge}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center fg-secondary">
                <AppAdvisorWatcherIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : classicLeadingFallback === 'scheduled' ? (
            <RowStatusBadge
              label="Scheduled messages"
              className={CLASSIC_LEADING_GLYPH_CLASS}
              testId={withTestIdSuffix(
                'worktree-row-scheduled-messages',
                testIdSuffix,
              )}
              {...scheduledBadge}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center fg-secondary">
                <TimeFliesIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : classicLeadingFallback === 'script' ? (
            <RowStatusBadge
              label={scriptStatusAriaLabel()}
              className={CLASSIC_LEADING_GLYPH_CLASS}
              testId={withTestIdSuffix(
                'worktree-row-script-badge',
                testIdSuffix,
              )}
              {...scriptBadge}
            >
              <span
                className={`inline-flex h-4 w-4 items-center justify-center ${OPERATIONAL_STATUS_COLORS.active.foreground}`}
              >
                <RocketLaunchIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : classicLeadingFallback === 'hook' ? (
            <RowStatusBadge
              label={hookStatusAriaLabel()}
              className={CLASSIC_LEADING_GLYPH_CLASS}
              testId={withTestIdSuffix('worktree-row-hook-badge', testIdSuffix)}
              {...hookBadge}
            >
              <span
                className={`inline-flex h-4 w-4 items-center justify-center ${OPERATIONAL_STATUS_COLORS.active.foreground}`}
              >
                <HookIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : classicLeadingFallback === 'terminal' ? (
            <RowStatusBadge
              label={terminalStatusAriaLabel(terminalStatus ?? 'running')}
              className={`${CLASSIC_LEADING_GLYPH_CLASS} ${terminalStatusColorClass(terminalStatus ?? 'running')}`}
              testId={withTestIdSuffix(
                'worktree-row-terminal-badge',
                testIdSuffix,
              )}
              data={{ 'data-terminal-status': terminalStatus }}
              {...terminalBadge}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center">
                <TerminalIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : classicLeadingFallback === 'graph' ? (
            <RowStatusBadge
              label="Updating project graph…"
              className={CLASSIC_LEADING_GLYPH_CLASS}
              testId={withTestIdSuffix(
                'worktree-row-graph-badge',
                testIdSuffix,
              )}
              tooltip={GRAPH_TOOLTIP}
            >
              {/* Still: the glyph only shows while the graph builds, and a
                  pulse in a list of rows is noise. */}
              <span className="inline-flex h-4 w-4 items-center justify-center">
                <GraphIcon size="sm" aria-hidden="true" />
              </span>
              {classicDragOverlay}
            </RowStatusBadge>
          ) : (
            <span className="relative inline-flex items-center justify-center">
              {classicIndicator}
              {classicDragOverlay}
            </span>
          )}
        </div>

        <div
          className={`min-w-0 flex-1 self-center ${isTearingDownVisual ? 'opacity-50' : ''} ${
            // Coarse pointers center the always-visible 44px chip hitbox over
            // the whole two-line block, so its reserve stays on the wrapper.
            actionChipSlot !== undefined && !autoDelete
              ? 'pointer-coarse:pr-12'
              : ''
          }`}
        >
          {/* Fine-pointer hover chips align with the label line only, so the
              hover padding reserve lives on this row alone — the subtitle
              keeps its full width instead of truncating under a reserve it
              never needs. */}
          <div
            // min-h-5 pins the label line to the status slot's height, so
            // the row never changes height when the slot appears, empties,
            // or hides under the hover action chips.
            className={`flex min-h-5 items-center gap-1 ${
              actionChipSlot !== undefined && !autoDelete
                ? actionChipHoverPadding
                : ''
            }`}
          >
            {/* Done titles keep the same text color as every other row — the
                done state is carried by the checkmark, not by dimming. */}
            <p
              title={nativeTitles ? branchName || undefined : undefined}
              data-testid="worktree-row-title"
              className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-s font-normal leading-snug`}
            >
              {branchLabel}
            </p>
            {autoDelete && (
              <>
                <WorktreeRowInlineActions.Provider value={true}>
                  {actionChipSlot}
                </WorktreeRowInlineActions.Provider>
                <SidebarAutoDeleteBadge
                  autoDelete={autoDelete}
                  onActivate={onAutoDeleteActivate}
                  readOnly={autoDeleteReadOnly}
                />
              </>
            )}
            {/* The pin is persistent metadata like the shared badge, so it
                takes the same lane, first in line: a pinned idle row shows it
                where the ••• appears, and a shared or busy row steps it left
                of the share glyph and the spinner/dot. It fades with the
                row's hover reveal, so it never sits under the actions.
                Focused rows draw their pin beside the age instead. */}
            {pinnedToTop && !focusedStatus && (
              <SidebarPinnedBadge
                testId={withTestIdSuffix(
                  'worktree-row-pinned-badge',
                  testIdSuffix,
                )}
              />
            )}
            {/* Last element before the status cluster, so an idle row lands
                it exactly where the ••• appears and a busy row sits it just
                left of the spinner/dot. The coarse reserve already lives on
                the wrapper above and the label line carries
                `actionChipHoverPadding` for the fine-pointer states, so no
                extra reserve is needed here. */}
            {!focusedStatus && sharedTitleBadge}
            {hasTrailingMeta && (
              <span
                className={`ml-auto inline-flex h-5 shrink-0 items-center gap-1.5 ${
                  actionChipSlot !== undefined
                    ? 'group-hover/sidebar-item:hidden group-focus-within/sidebar-item:hidden pointer-coarse:hidden'
                    : ''
                }`}
                data-testid={withTestIdSuffix(
                  'worktree-row-trailing-meta',
                  testIdSuffix,
                )}
              >
                {focusedDraft && (
                  <span
                    className={`${TRAILING_GLYPH_SLOT_CLASS} fg-quaternary ${
                      lastActivityAt === undefined ? 'pr-1' : ''
                    }`}
                    role="img"
                    aria-label="Draft pull request"
                    data-testid={withTestIdSuffix(
                      'worktree-row-draft',
                      testIdSuffix,
                    )}
                  >
                    <GitDraftIcon size={BRANCH_GLYPH_SIZE_PX} />
                  </span>
                )}
                {focusedClosed && (
                  <span
                    className={`${TRAILING_GLYPH_SLOT_CLASS} fg-destructive ${
                      lastActivityAt === undefined ? 'pr-1' : ''
                    }`}
                    role="img"
                    aria-label="Closed pull request"
                    data-testid={withTestIdSuffix(
                      'worktree-row-closed',
                      testIdSuffix,
                    )}
                  >
                    <GitPullRequestClosedIcon size={BRANCH_GLYPH_SIZE_PX} />
                  </span>
                )}
                {focusedOpenPr && lastKnownPrStatus !== undefined && (
                  <span
                    className={`${TRAILING_GLYPH_SLOT_CLASS} ${
                      (lastKnownPrStatus.ciStatus ??
                        lastKnownPrStatus.checkStatus) === 'failing' ||
                      lastKnownPrStatus.reviewStatus === 'changes_requested'
                        ? 'fg-destructive'
                        : 'fg-quaternary'
                    } ${lastActivityAt === undefined ? 'pr-1' : ''}`}
                    role="img"
                    aria-label="Open pull request"
                    data-testid={withTestIdSuffix(
                      'worktree-row-open-pr',
                      testIdSuffix,
                    )}
                  >
                    <GitPullRequestIcon size={BRANCH_GLYPH_SIZE_PX} />
                  </span>
                )}
                {focusedPrConflicts && (
                  <span
                    className={`${TRAILING_GLYPH_SLOT_CLASS} fg-destructive ${
                      lastActivityAt === undefined ? 'pr-1' : ''
                    }`}
                    role="img"
                    aria-label="Merge conflicts"
                    data-testid={withTestIdSuffix(
                      'worktree-row-conflicts',
                      testIdSuffix,
                    )}
                  >
                    <GitMergeConflictIcon size="xs" />
                  </span>
                )}
                {focusedMergeQueue && lastKnownPrStatus !== undefined && (
                  <span
                    className={`${TRAILING_GLYPH_SLOT_CLASS} fg-warning ${
                      lastActivityAt === undefined ? 'pr-1' : ''
                    }`}
                    role="img"
                    aria-label={focusedMergeQueueAriaLabel(lastKnownPrStatus)}
                    data-testid={withTestIdSuffix(
                      'worktree-row-merge-queue',
                      testIdSuffix,
                    )}
                  >
                    <GitMergeQueueIcon size={BRANCH_GLYPH_SIZE_PX} />
                  </span>
                )}
                {focusedChecksPassing && (
                  <span
                    className={`${TRAILING_GLYPH_SLOT_CLASS} fg-success ${
                      lastActivityAt === undefined ? 'pr-1' : ''
                    }`}
                    role="img"
                    aria-label={
                      (lastKnownPrStatus?.ciStatus ??
                        lastKnownPrStatus?.checkStatus) === 'passing'
                        ? 'Checks passing'
                        : lastKnownPrStatus?.reviewStatus === 'approved'
                          ? 'Approved'
                          : 'Ready to merge'
                    }
                    data-testid={withTestIdSuffix(
                      'worktree-row-checks-passing',
                      testIdSuffix,
                    )}
                  >
                    <CircleCheckIcon size={16} />
                  </span>
                )}
                {focusedMerged && (
                  <span
                    // The special (purple) ink, the merged state's color.
                    className={`${TRAILING_GLYPH_SLOT_CLASS} fg-special ${
                      lastActivityAt === undefined ? 'pr-1' : ''
                    }`}
                    role="img"
                    aria-label="Merged"
                    data-testid={withTestIdSuffix(
                      'worktree-row-merged',
                      testIdSuffix,
                    )}
                  >
                    <GitMergeIcon size={BRANCH_GLYPH_SIZE_PX} />
                  </span>
                )}
                {/* Pinned sits last, beside the age, so it lands exactly
                    under the hover Pin button: the age's 24px cell is the
                    Archive button's, and the 6px gap is the button's 4px inset
                    plus the 2px gap between buttons. */}
                {focusedPinned && (
                  <span
                    className={`${TRAILING_GLYPH_SLOT_CLASS} fg-quaternary ${
                      lastActivityAt === undefined ? 'pr-1' : ''
                    }`}
                    role="img"
                    aria-label="Pinned"
                    data-testid={withTestIdSuffix(
                      'worktree-row-pinned',
                      testIdSuffix,
                    )}
                  >
                    <PinFilledIcon size={16} />
                  </span>
                )}
                {lastActivityAt !== undefined && (
                  <SidebarRowAge
                    lastActivityAt={lastActivityAt}
                    hidesForActions={false}
                    testId={withTestIdSuffix('worktree-row-age', testIdSuffix)}
                  />
                )}
              </span>
            )}
            {/* Status cluster, rendered only while occupied: each chat-state
                badge keeps a h-5 w-5 footprint whose height matches the
                title's 20px line, so row height and the title↔subtitle gap
                never shift between states — while an empty slot never steals
                title width. The cluster grows leftward as states stack; the
                right-most badge's center lines up with the hover action
                buttons (row px-1.5 + w-5/2 = right-1 + w-6/2 = 16px from
                the row edge). */}
            {classicTrailingStatus !== null && (
              <span
                // The cluster stays visible while the row is hovered or
                // focused: the label line's chip reserve insets this last
                // flex child, so the badges slide left and sit beside the
                // revealed action buttons instead of hiding under them. The
                // title pays the badge width on top of the chip reserve —
                // status visibility wins over those extra characters.
                className="inline-flex h-5 shrink-0 items-center justify-end gap-0.5 -mr-0.5"
                data-testid={withTestIdSuffix(
                  'worktree-row-trailing-slot',
                  testIdSuffix,
                )}
              >
                {classicTrailingStatus}
              </span>
            )}
          </div>

          <div
            data-testid={withTestIdSuffix(
              'worktree-row-subtitle',
              testIdSuffix,
            )}
            // Hidden through the root's single-line mark, like the action
            // chip's placement.
            className="relative mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-2xs font-normal leading-4 fg-tertiary group-data-[worktree-single-line=true]:hidden"
          >
            {/* No overflow-hidden here: the text child truncates on its own,
                and clipping would cut the warning button's hover background
                (its click padding extends 2px past the track via -m-0.5). */}
            <span className="flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap">
              {showHealthWarning &&
                withStatusTooltip(
                  healthIssue?.reason ?? 'Worktree issue',
                  <button
                    type="button"
                    onClick={onWarningClick}
                    // fg-warning: the fallback triangle must still read as a
                    // warning instead of blending into the fg-tertiary subtitle.
                    // -m-0.5 cancels the click padding visually, so the glyph
                    // sits exactly in the shared subtitle icon column with the
                    // plain-span badges (terminal, script, hook, …).
                    className={`focus-ring -m-0.5 p-0.5 shrink-0 rounded transition-colors fg-warning hover:bg-subtle hover:fg-primary ${HEALTH_WARNING_COARSE_HIT_AREA}`}
                    aria-label="Worktree issue - click for details"
                  >
                    <WarningIcon size="xs" />
                  </button>,
                )}

              {/* Subject badges: one glyph per subsystem, tinted by its
                  collapsed state (running neutral, unseen blue, failed red).
                  Badges co-exist so overlapping subjects all stay visible;
                  hover popovers / tooltips enumerate the per-run detail.
                  Pipeline state stays in the leading slot + trailing dot. */}
              {terminalStatus && classicLeadingFallback !== 'terminal' && (
                <RowStatusBadge
                  label={terminalStatusAriaLabel(terminalStatus)}
                  className={`shrink-0 rounded-sm ${SUBTITLE_BADGE_HIT_AREA} ${terminalStatusColorClass(terminalStatus)}`}
                  testId={withTestIdSuffix(
                    'worktree-row-terminal-badge',
                    testIdSuffix,
                  )}
                  data={{ 'data-terminal-status': terminalStatus }}
                  {...terminalBadge}
                >
                  <TerminalIcon size={12} />
                </RowStatusBadge>
              )}

              {scriptStatus && classicLeadingFallback !== 'script' && (
                <RowStatusBadge
                  label={scriptStatusAriaLabel()}
                  className={`shrink-0 rounded-sm ${SUBTITLE_BADGE_HIT_AREA} ${OPERATIONAL_STATUS_COLORS.active.foreground}`}
                  testId={withTestIdSuffix(
                    'worktree-row-script-badge',
                    testIdSuffix,
                  )}
                  {...scriptBadge}
                >
                  <RocketLaunchIcon size={12} />
                </RowStatusBadge>
              )}

              {hookStatus && classicLeadingFallback !== 'hook' && (
                <RowStatusBadge
                  label={hookStatusAriaLabel()}
                  className={`shrink-0 rounded-sm ${SUBTITLE_BADGE_HIT_AREA} ${OPERATIONAL_STATUS_COLORS.active.foreground}`}
                  testId={withTestIdSuffix(
                    'worktree-row-hook-badge',
                    testIdSuffix,
                  )}
                  {...hookBadge}
                >
                  <HookIcon size={12} />
                </RowStatusBadge>
              )}

              {splitStatus &&
                classicLeadingFallback !== 'split' &&
                !focusedStatus && (
                  <RowStatusBadge
                    label={splitStatusAriaLabel(splitStatus)}
                    className={`shrink-0 rounded-sm ${SUBTITLE_BADGE_HIT_AREA} ${splitStatusColorClass(splitStatus)}`}
                    testId={withTestIdSuffix(
                      'worktree-row-split-badge',
                      testIdSuffix,
                    )}
                    data={{ 'data-split-status': splitStatus }}
                    tooltip={
                      <SplitStatusTooltip
                        status={splitStatus}
                        message={splitStatusMessage}
                        textScale={textScale}
                      />
                    }
                  >
                    <SplitPrIcon size={12} />
                  </RowStatusBadge>
                )}

              {graphBuildStatus === 'building' &&
                classicLeadingFallback !== 'graph' && (
                  <RowStatusBadge
                    label="Updating project graph…"
                    className={`shrink-0 rounded-sm ${SUBTITLE_BADGE_HIT_AREA}`}
                    testId={withTestIdSuffix(
                      'worktree-row-graph-badge',
                      testIdSuffix,
                    )}
                    tooltip={GRAPH_TOOLTIP}
                  >
                    <GraphIcon size={12} />
                  </RowStatusBadge>
                )}

              {!focusedStatus && runStatusSlot}
              {hasIdleWatcherChats && classicLeadingFallback !== 'watchers' && (
                <RowStatusBadge
                  label="Chats with watchers"
                  className={`shrink-0 rounded-sm ${SUBTITLE_BADGE_HIT_AREA}`}
                  testId={withTestIdSuffix(
                    'worktree-row-watchers',
                    testIdSuffix,
                  )}
                  {...watcherBadge}
                >
                  <AppAdvisorWatcherIcon size="sm" />
                </RowStatusBadge>
              )}
              {hasScheduledMessages &&
                classicLeadingFallback !== 'scheduled' && (
                  <RowStatusBadge
                    label="Scheduled messages"
                    className={`shrink-0 rounded-sm ${SUBTITLE_BADGE_HIT_AREA}`}
                    testId={withTestIdSuffix(
                      'worktree-row-scheduled-messages',
                      testIdSuffix,
                    )}
                    {...scheduledBadge}
                  >
                    <TimeFliesIcon size={12} />
                  </RowStatusBadge>
                )}
              {isDiscovering &&
                withStatusTooltip(
                  'Discovering environment…',
                  <span
                    className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
                    role="img"
                    aria-label="Discovering environment"
                  >
                    <LoadingSpinner tone="accent" />
                  </span>,
                )}
              <span className="block min-w-0 flex-1 truncate whitespace-nowrap">
                {creationFailure ? (
                  <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                    <span
                      role="status"
                      className="min-w-0 truncate fg-secondary"
                      title={creationFailure.reason}
                      data-testid={withTestIdSuffix(
                        'worktree-row-creation-failure',
                        testIdSuffix,
                      )}
                    >
                      {creationFailure.reason}
                    </span>
                    {creationFailure.onRetry && (
                      <Button
                        variant="link"
                        className="shrink-0"
                        data-testid={withTestIdSuffix(
                          'worktree-row-creation-retry',
                          testIdSuffix,
                        )}
                        onClick={(event): void => {
                          // The row opens the task; this only retries it.
                          event.stopPropagation();
                          creationFailure.onRetry?.();
                        }}
                      >
                        Try again
                      </Button>
                    )}
                    {creationFailure.onDiscard && (
                      <Button
                        variant="link"
                        className="shrink-0"
                        data-testid={withTestIdSuffix(
                          'worktree-row-creation-discard',
                          testIdSuffix,
                        )}
                        onClick={(event): void => {
                          // The row opens the task; this only discards it.
                          event.stopPropagation();
                          creationFailure.onDiscard?.();
                        }}
                      >
                        Discard
                      </Button>
                    )}
                  </span>
                ) : focusedSubtitleStatus ? (
                  <span
                    className={
                      focusedSubtitleStatus.shimmer
                        ? 'canopy-text-shimmer'
                        : undefined
                    }
                    data-testid={withTestIdSuffix(
                      'worktree-row-subtitle-status',
                      testIdSuffix,
                    )}
                  >
                    {focusedSubtitleStatus.text}
                  </span>
                ) : (
                  <>
                    {!focusedStatus && inlineDepthBadge}
                    {!focusedStatus &&
                      inlineDepthBadge !== null &&
                      worktreeIdentity !== null &&
                      worktreeIdentity !== undefined && (
                        <span className="mx-1" aria-hidden="true">
                          ·
                        </span>
                      )}
                    {!focusedStatus && nestedChildDepth !== undefined && (
                      <>
                        {nestedChildIndicator}
                        <span className="mx-1" aria-hidden="true">
                          ·
                        </span>
                      </>
                    )}
                    {worktreeIdentity !== null &&
                      worktreeIdentity !== undefined && (
                        <span
                          className={`${REPLAY_MASK_CLASS}${
                            focusedStatus && scriptStatusProp === 'running'
                              ? ' canopy-text-shimmer'
                              : ''
                          }`}
                        >
                          {worktreeIdentity}
                        </span>
                      )}
                    {focusedDiffMetadata}

                    {splitStatusMessage && (
                      <>
                        <span className="mx-1" aria-hidden="true">
                          ·
                        </span>
                        <span>{splitStatusMessage}</span>
                      </>
                    )}

                    {isTearingDown && (
                      <>
                        <span className="mx-1" aria-hidden="true">
                          ·
                        </span>
                        <span>
                          {isArchiving ? 'Archiving…' : 'Running teardown…'}
                        </span>
                      </>
                    )}
                    {!isTearingDown && isRunningSetup && (
                      <>
                        {/* A cloud task being created has no branch before it. */}
                        {((worktreeIdentity !== null &&
                          worktreeIdentity !== undefined) ||
                          splitStatusMessage ||
                          focusedDiffMetadata) && (
                          <span className="mx-1" aria-hidden="true">
                            ·
                          </span>
                        )}
                        <span>{setupLabel}…</span>
                      </>
                    )}
                    {queuedRemovalLabel && (
                      <>
                        {((worktreeIdentity !== null &&
                          worktreeIdentity !== undefined) ||
                          splitStatusMessage) && (
                          <span className="mx-1" aria-hidden="true">
                            ·
                          </span>
                        )}
                        <span>{queuedRemovalLabel}</span>
                      </>
                    )}
                    {!isRunningSetup && !isTearingDown && isPendingGitSetup && (
                      <>
                        <span className="mx-1" aria-hidden="true">
                          ·
                        </span>
                        {withStatusTooltip(
                          'Setting up worktree (git operations in progress)',
                          <span>Setting up…</span>,
                        )}
                      </>
                    )}
                    {!isRunningSetup &&
                      !isTearingDown &&
                      !isPendingGitSetup && (
                        <>
                          {isDone && !focusedStatus && (
                            <>
                              <span className="mx-1" aria-hidden="true">
                                ·
                              </span>
                              <span
                                className={
                                  focusedStatus
                                    ? ''
                                    : STATUS_GLYPHS[
                                        lastKnownPrStatus?.state === 'merged'
                                          ? 'merged'
                                          : 'done'
                                      ].ink
                                }
                              >
                                {doneLabel}
                              </span>
                            </>
                          )}
                          {classicPrMetadata && !focusedStatus && (
                            <>
                              <span className="mx-1" aria-hidden="true">
                                ·
                              </span>
                              {/* The merge spinner shares one flex line with the PR
                            label so it is cross-axis centered against the
                            text. Left as a standalone inline box it would
                            instead baseline-align, and LoadingSpinner's
                            inline-grid reports its baseline from the first row
                            of dots, dropping the spinner ~7px below the label.
                            The `Creating` indicator below already groups this
                            way, which is why only merging looked low. */}
                              <span className="inline-flex h-4 items-center gap-1 align-bottom">
                                {classicPrMetadata}
                                {prMergingSlot !== undefined &&
                                  showPrBadge &&
                                  prMergingSlot}
                              </span>
                            </>
                          )}
                          {!focusedStatus &&
                            !isDone &&
                            !showPrBadge &&
                            isCreatingPr && (
                              <>
                                <span className="mx-1" aria-hidden="true">
                                  ·
                                </span>
                                <span className="inline-flex items-center gap-2 fg-secondary">
                                  <span>PR</span>
                                  <span className="inline-flex shrink-0 items-center">
                                    {prCreatingSlot ?? <LoadingSpinner />}
                                  </span>
                                </span>
                              </>
                            )}
                          {isDiscovering && (
                            <>
                              <span className="mx-1" aria-hidden="true">
                                ·
                              </span>
                              <span className="fg-secondary">
                                Discovering environment…
                              </span>
                            </>
                          )}
                        </>
                      )}
                  </>
                )}
              </span>
            </span>

            {!focusedStatus && trailingDiffMetadata}
          </div>
          {popoverSlots}
        </div>

        {!autoDelete && actionChipSlot}
        {multiSelected && <span className="sr-only">Selected</span>}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      data-testid={dataTestId}
      data-worktree-id={dataWorktreeId}
      data-project-id={dataProjectId}
      data-branch={dataBranch}
      data-display-mode={displayMode}
      data-multiselected={multiSelected || undefined}
      style={style}
      onClick={onClick}
      {...intentHandlers}
      onContextMenu={onContextMenu}
      onPointerDown={onDragPointerDown}
      className={`group group/sidebar-item relative ${showsDragCursor ? (rowIsDragging ? 'pointer-fine:cursor-grabbing' : 'cursor-default pointer-fine:hover:cursor-grab') : onDragPointerDown ? 'cursor-default touch-none select-none' : nonSortableInteraction ? 'cursor-default select-none' : onClick ? 'cursor-pointer' : 'cursor-default'} ${textScale === 'sidebar' ? 'rounded-row' : 'rounded-md transition-colors'} ${
        textScale === 'sidebar'
          ? nested
            ? 'py-1.5 pl-4.5 pr-1.5'
            : 'px-1.5 py-1.5'
          : 'px-2 py-1.5'
      } ${
        isListMode
          ? textScale === 'sidebar'
            ? 'flex items-center gap-1.5'
            : 'flex items-start gap-2'
          : 'flex flex-col gap-1'
      } ${isListMode ? 'w-full min-w-0' : ''} ${touchTarget ? 'min-h-11' : ''} ${rowIsDragging ? 'opacity-60' : ''} ${isTearingDownVisual ? 'pointer-events-none' : ''} ${highlightClassName !== null ? highlightClassName : textScale === 'sidebar' ? 'fg-secondary hover:bg-subtle has-[[data-row-menu-open]]:bg-subtle' : 'fg-primary/80 hover:bg-subtle has-[[data-row-menu-open]]:bg-subtle'}`}
    >
      <div
        className={displayMode === 'kanban' ? 'flex items-start' : 'contents'}
      >
        {isListMode && (
          <div
            // -translate-y centers the indicator on the label line instead of
            // the two-line block: half the subtitle block (mt-0.5 + h-4) / 2.
            className={`flex shrink-0 self-center -translate-y-2.25 items-center justify-center ${
              textScale === 'sidebar' ? 'h-5 w-5' : 'h-4 w-4'
            } ${nested ? '-translate-x-3' : ''} ${
              isTearingDownVisual ? 'opacity-50' : ''
            }`}
            data-testid={withTestIdSuffix(
              'worktree-row-leading-slot',
              testIdSuffix,
            )}
          >
            {multiSelect?.selectMode ? (
              <ChoiceMark
                kind="checkbox"
                checked={multiSelected}
                disabled={multiSelect.selectable === false}
              />
            ) : (
              (leadingMetadataIndicator ?? dragHandleSlot)
            )}
          </div>
        )}

        <div
          className={`min-w-0 flex-1 ${textScale === 'sidebar' ? 'self-center' : ''} ${isTearingDownVisual ? 'opacity-50' : ''} ${
            // Reserve the 28px status footprint only when the right rail has a
            // visible dot, loader, or control. Idle rows use the full resting
            // width. Persistent actions keep their footprint; hover-revealed
            // actions reserve it only while revealed.
            // Coarse pointers always reserve 48px when an action exists:
            // 4px right inset + 44px action target.
            isListMode
              ? actionChipSlot !== undefined
                ? `${
                    hasAlwaysVisibleActionChip
                      ? actionChipRestingPadding
                      : `${renderRightStatusIndicator ? 'pr-7 ' : ''}${actionChipHoverPadding}`
                  } pointer-coarse:pr-12`
                : renderRightStatusIndicator
                  ? 'pr-7'
                  : ''
              : ''
          }`}
        >
          <div className="flex items-center gap-1">
            <p
              title={nativeTitles ? branchName || undefined : undefined}
              data-testid="worktree-row-title"
              className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-s leading-snug ${
                textScale === 'sidebar'
                  ? isDone
                    ? 'font-normal opacity-70'
                    : 'font-normal'
                  : // Selection changes ink, never weight: weight would
                    // re-wrap the title (DESIGN typography).
                    `${
                      isDone
                        ? 'font-medium'
                        : hasUnread || awaitingApproval
                          ? 'font-semibold'
                          : 'font-normal'
                    } ${
                      selected
                        ? 'fg-primary'
                        : isDone
                          ? 'fg-primary/80 opacity-70'
                          : hasUnread || awaitingApproval
                            ? 'fg-primary'
                            : 'fg-primary/80'
                    }`
              }`}
            >
              {branchLabel}
            </p>
          </div>
          <div
            data-testid={withTestIdSuffix(
              'worktree-row-subtitle',
              testIdSuffix,
            )}
            className={`relative mt-0.5 flex h-4 min-w-0 items-center gap-1.5 ${
              textScale === 'sidebar' ? 'text-2xs' : 'text-3xs'
            } font-normal leading-4 fg-tertiary`}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span
                className="block min-w-0 truncate whitespace-nowrap"
                title={
                  nativeTitles ? (specialStatusLabel ?? worktreeId) : undefined
                }
              >
                {subtitleContent}
              </span>
              {subtitleMetadata && (
                <span className="pointer-events-auto inline-flex shrink-0 items-center gap-1">
                  {subtitleContent && (
                    <span
                      className="fg-quaternary"
                      data-testid={withTestIdSuffix(
                        'worktree-row-subtitle-separator',
                        testIdSuffix,
                      )}
                      aria-hidden="true"
                    >
                      ·
                    </span>
                  )}
                  {subtitleMetadata}
                </span>
              )}
            </span>
            {trailingDiffMetadata}
            {popoverSlots}
          </div>
        </div>
      </div>

      {isListMode && renderRightStatusIndicator && (
        <span
          // top-[calc(...)] centers the rail on the label line: the label's
          // center sits half the subtitle block (0.5625rem) above row center.
          className={`pointer-events-auto absolute right-1 top-[calc(50%-0.5625rem)] inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center ${
            isRightStatusFocused
              ? 'z-10 opacity-100'
              : actionChipSlot !== undefined
                ? 'group-hover:pointer-events-none group-hover:opacity-0 group-focus-within:pointer-events-none group-focus-within:opacity-0 pointer-coarse:hidden'
                : ''
          }`}
          data-testid={withTestIdSuffix(
            'worktree-row-status-rail',
            testIdSuffix,
          )}
          data-status-rail-focused={isRightStatusFocused || undefined}
          onFocusCapture={() => setIsRightStatusFocused(true)}
          onBlurCapture={(event) => {
            const nextTarget = event.relatedTarget;
            if (
              !(nextTarget instanceof Node) ||
              !event.currentTarget.contains(nextTarget)
            ) {
              setIsRightStatusFocused(false);
            }
          }}
        >
          {rightStatusIndicator}
        </span>
      )}
      {actionChipSlot}
      {multiSelected && <span className="sr-only">Selected</span>}
    </div>
  );
}

const WorktreeRowBase = forwardRef<HTMLDivElement, WorktreeRowProps>(
  WorktreeRowImpl,
);

function WorktreeRowPreviewLine({
  icon,
  label,
  detail,
  testId,
  maskLabel = false,
  wrapLabel = false,
  iconColorClass = 'fg-tertiary',
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  testId: string;
  /** The label is a user-authored project or branch name. */
  maskLabel?: boolean;
  wrapLabel?: boolean;
  iconColorClass?: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-start gap-2" data-testid={testId}>
      <HoverCardIconSlot>
        <span className={`inline-flex ${iconColorClass}`}>{icon}</span>
      </HoverCardIconSlot>
      <span className="flex min-w-0 flex-col">
        <span
          className={`${maskLabel ? `${REPLAY_MASK_CLASS} ` : ''}${wrapLabel ? 'break-words' : 'truncate'} fg-secondary`}
        >
          {label}
        </span>
        {/* A status line, not an identifier: it wraps rather than hide the
            end of the queue phase. */}
        {detail && (
          <span className="break-words text-2xs leading-4 fg-tertiary">
            {detail}
          </span>
        )}
      </span>
    </div>
  );
}

/** Every active row fact, including subjects hidden by its icon priority. */
function WorktreeRowPreviewIndicators({
  row,
}: {
  row: WorktreeRowProps;
}): JSX.Element | null {
  const focused = row.statusModel === 'focused';
  // Keep each fact's glyph on the same token as its sidebar indicator,
  // including facts hidden there by the leading indicator's priority.
  const iconColors: Readonly<Record<string, string>> = {
    question: SIDEBAR_INDICATOR_COLORS.warning,
    approval: SIDEBAR_INDICATOR_COLORS.warning,
    plan: focused
      ? SIDEBAR_INDICATOR_COLORS.warning
      : SIDEBAR_INDICATOR_COLORS.blue,
    planning: statusDotTokens('planning').color,
    pipeline: row.pipelineStatus
      ? focused && row.pipelineStatus === 'unseen'
        ? SIDEBAR_INDICATOR_COLORS.blue
        : focused && row.pipelineStatus === 'unseen-failure'
          ? OPERATIONAL_STATUS_COLORS.failed.foreground
          : focused && row.pipelineStatus === 'running'
            ? 'fg-primary'
            : pipelineGlyphColorClass(row.pipelineStatus)
      : 'fg-tertiary',
    terminal: row.terminalStatus
      ? terminalStatusColorClass(row.terminalStatus)
      : 'fg-tertiary',
    split: row.splitStatus
      ? splitStatusColorClass(row.splitStatus)
      : 'fg-tertiary',
    watchers: SIDEBAR_INDICATOR_COLORS.blue,
    scheduled: SIDEBAR_INDICATOR_COLORS.blue,
    health: SIDEBAR_INDICATOR_COLORS.destructive,
    done: statusDotTokens('done').color,
  };
  const indicators: {
    id: string;
    label: string;
    icon: ReactNode;
    detail?: string;
  }[] = [];
  const add = (
    id: string,
    label: string,
    icon: ReactNode,
    detail?: string,
  ): void => {
    indicators.push({ id, label, icon, detail });
  };
  if (row.hasPendingQuestion)
    add('question', 'Question waiting', <QuestionMarkIcon size={14} />);
  if (row.hasPendingToolApproval)
    add('approval', 'Approval needed', <PlanMapIcon size="sm" />);
  if (row.awaitingApproval)
    add('plan', 'Review plan', <PlanMapIcon size="sm" />);
  else if (row.uiStatus === 'planning' && row.pipelineStatus !== 'paused')
    add('planning', 'Planning', <PlanMapIcon size="sm" />);
  if (row.setupPhase && row.setupPhase !== 'idle') {
    const labels: Record<Exclude<WorktreeSetupPhase, 'idle'>, string> = {
      'git-pending': 'Setting up',
      'running-setup': 'Running setup',
      'running-teardown': 'Running teardown',
      'running-archive': 'Archiving',
      creating: 'Creating task',
    };
    add('setup', labels[row.setupPhase], <TimeFliesIcon size={14} />);
  } else if (row.hasMismatch || row.healthIssue) {
    add(
      'health',
      row.healthIssue?.reason ?? 'Worktree issue',
      <WarningIcon size={14} />,
    );
  }
  if (row.pipelineStatus)
    add(
      'pipeline',
      pipelineStatusAriaLabel(row.pipelineStatus),
      <PipelineIcon size={14} />,
    );
  if (row.terminalStatus)
    add(
      'terminal',
      terminalStatusAriaLabel(row.terminalStatus),
      <TerminalIcon size={14} />,
    );
  if (row.scriptStatus)
    add('scripts', scriptStatusAriaLabel(), <RocketLaunchIcon size={14} />);
  if (row.hookStatus)
    add('hooks', hookStatusAriaLabel(), <HookIcon size={14} />);
  if (row.graphBuildStatus)
    add('graph', 'Updating project graph', <GraphIcon size={14} />);
  if (row.splitStatus)
    add(
      'split',
      splitStatusAriaLabel(row.splitStatus),
      <SplitPrIcon size={14} />,
      row.splitStatusMessage,
    );
  if (row.hasIdleWatcherChats)
    add('watchers', 'Watchers active', <AppAdvisorWatcherIcon size="sm" />);
  if (row.hasScheduledMessages)
    add('scheduled', 'Scheduled messages', <TimeFliesIcon size={14} />);
  if (row.isDiscovering)
    add('discovery', 'Discovering environment', <TimeFliesIcon size={14} />);
  if (row.isCreatingPr && !row.lastKnownPrStatus)
    add(
      'creating-pr',
      'Creating pull request',
      <GitPullRequestIcon size={14} />,
    );
  if (row.prMergingSlot != null && !row.lastKnownPrStatus)
    add('merging-pr', 'Merging pull request', <GitMergeIcon size={14} />);
  if (
    !row.lastKnownPrStatus &&
    (row.runtimeState === 'done' || row.uiStatus === 'done')
  )
    add('done', row.doneLabel ?? 'Done', <DoneCheckIcon size="sm" />);
  if (row.runtimeState === 'archived')
    add('archived', 'Archived', <FolderIcon size={14} />);
  if (row.pinnedToTop) add('pinned', 'Pinned', <PinFilledIcon size={14} />);
  if (row.sharedWithTeammates)
    add('shared', 'Shared with teammates', <ShareIcon size={14} />);
  const depth = row.depthBadge?.depth ?? row.nestedChildDepth;
  if (depth !== undefined)
    add('depth', `Stack depth ${depth}`, <GitForkIcon size={14} />);
  if (indicators.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-2.5"
      data-testid="worktree-row-preview-indicators"
    >
      <div
        aria-hidden="true"
        className="h-[var(--border-hairline)] shrink-0 bg-line-quaternary"
      />
      {indicators.map(({ id, label, icon, detail }) => (
        <WorktreeRowPreviewLine
          key={id}
          icon={icon}
          label={label}
          detail={detail}
          testId={`worktree-row-preview-status-${id}`}
          iconColorClass={iconColors[id]}
          wrapLabel
        />
      ))}
    </div>
  );
}

/**
 * The hover preview card's content: the full title with its age and unread
 * dot, the line changes under it, a divider, then one line each for the project, the
 * branch, the branch it was created from, and the pull request.
 */
function WorktreeRowPreviewCard({
  title,
  branchName,
  worktreeId,
  baseBranch,
  projectName,
  projectIcon,
  lastActivityAt,
  pr,
  diffStats,
  row,
}: {
  row: WorktreeRowProps;
  title: string;
  branchName?: string;
  worktreeId?: string;
  baseBranch?: string;
  projectName?: string;
  projectIcon?: ReactNode;
  lastActivityAt?: string | number;
  pr?: WorktreeRowPrStatus;
  diffStats?: WorktreeRowDiffStats;
}): JSX.Element {
  const now = useMinuteClock();
  const insertions = diffStats?.insertions ?? 0;
  const deletions = diffStats?.deletions ?? 0;
  const hasChanges = insertions > 0 || deletions > 0;
  const prGlyphStatus = pr
    ? { ...pr, checkStatus: pr.ciStatus ?? pr.checkStatus }
    : undefined;
  const PrIcon = prGlyphStatus
    ? PR_STATUS_ICONS[prStatusIconKind(prGlyphStatus)]
    : null;
  const prText =
    pr?.title?.trim() || pr?.label || (pr ? 'Pull request' : undefined);
  const prChecksRunning =
    pr?.state === 'open' &&
    !pr.hasConflicts &&
    !isPrStatusInMergeQueue(pr) &&
    (pr.ciStatus ?? pr.checkStatus) === 'pending';
  const prChecksPassing = prHasSuccessIndicator(pr);
  const prDone =
    pr?.state === 'open' &&
    !pr.hasConflicts &&
    !isPrStatusInMergeQueue(pr) &&
    (row.runtimeState === 'done' || row.uiStatus === 'done');
  const branch =
    branchName || (row.worktreeIdSlot === null ? undefined : worktreeId);
  const base = baseBranch?.trim();
  return (
    <div className="flex select-text flex-col gap-2.5 text-xs">
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span
            className={`${REPLAY_MASK_CLASS} max-w-full break-words font-medium fg-primary`}
          >
            {title}
          </span>
          {/* The worktree's uncommitted line changes, on their own line so
              a long title keeps the card's width, in full (the card has the
              room the row's condensed badge lacks). */}
          {hasChanges && (
            <GroupedDiffStats
              insertions={insertions}
              deletions={deletions}
              testId="worktree-row-preview-diff"
            />
          )}
        </span>
        {lastActivityAt !== undefined && (
          <span className="inline-flex h-4.5 shrink-0 items-center tabular-nums fg-tertiary">
            {formatCompactAge(lastActivityAt, now)}
          </span>
        )}
      </div>
      {/* Sets the title apart from the details under it: one device pixel
          in the quietest line role, inset with the text like the other
          popover dividers. */}
      {(projectName || branch || (pr && PrIcon && prText)) && (
        <div
          aria-hidden="true"
          className="-my-0.5 h-[var(--border-hairline)] shrink-0 bg-line-quaternary"
          data-testid="worktree-row-preview-divider"
        />
      )}
      {projectName && (
        <WorktreeRowPreviewLine
          icon={projectIcon ?? <FolderIcon size={14} />}
          label={projectName}
          testId="worktree-row-preview-project"
          maskLabel
        />
      )}
      {branch && (
        <WorktreeRowPreviewLine
          icon={<BranchIcon size={14} />}
          label={branch}
          testId="worktree-row-preview-branch"
          maskLabel
        />
      )}
      {/* The branch it was created from, its own line under the fork. */}
      {base && base !== branch && (
        <WorktreeRowPreviewLine
          icon={<GitForkIcon size={14} />}
          label={`from ${base}`}
          testId="worktree-row-preview-base"
        />
      )}
      {pr && prGlyphStatus && PrIcon && prText && (
        <WorktreeRowPreviewLine
          icon={
            <span
              className={`relative inline-flex ${prChecksPassing ? 'fg-success' : prStatusColorClass(prGlyphStatus, 'fg-tertiary')}`}
              data-testid={
                prChecksPassing
                  ? 'worktree-row-preview-pr-checks-passing'
                  : undefined
              }
            >
              {prChecksPassing ? (
                <CircleCheckIcon size={14} />
              ) : (
                <PrIcon size={14} />
              )}
              {prChecksRunning && (
                <span className="absolute -right-0.5 -bottom-0.5 inline-flex rounded-full bg-quaternary p-px">
                  <CometSpinner
                    sizePx={8}
                    tone="primary"
                    dataTestId="worktree-row-preview-pr-checks-running"
                  />
                </span>
              )}
              {prDone && !prChecksRunning && !prChecksPassing && (
                <span
                  className={`absolute -right-0.5 -bottom-0.5 inline-flex rounded-full bg-quaternary p-px ${STATUS_GLYPHS.done.ink}`}
                  data-testid="worktree-row-preview-pr-done"
                >
                  <DoneCheckIcon size="sm" />
                </span>
              )}
            </span>
          }
          label={prText}
          detail={previewPrDetail(pr, row)}
          testId="worktree-row-preview-pr"
        />
      )}
      {pr?.state === 'open' &&
        ['pending', 'passing', 'failing'].includes(
          pr.ciStatus ?? pr.checkStatus ?? '',
        ) && (
          <span className="sr-only">
            Checks {ciStatusLabel(pr.ciStatus ?? pr.checkStatus).toLowerCase()}
          </span>
        )}
      <WorktreeRowPreviewIndicators row={row} />
    </div>
  );
}

function WorktreeRowWithPreview(
  props: WorktreeRowProps,
  ref: ForwardedRef<HTMLDivElement>,
): JSX.Element {
  // The card stays up while the pointer is on the row's own controls (Pin,
  // Archive show their tooltips beside it). Pressing the row, which can open
  // its menu, hides the card until the pointer leaves the row, so it never
  // stacks over a menu. While the row's menu is open the card stays hidden
  // even when the pointer comes back over the row.
  const [pressed, setPressed] = useState(false);
  const [menuActive, setMenuActive] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { hoverPreview } = props;
  const hasPreview = hoverPreview !== undefined;
  // The menu's open state lives in the chip, which the host may re-render
  // without re-rendering the row: read it after every commit, and watch the
  // chip for changes made from inside it.
  useLayoutEffect(() => {
    const node = wrapperRef.current;
    setMenuActive(node?.querySelector('[data-row-menu-active]') != null);
  });
  useLayoutEffect(() => {
    const node = wrapperRef.current;
    if (!hasPreview || !node) return undefined;
    const observer = new MutationObserver((): void =>
      setMenuActive(node.querySelector('[data-row-menu-active]') !== null),
    );
    observer.observe(node, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-row-menu-active'],
    });
    return (): void => observer.disconnect();
  }, [hasPreview]);
  // Hosts may make the row's `SidebarRowFrame` focusable, outside the card's
  // own trigger, so keyboard focus on that frame opens the card after the
  // hover delay. Only a focusable frame receives `focus`, so a frame that
  // gains or loses its tabIndex after mount (web, during removal) needs no
  // re-wiring.
  const [frameFocused, setFrameFocused] = useState(false);
  useEffect(() => {
    const frame = wrapperRef.current?.closest<HTMLElement>(
      '[data-sidebar-row-frame]',
    );
    if (!hasPreview || !frame) return undefined;
    trackInputModality(frame.ownerDocument);
    const view = frame.ownerDocument.defaultView ?? window;
    let timer: number | undefined;
    const handleFocus = (): void => {
      if (!wasFocusVisible(frame)) return;
      timer = view.setTimeout(
        (): void => setFrameFocused(true),
        ITEM_PREVIEW_OPEN_DELAY_MS,
      );
    };
    const handleBlur = (): void => {
      view.clearTimeout(timer);
      setFrameFocused(false);
    };
    frame.addEventListener('focus', handleFocus);
    frame.addEventListener('blur', handleBlur);
    return (): void => {
      view.clearTimeout(timer);
      frame.removeEventListener('focus', handleFocus);
      frame.removeEventListener('blur', handleBlur);
    };
  }, [hasPreview]);
  if (!hoverPreview) return <WorktreeRowBase {...props} ref={ref} />;
  // A status badge's own popover replaces the card: hosts mount a slot only
  // while its popover is open (web renders null while closed).
  const badgePopoverOpen = [
    props.pipelinePopoverSlot,
    props.terminalPopoverSlot,
    props.scriptPopoverSlot,
    props.hookPopoverSlot,
    props.approvalPopoverSlot,
    props.unreadPopoverSlot,
    props.toolApprovalPopoverSlot,
    props.watcherPopoverSlot,
    props.scheduledMessagesPopoverSlot,
  ].some((slot) => slot != null);
  return (
    <RichHoverTooltip
      content={
        <WorktreeRowPreviewCard
          row={props}
          title={props.branchLabel}
          branchName={props.branchName}
          worktreeId={props.worktreeId}
          baseBranch={hoverPreview.baseBranch}
          projectName={hoverPreview.projectName}
          projectIcon={hoverPreview.projectIcon}
          lastActivityAt={props.lastActivityAt}
          pr={props.lastKnownPrStatus}
          diffStats={props.diffStats}
        />
      }
      dataTestId="worktree-row-preview"
      openDelay={ITEM_PREVIEW_OPEN_DELAY_MS}
      open={frameFocused ? true : undefined}
      onOpenChange={(open): void => {
        if (!open) setFrameFocused(false);
      }}
      dismissOnEscape
      suppressed={pressed || menuActive || badgePopoverOpen}
      preferRightPlacement
      rightPlacementAlign="start"
      // The pointer can move onto the card to select and copy its text;
      // Enter on the row still opens the row.
      interactive
      // Selecting the card's text must not drag, open, or open the menu of
      // the row the card is portaled out of.
      containEvents
      openOnTriggerKey={false}
      // The row's right-click menu's corners and shadow: the card and the
      // menu are the two surfaces that sit beside a row.
      {...PREVIEW_CARD_SURFACE}
      surfaceClassName="max-h-[calc(100vh-2rem)] overflow-y-auto"
      triggerWrapperClassName="w-full min-w-0 align-top"
    >
      <div
        ref={wrapperRef}
        className="w-full min-w-0"
        onMouseLeave={(): void => setPressed(false)}
        onPointerDownCapture={(): void => setPressed(true)}
        onContextMenuCapture={(): void => setPressed(true)}
      >
        <WorktreeRowBase {...props} ref={ref} />
      </div>
    </RichHoverTooltip>
  );
}

export const WorktreeRow = memo(
  forwardRef<HTMLDivElement, WorktreeRowProps>(WorktreeRowWithPreview),
);
WorktreeRow.displayName = 'WorktreeRow';
