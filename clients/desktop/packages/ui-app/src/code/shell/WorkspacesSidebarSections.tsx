'use client';

import { useSidebarAutoDelete } from './SidebarAutoDelete';
import {
  CodeSidebarItemGroups,
  codeSidebarItemGroupRowMenu,
  type CodeSidebarItemGroupCommands,
  type CodeSidebarItemGroupEditorHandle,
} from './sidebar/CodeSidebarItemGroups';
import {
  buildSidebarItemGroupBlocks,
  type SidebarItemGroupBlock,
} from './sidebar/sidebar-item-groups-model';
import {
  Button,
  Dot,
  SidebarItemGroupHeader,
  sidebarItemGroupColor,
  type WorktreeMenuItem,
} from '@canopy/ui-shared/components';
import {
  ProjectAvatarBadge,
  ProjectListPagination,
} from '@canopy/ui-shared/components';
import { useProjectListPagination } from './sidebar/useProjectListPagination';
import {
  PendingProjectRows,
  type SidebarPendingProject,
} from './PendingProjectRow';
import {
  canDragSidebarRow,
  toRecencyMs,
  type SidebarSortMode,
} from './sidebar/sidebar-ordering';

import {
  Fragment,
  useContext,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type JSX,
  type ReactNode,
} from 'react';
import {
  WorkspaceDropIndicatorContext,
  WorkspaceSortableStateContext,
} from './sortable-state-context';
import type {
  CanopyCapabilities,
  WorktreeCreateResult,
  WorktreeRemovalCapability,
} from '@canopy/app-core';
import {
  AgentStateGlyph,
  HiddenItemsRow,
  LoadingSpinner,
  openWorktreeActionsMenuAt,
  PIPELINE_POPOVER_HIDE_DELAY_MS,
  WorkspaceSectionHeader,
  workspaceChildUnitLabel,
  SIDEBAR_ROW_GRID_CLASSNAME,
  SIDEBAR_ROW_LEADING_SLOT_CLASSNAME,
  SIDEBAR_ROW_TEXT_INSET_CLASSNAME,
  SidebarToggleRow,
  WorktreeRow,
  type WorktreeRowProps,
  type WorktreeRowPrStatus,
  type WorktreeRowDepthBadge,
  type WorktreeSetupPhase,
} from '@canopy/ui-shared/components';
import {
  ArchiveIcon,
  Lock,
  RefreshIcon,
  ShareIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { WORKTREE_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  collectBranchGroupingDescendantIds as collectDescendants,
  computeBranchGroups,
  type BranchGroupingNode,
  type BranchGroupingState,
} from '@canopy/protocol';
import {
  SidebarList,
  SidebarRowFrame,
  SidebarSection,
  WorkspaceStickyPins,
} from './sidebar';
import {
  type WorkspaceSectionsSnapshot,
  type WorktreeRuntimeProjection,
  newWorktreeIdsAfterSnapshot,
  partitionWorkspaces,
  partitionWorktrees,
  pendingWorkspaceIdsAfterSnapshot,
  projectWorktreeRuntime,
  rollUpPendingQuestionWorktreeKeys,
  workspaceWorktreeIds,
  worktreeRowKey,
} from './workspace-sections-model';
import {
  deriveWorkspaceBackend,
  deriveWorktreeUiStatus,
  sidebarRowLabel,
  workspaceLayout,
} from './worktree-status';
import type { SnapshotWorkspace, SnapshotWorktree } from './worktree-status';
import { workspaceColor, workspaceKind } from './sidebar-model';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { isMacPlatform } from '../../find/shortcut-target';
import {
  resolveSelectionClick,
  focusSelectionRow,
  resolveSelectionKey,
  shiftMouseDownSuppressesTextSelection,
} from '@canopy/ui-shared/lib/sidebar-row-selection-gestures';
import {
  worktreeSelectionRowsFor,
  type WorktreeMultiSelectBinding,
} from './sidebar/use-sidebar-worktree-bulk';
import type { WorkEntryMultiSelectBinding } from './sidebar/use-sidebar-work-entry-bulk';
import {
  SIDEBAR_SELECTION_ROW_ATTR,
  type SidebarSelectionRow,
} from './sidebar/sidebar-row-selection';

/** A host-owned project participating in the shared project list limit. */
export interface SidebarAdditionalProject {
  readonly localId: string;
  readonly node: ReactNode;
}

export type WorkspacesSidebarSelection =
  | { readonly kind: 'workspace'; readonly workspaceLocalId: string }
  | {
      readonly kind: 'worktree';
      readonly workspaceLocalId: string;
      readonly worktreeLocalId: string;
    }
  | null;

export interface WorkspaceSectionSlotContext {
  readonly workspace: SnapshotWorkspace;
  readonly selected: boolean;
  readonly hidden: boolean;
  readonly sortable: boolean;
  /** Section collapsed; the drag handle's icon swaps to a chevron on hover. */
  readonly collapsed: boolean;
  /**
   * Set on the pinned copies of a workspace header (`-sticky-slot`,
   * `-pin-top`, `-pin-bottom`), so a slot rendered into the header — the drag
   * handle's badge — can suffix its fixed test ids the way the header does
   * (CAN-3127). Absent on the in-flow header.
   */
  readonly testIdSuffix?: string;
}

export interface CoworkWorkspaceSlotContext extends WorkspaceSectionSlotContext {
  readonly index: number;
  readonly hasFollowingWorkspace: boolean;
  readonly onSelect?: () => void;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  /**
   * The bulk selection for this workspace's Work Entry rows (CAN-3975);
   * absent where the host wired no Work Entry removal.
   */
  readonly workEntryMultiSelect?: WorkEntryMultiSelectBinding;
}

export interface ArchivedWorktreeEntry {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  /** Host-formatted timestamp copy, preserving native date-format policy. */
  readonly timestamp?: string;
  readonly locked?: boolean;
}

export interface WorktreeRowSlotContext {
  readonly itemGroupMenuItems?: WorktreeMenuItem[];
  readonly workspace: SnapshotWorkspace;
  readonly worktree: SnapshotWorktree;
  readonly selected: boolean;
  readonly hidden: boolean;
  readonly sortable: boolean;
  readonly worktreeRemoval: WorktreeRemovalCapability | undefined;
  readonly groupingState?: BranchGroupingState;
  readonly groupingContainerId?: string;
  readonly structuralDescendantIds?: readonly string[];
  /**
   * Set on a pinned COPY of the row (sticky slot, pin bands). Slots rendered
   * into the copy suffix their fixed test ids with it, the way the row does,
   * so a copy's controls never collide with the in-flow row's (CAN-3127).
   */
  readonly pinnedSurface?: 'pin-top' | 'pin-bottom' | 'sticky-slot';
}

/**
 * The row props a host may layer over the snapshot projection from its own
 * live state. The snapshot is the shared, cross-platform source; a host that
 * renders from local stores (desktop) knows some of these sooner or more
 * precisely than its snapshot can carry, and some it alone knows (tool
 * approvals, watchers, the PR body). Identity, selection, layout, and the
 * row-owned pipeline/terminal popover wiring are deliberately not
 * overridable: the surface owns those.
 */
/**
 * Single source of truth for the allowlist: the exported `WorktreeRowOverrideKey`
 * type is derived from this array (below), and `pickWorktreeRowOverrides`
 * filters a host's override object against the SAME array at runtime before
 * it is ever spread onto a row. A type-only allowlist stops a well-typed
 * caller, but does nothing against a loosely-typed value (or an object built
 * from spreading unrelated fields) carrying extra keys past the compiler —
 * `pickWorktreeRowOverrides` is what actually keeps identity, selection, and
 * popover wiring host-unwritable.
 */
const WORKTREE_ROW_OVERRIDE_KEYS = [
  'uiStatus',
  // A cloud task the host is still creating, or failed to (CAN-6098).
  'setupPhase',
  'creationFailure',
  'statusModel',
  'lastActivityAt',
  'runtimeState',
  'isStreaming',
  'backgroundTasks',
  'awaitingApproval',
  'hasPendingQuestion',
  'hasPendingToolApproval',
  'hasUnread',
  'hasIdleWatcherChats',
  'hasScheduledMessages',
  'splitStatus',
  'splitStatusMessage',
  'pipelineStatus',
  'scriptStatus',
  'hookStatus',
  'graphBuildStatus',
  'lastKnownPrStatus',
  'doneLabel',
  'isCreatingPr',
  'prCreatingSlot',
  'prMergingSlot',
  'diffStats',
  'branchLabel',
  'branchName',
  'hasMismatch',
  'approvalPopoverSlot',
  'unreadPopoverSlot',
  'toolApprovalPopoverSlot',
  'watcherPopoverSlot',
  'scheduledMessagesPopoverSlot',
  'scriptPopoverSlot',
  'hookPopoverSlot',
  'onApprovalIconMouseEnter',
  'onApprovalIconMouseLeave',
  'onApprovalIconFocus',
  'onApprovalIconBlur',
  'onApprovalIconKeyDown',
  'onToolApprovalIconMouseEnter',
  'onToolApprovalIconMouseLeave',
  'onToolApprovalIconFocus',
  'onToolApprovalIconBlur',
  'onToolApprovalIconKeyDown',
  'onUnreadIconMouseEnter',
  'onUnreadIconMouseLeave',
  'onUnreadIconFocus',
  'onUnreadIconBlur',
  'onUnreadIconKeyDown',
  'onWatcherIconMouseEnter',
  'onWatcherIconMouseLeave',
  'onWatcherIconFocus',
  'onWatcherIconBlur',
  'onWatcherIconKeyDown',
  'onScheduledMessagesIconMouseEnter',
  'onScheduledMessagesIconMouseLeave',
  'onScheduledMessagesIconFocus',
  'onScheduledMessagesIconBlur',
  'onScheduledMessagesIconKeyDown',
  'onScriptIconMouseEnter',
  'onScriptIconMouseLeave',
  'onScriptIconFocus',
  'onScriptIconBlur',
  'onScriptIconKeyDown',
  'onHookIconMouseEnter',
  'onHookIconMouseLeave',
  'onHookIconFocus',
  'onHookIconBlur',
  'onHookIconKeyDown',
] as const;

export type WorktreeRowOverrideKey =
  (typeof WORKTREE_ROW_OVERRIDE_KEYS)[number];

export type WorktreeRowOverrides = Partial<
  Pick<WorktreeRowProps, WorktreeRowOverrideKey>
>;

/**
 * Copies exactly one allowlisted key from `source` to `target`, generic over
 * a single key `K` so the assignment stays correlated (both sides indexed by
 * the same `K`) without a type cast.
 */
function copyWorktreeRowOverrideKey<K extends WorktreeRowOverrideKey>(
  target: WorktreeRowOverrides,
  source: WorktreeRowOverrides,
  key: K,
): void {
  if (key in source) {
    target[key] = source[key];
  }
}

/**
 * Runtime enforcement of {@link WorktreeRowOverrideKey}: strips any key a
 * host's override hook returns that is not on the allowlist, so identity
 * (`worktreeId`, `workspaceLocalId`, …), selection, and the row-owned
 * pipeline/terminal popover wiring can never be overridden even by a
 * loosely-typed or hand-built override object. Call this on every value a
 * `UseWorktreeRowOverrides` hook returns before spreading it onto a row.
 */
export function pickWorktreeRowOverrides(
  overrides: WorktreeRowOverrides,
): WorktreeRowOverrides {
  const picked: WorktreeRowOverrides = {};
  for (const key of WORKTREE_ROW_OVERRIDE_KEYS) {
    copyWorktreeRowOverrideKey(picked, overrides, key);
  }
  return picked;
}

/**
 * A muted space hides its blue dots (CAN-4378). A host's live overrides carry
 * unread and pipeline state the snapshot mask in `projectWorktreeRuntime`
 * never saw, so they are masked the same way; orange and red states, and live
 * work, still show.
 */
function maskMutedWorktreeRowOverrides(
  overrides: WorktreeRowOverrides,
  rowProps: ComponentProps<typeof WorktreeRow>,
  spaceMuted: boolean,
): WorktreeRowOverrides {
  if (!spaceMuted) return overrides;
  const pipelineStatus =
    overrides.pipelineStatus === 'unseen'
      ? undefined
      : overrides.pipelineStatus;
  return {
    ...overrides,
    ...('hasUnread' in overrides ? { hasUnread: undefined } : {}),
    ...('pipelineStatus' in overrides ? { pipelineStatus } : {}),
    ...(overrides.uiStatus === 'unread'
      ? {
          uiStatus: deriveWorktreeUiStatus({
            isStreaming: overrides.isStreaming ?? rowProps.isStreaming,
            isRunningRun: rowProps.isRunningRun,
            awaitingApproval:
              overrides.awaitingApproval ?? rowProps.awaitingApproval,
            pipelineStatus:
              'pipelineStatus' in overrides
                ? pipelineStatus
                : rowProps.pipelineStatus,
          }),
        }
      : {}),
  };
}

/**
 * A HOOK, called once per rendered row (pinned copies included) inside the
 * row's own component. That placement is the point: a host subscribes each
 * row to exactly its own live state with narrow selectors, so that when a
 * live source PUBLISHES a change, a well-behaved host implementation (a
 * per-row selector with a value-level equality check, as the desktop host
 * uses) can re-render only the rows whose own derived state actually
 * changed, rather than the whole rail. This isolation applies only to that
 * publish path — it does not make a row immune to an ordinary React
 * re-render of this component or its own parent, which still re-renders
 * every row once regardless of what this hook does. The host must pass the
 * same function for the lifetime of the surface (hook rules), and should
 * return a memoized object so an unchanged row keeps its identity.
 * Returning `undefined` leaves the snapshot projection untouched.
 */
export type UseWorktreeRowOverrides = (
  context: WorktreeRowSlotContext,
) => WorktreeRowOverrides | undefined;

function useNoWorktreeRowOverrides(): WorktreeRowOverrides | undefined {
  return undefined;
}

/**
 * A row's trailing action chip, with the number of compact buttons it
 * renders. The row reserves hover space for exactly that many so the trailing
 * status (the unread dot, the PR badge) slides out from under the chips rather
 * than painting over one. The host that renders the chip reports the count
 * from the same derivation, so the two cannot drift (CAN-3053).
 */
export interface WorktreeActionsSlot {
  readonly node: ReactNode;
  readonly buttonCount: number;
}

export interface WorkspaceDndWrapperContext {
  readonly workspace: SnapshotWorkspace;
  readonly hidden: boolean;
  readonly sortable: boolean;
}

export interface WorktreeDndWrapperContext {
  readonly workspace: SnapshotWorkspace;
  readonly worktrees: readonly SnapshotWorktree[];
  readonly sortable: boolean;
  /**
   * Subset of `worktrees` whose OWN capabilities allow reordering. A host
   * fronting more than one backend must register only these with its DnD
   * context; the rest are rendered without a sortable wrapper and must not
   * become drop targets.
   */
  readonly sortableWorktreeIds: readonly string[];
  readonly containerByWorktreeId?: ReadonlyMap<string, string>;
  /**
   * The row's drag preview: the same row, with the host's live overrides,
   * minus identity and interaction. The DnD wrapper floats it under the
   * pointer while the worktree is dragged.
   */
  readonly renderDragPreview?: (worktreeLocalId: string) => ReactNode;
}

export interface WorkspaceBranchGrouping {
  readonly defaultBranches: ReadonlySet<string>;
  readonly groupingEnabled: boolean;
  readonly baseBranchByWorktreeId: ReadonlyMap<
    string,
    string | null | undefined
  >;
  readonly overrideByWorktreeId?: ReadonlyMap<
    string,
    'group' | 'ungroup' | null | undefined
  >;
  readonly retainedParentByWorktreeId?: ReadonlyMap<
    string,
    string | null | undefined
  >;
}

export interface WorkspaceDialogTriggerContext {
  readonly workspace: SnapshotWorkspace;
  readonly canOpenSettings: boolean;
}

/**
 * Host-driven emphasis on a workspace header's controls, in flow only: an
 * onboarding tour keeps the add button on screen and anchors it.
 */
export interface WorkspaceHeaderEmphasis {
  readonly forceShowControls?: boolean;
  /** Stamped on the add button as `data-onboarding-anchor`. */
  readonly addAnchor?: string;
  /** Locks the add button (a tour step owns the next click). */
  readonly addLocked?: boolean;
}

export interface WorkspaceContextMenuSlotContext {
  readonly workspace: SnapshotWorkspace;
  /** Dismisses the menu; hosts call it once a command has run. */
  readonly close: () => void;
}

export type WorktreeDialogTriggerContext = WorktreeRowSlotContext;

export interface WorktreePopoverSlotContext extends WorktreeRowSlotContext {
  readonly anchorRect: DOMRect | null;
  /**
   * Cancels the pending close so a scrollable popover survives the pointer
   * leaving the badge. Wire into the popover's own hover surface.
   */
  readonly onPopoverMouseEnter: () => void;
  /** Closes the popover once the pointer leaves its hover surface. */
  readonly onPopoverMouseLeave: () => void;
}

export interface WorktreePipelinePopoverSlotContext extends WorktreePopoverSlotContext {
  /**
   * The status the row's badge shows: the snapshot's, or the host's live
   * override (desktop's unseen results live only in its renderer store).
   */
  readonly pipelineStatus: WorktreeRowProps['pipelineStatus'];
  /** Id of the focusable list controlled by the worktree badge. */
  readonly popoverListId: string;
  /** Keeps the popover mounted while its scroll region owns focus. */
  readonly onPopoverFocus: () => void;
  /** Defers closing so focus can return from the list to its badge. */
  readonly onPopoverBlur: () => void;
  /** Dismisses the popover and restores focus to its controlling badge. */
  readonly onPopoverDismiss: () => void;
  /** Focuses the scroll region after an ArrowDown-triggered remount. */
  readonly onPopoverListReady: (list: HTMLElement) => void;
}

interface PopoverWorktreeRowProps {
  readonly rowContext: WorktreeRowSlotContext;
  readonly rowProps: ComponentProps<typeof WorktreeRow>;
  readonly useRowOverrides?: UseWorktreeRowOverrides;
  /** The row's space is muted: live overrides lose their blue dots too. */
  readonly spaceMuted?: boolean;
  readonly renderPipelinePopover?: (
    context: WorktreePipelinePopoverSlotContext,
  ) => ReactNode;
  readonly renderTerminalPopover?: (
    context: WorktreePopoverSlotContext,
  ) => ReactNode;
}

/** Keeps badge-hover state inside its row so siblings never render on hover. */
const PopoverWorktreeRow = memo(function PopoverWorktreeRow({
  rowContext,
  rowProps,
  useRowOverrides = useNoWorktreeRowOverrides,
  spaceMuted = false,
  renderPipelinePopover,
  renderTerminalPopover,
}: PopoverWorktreeRowProps): JSX.Element {
  const autoDelete = useSidebarAutoDelete({
    workspaceId: rowContext.workspace.localId,
    targetId: rowContext.worktree.localId,
    name: sidebarRowLabel(rowContext.workspace, rowContext.worktree),
  });

  const overrides = useRowOverrides(rowContext);
  // Runtime-enforce the allowlist: a host hook that returns extra keys (a
  // loosely-typed variable, or an object built by spreading unrelated
  // fields) must not be able to override row identity or selection just
  // because `WorktreeRowOverrideKey` narrowed its TYPE. See
  // `pickWorktreeRowOverrides`.
  const pickedOverrides = useMemo(
    (): WorktreeRowOverrides =>
      overrides ? pickWorktreeRowOverrides(overrides) : {},
    [overrides],
  );
  const safeOverrides = maskMutedWorktreeRowOverrides(
    pickedOverrides,
    rowProps,
    spaceMuted,
  );
  const [pipelineAnchorRect, setPipelineAnchorRect] = useState<DOMRect | null>(
    null,
  );
  const [terminalAnchorRect, setTerminalAnchorRect] = useState<DOMRect | null>(
    null,
  );
  const pipelineEnabled = renderPipelinePopover !== undefined;
  const terminalEnabled = renderTerminalPopover !== undefined;
  const pipelinePopoverListId = useId();

  // A long entry list turns the pipeline popover into a scroll region, so
  // leaving the badge cannot close it instantly — the pointer needs a moment
  // to cross the gap into the list, which then cancels the pending hide.
  const pipelineHideTimerRef = useRef<number | null>(null);
  const pipelineFocusWithinRef = useRef(false);
  const pipelineBadgeRef = useRef<HTMLElement | null>(null);
  const suppressNextPipelineFocusRef = useRef(false);
  const pipelinePendingListFocusRef = useRef(false);
  const cancelPipelineHide = useCallback((): void => {
    if (pipelineHideTimerRef.current !== null) {
      window.clearTimeout(pipelineHideTimerRef.current);
      pipelineHideTimerRef.current = null;
    }
  }, []);
  const hidePipelineNow = useCallback((): void => {
    pipelinePendingListFocusRef.current = false;
    cancelPipelineHide();
    setPipelineAnchorRect(null);
  }, [cancelPipelineHide]);
  const schedulePipelineHide = useCallback((): void => {
    cancelPipelineHide();
    pipelineHideTimerRef.current = window.setTimeout((): void => {
      pipelineHideTimerRef.current = null;
      if (pipelineFocusWithinRef.current) return;
      pipelinePendingListFocusRef.current = false;
      setPipelineAnchorRect(null);
    }, PIPELINE_POPOVER_HIDE_DELAY_MS);
  }, [cancelPipelineHide]);
  const showPipelineAnchor = useCallback(
    (element: HTMLElement): void => {
      pipelineBadgeRef.current = element;
      cancelPipelineHide();
      setPipelineAnchorRect(element.getBoundingClientRect());
    },
    [cancelPipelineHide],
  );
  useEffect((): (() => void) => cancelPipelineHide, [cancelPipelineHide]);

  return (
    <WorktreeRow
      {...autoDelete}
      {...rowProps}
      {...safeOverrides}
      onPipelineIconMouseEnter={
        pipelineEnabled
          ? (event): void => showPipelineAnchor(event.currentTarget)
          : undefined
      }
      onPipelineIconMouseLeave={
        pipelineEnabled ? schedulePipelineHide : undefined
      }
      onPipelineIconFocus={
        pipelineEnabled
          ? (event): void => {
              if (suppressNextPipelineFocusRef.current) {
                suppressNextPipelineFocusRef.current = false;
                return;
              }
              pipelineFocusWithinRef.current = true;
              showPipelineAnchor(event.currentTarget);
            }
          : undefined
      }
      onPipelineIconBlur={
        pipelineEnabled
          ? (): void => {
              pipelineFocusWithinRef.current = false;
              schedulePipelineHide();
            }
          : undefined
      }
      onPipelineIconClick={
        pipelineEnabled
          ? (event): void => {
              if (event.detail !== 0) return;
              event.stopPropagation();
              if (pipelineAnchorRect) {
                pipelineFocusWithinRef.current = false;
                hidePipelineNow();
              } else {
                pipelineFocusWithinRef.current = true;
                showPipelineAnchor(event.currentTarget);
              }
            }
          : undefined
      }
      onPipelineIconKeyDown={
        pipelineEnabled
          ? (event): void => {
              if (event.key === 'ArrowDown') {
                const list = document.getElementById(pipelinePopoverListId);
                if (list instanceof HTMLElement && list.tabIndex >= 0) {
                  event.preventDefault();
                  list.focus();
                } else {
                  event.preventDefault();
                  pipelinePendingListFocusRef.current = true;
                  showPipelineAnchor(event.currentTarget);
                }
                return;
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (pipelineAnchorRect) {
                  pipelineFocusWithinRef.current = false;
                  hidePipelineNow();
                } else {
                  pipelineFocusWithinRef.current = true;
                  showPipelineAnchor(event.currentTarget);
                }
                return;
              }
              if (event.key === 'Escape') {
                pipelineFocusWithinRef.current = false;
                hidePipelineNow();
                event.currentTarget.blur();
              }
            }
          : undefined
      }
      onTerminalIconMouseEnter={
        terminalEnabled
          ? (event): void =>
              setTerminalAnchorRect(event.currentTarget.getBoundingClientRect())
          : undefined
      }
      onTerminalIconMouseLeave={
        terminalEnabled ? (): void => setTerminalAnchorRect(null) : undefined
      }
      onTerminalIconFocus={
        terminalEnabled
          ? (event): void =>
              setTerminalAnchorRect(event.currentTarget.getBoundingClientRect())
          : undefined
      }
      onTerminalIconBlur={
        terminalEnabled ? (): void => setTerminalAnchorRect(null) : undefined
      }
      onTerminalIconKeyDown={
        terminalEnabled
          ? (event): void => {
              if (event.key !== 'Escape') return;
              setTerminalAnchorRect(null);
              event.currentTarget.blur();
            }
          : undefined
      }
      pipelinePopoverSlot={renderPipelinePopover?.({
        ...rowContext,
        pipelineStatus:
          overrides !== undefined && 'pipelineStatus' in overrides
            ? overrides.pipelineStatus
            : rowProps.pipelineStatus,
        anchorRect: pipelineAnchorRect,
        popoverListId: pipelinePopoverListId,
        onPopoverMouseEnter: cancelPipelineHide,
        onPopoverMouseLeave: schedulePipelineHide,
        onPopoverFocus: (): void => {
          pipelineFocusWithinRef.current = true;
          cancelPipelineHide();
        },
        onPopoverBlur: (): void => {
          pipelineFocusWithinRef.current = false;
          schedulePipelineHide();
        },
        onPopoverDismiss: (): void => {
          pipelineFocusWithinRef.current = false;
          hidePipelineNow();
          const badge = pipelineBadgeRef.current;
          if (badge) {
            suppressNextPipelineFocusRef.current = true;
            badge.focus();
          }
        },
        onPopoverListReady: (list): void => {
          if (!pipelinePendingListFocusRef.current) return;
          pipelinePendingListFocusRef.current = false;
          list.focus();
        },
      })}
      pipelinePopoverListId={pipelinePopoverListId}
      terminalPopoverSlot={renderTerminalPopover?.({
        ...rowContext,
        anchorRect: terminalAnchorRect,
        onPopoverMouseEnter: (): void => undefined,
        onPopoverMouseLeave: (): void => setTerminalAnchorRect(null),
      })}
    />
  );
});

/**
 * A worktree row's drag preview. Runs the host's override hook like the row
 * it copies, so the preview carries the same live status and diff stats, but
 * renders no identity attributes: automation and dnd tooling address the
 * in-flow row, never its floating copy.
 */
function WorktreeRowDragPreview({
  rowContext,
  rowProps,
  useRowOverrides = useNoWorktreeRowOverrides,
  spaceMuted = false,
}: {
  readonly rowContext: WorktreeRowSlotContext;
  readonly rowProps: ComponentProps<typeof WorktreeRow>;
  readonly useRowOverrides?: UseWorktreeRowOverrides;
  readonly spaceMuted?: boolean;
}): JSX.Element {
  const overrides = useRowOverrides(rowContext);
  // Same runtime allowlist enforcement as `PopoverWorktreeRow` (CAN-3053
  // finding 2): the preview is a second spread site for the same host
  // override value and must not let a loosely-typed override object smuggle
  // identity/selection past the drag preview's own deliberately-omitted
  // `data-*`/`selected` props either.
  const safeOverrides = overrides
    ? maskMutedWorktreeRowOverrides(
        pickWorktreeRowOverrides(overrides),
        rowProps,
        spaceMuted,
      )
    : {};
  return <WorktreeRow {...rowProps} {...safeOverrides} />;
}

export interface WorkspacesSidebarSectionsTestIds {
  readonly root?: string;
  readonly workspace?: string | ((workspaceLocalId: string) => string);
  /** The project header itself; pinned copies suffix their own ids. */
  readonly workspaceHeader?: (workspaceLocalId: string) => string;
  /** The header's name/collapse button; receives the workspace type. */
  readonly workspaceToggle?: (
    workspaceLocalId: string,
    workspaceType: string,
  ) => string;
  /**
   * The header's sortable wrapper — the drag surface around the header, in
   * flow and again around each pinned copy (suffixed by surface).
   */
  readonly workspaceSortableHeader?: (workspaceLocalId: string) => string;
  /** The header's hover-revealed options button; pinned copies suffix it. */
  readonly workspaceOptionsButton?: string;
  /** The header's right-click / options menu; pinned copies suffix it. */
  readonly workspaceContextMenu?: string;
  /** The line an expanded workspace with no rows shows in their place. */
  readonly workspaceEmpty?: (workspaceLocalId: string) => string;
  readonly worktreeRow?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => string;
  readonly hiddenWorkspacesToggle?: string;
  readonly hiddenWorktreesToggle?: (workspaceLocalId: string) => string;
  /** The hidden-worktrees disclosure and its rows, per workspace. */
  readonly hiddenWorktreesSection?: string;
  readonly archivedWorktreesToggle?: (workspaceLocalId: string) => string;
  readonly archivedWorktreeRow?: (
    workspaceLocalId: string,
    archivedWorktreeId: string,
  ) => string;
}

export interface WorkspacesSidebarSectionsProps {
  readonly state: WorkspaceSectionsSnapshot;
  /**
   * Baseline for chrome that addresses no particular row, and the fallback
   * for `capabilitiesFor`.
   */
  readonly capabilities: CanopyCapabilities;
  /**
   * Per-row capability resolution, addressed by any workspace or worktree
   * local id. Hosts whose client fronts more than one backend supply it so
   * each row answers from the client that actually implements it; omitted,
   * every row falls back to `capabilities` and rendering is unchanged.
   */
  readonly capabilitiesFor?: (localId: string) => CanopyCapabilities;
  readonly selected: WorkspacesSidebarSelection;
  readonly onSelectWorkspace?: (workspaceLocalId: string) => void;
  /**
   * Desktop's project header. A tree workspace's name toggles collapse on
   * every host; this adds desktop's presentation around it — the disclosure
   * chevron swaps in over the icon instead of a trailing chevron, an empty
   * project still toggles, and the name doubles as a drag activator — and
   * makes flat workspace names toggle rather than select.
   */
  readonly workspaceNameTogglesCollapse?: boolean;
  readonly onSelectWorktree: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  /**
   * Bulk selection (CAN-3975): Cmd/Ctrl-click, Shift-click, `x`, and the row
   * menu's Select. Absent: every click navigates.
   */
  readonly worktreeMultiSelect?: WorktreeMultiSelectBinding;
  /** The Work Entry bulk selection a cowork workspace's rows bind to. */
  readonly workEntryMultiSelectFor?: (
    workspaceLocalId: string,
  ) => WorkEntryMultiSelectBinding | undefined;
  /** Intent on a worktree row, addressed with the same ids as selection. */
  readonly onWorktreeIntent?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    phase: 'start' | 'end',
    source: 'pointer' | 'focus',
  ) => void;
  readonly touchTargets?: boolean;
  readonly className?: string;
  /**
   * Presentation profile for the workspace section header and its rows.
   *
   * - `'detailed'` (default) — today's rendering everywhere: backend pip always
   *   on, count at rest, worktree id under every row.
   * - `'quiet'` — the backend pip renders only when the sidebar actually holds
   *   more than one backend (a glyph repeated down every row distinguishes
   *   nothing) and the count shows only while a section is collapsed.
   *
   * Repo-backed and remote-control rows keep their worktree identity under
   * BOTH profiles, and repoless cowork rows drop it under both — the id is
   * only dropped where it is unreadable (`cloud:task:<uuid>`) and there is no
   * branch, PR, or diff to replace it. The web chat sidebar renders
   * `'detailed'`, the desktop profile (web chat parity, slice 6).
   */
  readonly rowPresentation?: 'detailed' | 'quiet';
  readonly worktreeDiffStatsStyle?: 'short' | 'complete';
  readonly renderWorkspaceDragHandle?: (
    context: WorkspaceSectionSlotContext,
  ) => ReactNode;
  readonly renderWorktreeDragHandle?: (
    context: WorktreeRowSlotContext,
  ) => ReactNode;
  readonly wrapWorkspaceSection?: (
    context: WorkspaceDndWrapperContext,
    section: ReactNode,
  ) => ReactNode;
  readonly wrapWorktreeList?: (
    context: WorktreeDndWrapperContext,
    list: ReactNode,
  ) => ReactNode;
  readonly wrapWorktreeRow?: (
    context: WorktreeRowSlotContext,
    row: ReactNode,
  ) => ReactNode;
  readonly renderWorktreeActions?: (
    context: WorktreeRowSlotContext,
  ) => WorktreeActionsSlot | null | undefined;
  readonly renderWorktreeStatus?: (
    context: WorktreeRowSlotContext,
  ) => ReactNode;
  /**
   * Host-owned replacement for the row's worktree id line (desktop: the
   * launch script's stop control). Returning nothing keeps the plain id.
   */
  readonly renderWorktreeIdSlot?: (
    context: WorktreeRowSlotContext,
  ) => ReactNode;
  readonly renderWorkspaceDialogs?: (
    context: WorkspaceDialogTriggerContext,
  ) => ReactNode;
  /**
   * Host-owned rows for a workspace header's right-click menu, which the
   * header's hover options button opens too. Omitted hosts keep only the
   * shared `Share template` item (and no menu at all where that is absent).
   */
  readonly renderWorkspaceContextMenuItems?: (
    context: WorkspaceContextMenuSlotContext,
  ) => ReactNode;
  /** Host verdict per workspace; see `SidebarSurfaceProps`. */
  readonly isWorkspaceContextMenuAvailable?: (
    workspaceLocalId: string,
  ) => boolean;
  readonly getWorkspaceHeaderEmphasis?: (
    workspaceLocalId: string,
  ) => WorkspaceHeaderEmphasis | undefined;
  /**
   * Host-owned: the project is pinned to the top of the Projects list, so its
   * header shows the pin mark. The portable snapshot carries no workspace pin;
   * a host that offers project pinning reports it here.
   */
  readonly isWorkspacePinned?: (workspaceLocalId: string) => boolean;
  /**
   * Host-owned setup/teardown phase for a row, over the snapshot's. Desktop
   * tracks setup and teardown runs in its renderer, not in the snapshot.
   */
  readonly getWorktreeSetupPhase?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => WorktreeSetupPhase | undefined;
  /**
   * Host-owned: the row's removal is in flight. The row stays listed, muted
   * and inert (no selection, no hover actions) until the host lets it go.
   */
  readonly isWorktreeRemovalInProgress?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /** The removal a row waits for in the rail's bulk removal queue. */
  readonly getWorktreeQueuedRemoval?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => 'archive' | 'delete' | undefined;
  /** Host-owned: the worktree is shared with teammates (badge on the row). */
  readonly isWorktreeShared?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /**
   * Host-owned: the row's space is muted, so its blue dots (unread chats, an
   * unseen pipeline success) and the group rollup's unread dot are hidden.
   */
  readonly isWorktreeSpaceMuted?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /**
   * Host veto on listing a snapshot row: desktop drops a row the moment its
   * store lets go of it (an archive in flight) while the snapshot still
   * carries it. `false` hides the row; omitted keeps every snapshot row.
   */
  readonly isWorktreeListed?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  readonly renderCoworkWorkspace?: (
    context: CoworkWorkspaceSlotContext,
  ) => ReactNode;
  /** Omission keeps the archived section completely absent. */
  readonly renderArchivedSection?: (workspaceLocalId: string) => ReactNode;
  readonly archivedCount?: (workspaceLocalId: string) => number | undefined;
  /**
   * `undefined` means summaries have not loaded yet; an array (including an
   * empty one) means loading has completed.
   */
  readonly archivedEntries?: (
    workspaceLocalId: string,
  ) => readonly ArchivedWorktreeEntry[] | undefined;
  readonly onLoadArchived?: (workspaceLocalId: string) => void | Promise<void>;
  readonly archivedExpanded?: (workspaceLocalId: string) => boolean;
  readonly onArchivedExpandedChange?: (
    workspaceLocalId: string,
    expanded: boolean,
  ) => void;
  readonly onViewArchived?: (
    workspaceLocalId: string,
    archivedWorktreeId: string,
  ) => void;
  readonly onRestoreArchived?: (
    workspaceLocalId: string,
    archivedWorktreeId: string,
  ) => void;
  readonly onDeleteArchived?: (
    workspaceLocalId: string,
    archivedWorktreeId: string,
  ) => void;
  readonly renderArchivedActions?: (
    workspaceLocalId: string,
    entry: ArchivedWorktreeEntry,
  ) => ReactNode;
  readonly renderWorktreeDialogs?: (
    context: WorktreeDialogTriggerContext,
  ) => ReactNode;
  /** Desktop host point for the existing per-row pipeline status popover. */
  readonly renderPipelinePopover?: (
    context: WorktreePipelinePopoverSlotContext,
  ) => ReactNode;
  /** Desktop host point for the existing per-row terminal status popover. */
  readonly renderTerminalPopover?: (
    context: WorktreePopoverSlotContext,
  ) => ReactNode;
  /**
   * Host-owned live row state layered over the snapshot projection. See
   * {@link UseWorktreeRowOverrides}: it is a hook, run inside each row.
   */
  readonly useWorktreeRowOverrides?: UseWorktreeRowOverrides;
  /** Desktop host point for mapping native PR state into the shared badge. */
  readonly derivePrStatus?: (
    context: WorktreeRowSlotContext,
  ) => WorktreeRowPrStatus | undefined;
  /** Desktop host point for deriving native completion copy per row. */
  readonly deriveDoneLabel?: (
    context: WorktreeRowSlotContext,
  ) => string | undefined;
  /**
   * Host point for a row's display title (desktop early access: the name of
   * the chat that started the worktree). Returning nothing keeps the stored
   * label, then the branch. Display only: rename dialogs still read the
   * stored label.
   */
  readonly deriveWorktreeRowLabel?: (
    context: WorktreeRowSlotContext,
  ) => string | undefined;
  readonly onOpenWorkspaceSettings?: (workspaceLocalId: string) => void;
  /**
   * Right-click `Share template` on a workspace row. Omitted by hosts that
   * cannot serve it — the read-only rail has no settings dialog to open, so
   * the item (and, with it, the whole menu) is dropped rather than disabled.
   */
  readonly onShareWorkspaceTemplate?: (workspaceLocalId: string) => void;
  /**
   * Row-level workspace removal. Rendered on the section header only where the
   * row reports `workspaceRemoval` and has no settings dialog to hang it in
   * (`workspaceSettings` unset or `false`); hosts with a settings dialog keep removal
   * in its danger tab.
   */
  readonly onRemoveWorkspace?: (workspaceLocalId: string) => void;
  readonly onWorkspaceCollapsedChange?: (
    workspaceLocalId: string,
    collapsed: boolean,
  ) => void;
  readonly visibleWorkspaceIds?: ReadonlySet<string>;
  /** Bound the mounted rows in a top-level project list. */
  readonly paginateProjects?: boolean;
  /**
   * Tree workspaces render their rows without the project header, its pinned
   * copies, or a drag activator: the rows of a tree-shaped Chats owner, whose
   * section header (`StandaloneChatsSidebarSection`) stands in for it
   * (CAN-3898). Collapsed, only the selected row stays, as a collapsed Chats
   * section keeps its selection. The host's own wrapper carries the
   * workspace's `data-workspace-id`, so this list does not repeat it.
   */
  readonly headerless?: boolean;
  /** The project list disclosure reads `More` / `Less`, with no count. */
  readonly compactProjectPagination?: boolean;
  /** Project headers drop their row counters. */
  readonly hideWorkspaceCounts?: boolean;
  /**
   * Project headers drop their hover `•••` for fine pointers; the same menu
   * opens by right-click, and touch keeps the button.
   */
  readonly hideWorkspaceOptionsForFinePointer?: boolean;
  /** A short hover on a worktree row opens its preview card. */
  readonly worktreeHoverPreview?: boolean;
  /**
   * Space between worktree rows. Unset keeps each list's own rhythm (1px in
   * the flat list, none inside an item group or a stack); `hairline` is 1px
   * everywhere, stacks and item groups included, like the nav rows above.
   */
  readonly worktreeRowGap?: 'hairline';
  /** Host-owned targets to keep mounted beyond the page limit. */
  readonly retainedWorkspaceIds?: readonly (string | null | undefined)[];
  /**
   * Selected Personal/organization context (CAN-2954). Rows owned by another
   * context are hidden before every other rule; omitted keeps today's list.
   */
  readonly context?: WorkspaceContext;
  /** Personal checkouts linked by the host to the selected organization. */
  readonly linkedPersonalWorkspaceIds?: readonly string[];
  /**
   * Rendered instead of nothing when an organization context has no rows at
   * all; hosts supply the empty state (a `None found` row, or why the
   * organization cannot list projects).
   */
  readonly renderContextEmptyState?: () => ReactNode;
  /**
   * Rendered whenever the list has no project rows and no hidden ones, in
   * every context, ahead of the context empty state: how the surface learns
   * the list is empty from the list that decides it. Host rows in
   * `additionalRows` still count as content.
   */
  readonly emptyListMark?: ReactNode;
  /**
   * Host-owned rows appended after the workspace list — desktop's organization
   * project placeholders (CAN-2955). They are deliberately not workspaces and
   * never reach `partitions`, so they also suppress the context empty state.
   */
  readonly additionalRows?: ReactNode;
  /**
   * Projects a host is still adding (a clone with no workspace row yet). They
   * render after the paged list and outside pagination, and count as content
   * for the empty state. Unlike `additionalRows`, no host visibility rule
   * applies to them: the host passes exactly the rows it wants shown.
   */
  readonly pendingProjects?: readonly SidebarPendingProject[];
  readonly additionalProjects?: readonly SidebarAdditionalProject[];
  readonly onWorktreeRowElement?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    element: HTMLDivElement | null,
  ) => void;
  readonly pendingRevealTarget?: {
    readonly workspaceLocalId: string;
    readonly worktreeLocalId: string;
  } | null;
  readonly onCreationError?: (workspaceLocalId: string, error: unknown) => void;
  readonly onCreateWorktree: (
    workspaceLocalId: string,
    sidebarItemGroupId?: string,
  ) => Promise<WorktreeCreateResult>;
  /**
   * The host wires worktree creation (it supplies `onCreateWorktree`). Not
   * sufficient on its own: each project's `+` also needs that project's own
   * client to report `worktreeCreation` through `capabilitiesFor` (or
   * `capabilities`), so a mixed list answers per project.
   */
  readonly creationEnabled?: boolean;
  /**
   * Per-workspace TRANSIENT host-state gate: `true` ⇒ that row's host cannot
   * accept commands right now, so its mutation affordances are withheld while
   * read-only ones stay. Deliberately separate from `capabilities` /
   * `capabilitiesFor`, which say what a row's client structurally implements
   * (see the REG-2804 design §2) — this axis can flap, that one cannot.
   *
   * Resolved per ROW rather than per list: a host fronting more than one backend
   * renders both in one list, and one unreachable backend must not withdraw the
   * other's affordances. Omitted (the desktop host) ⇒ nothing is gated.
   */
  readonly isWorkspaceCommandDisabled?: (workspaceLocalId: string) => boolean;
  readonly itemGroupCommandsFor?: (
    workspaceLocalId: string,
  ) => CodeSidebarItemGroupCommands | undefined;
  readonly onReorderGroupedChild?: (
    workspaceLocalId: string,
    activeId: string,
    overId: string,
  ) => void;
  readonly branchGroupingEnabled?: boolean;
  readonly getBranchGrouping?: (
    workspace: SnapshotWorkspace,
  ) => WorkspaceBranchGrouping | undefined;
  readonly testIds?: WorkspacesSidebarSectionsTestIds;
}

/**
 * The wrapper around one copy of a workspace header (in flow or in the rail's
 * sticky slot). While that workspace is the active drag source, the drag
 * copies dim to 60% and mark themselves, as the desktop section's copies do;
 * the selected-item pin copies are not drag surfaces and never dim.
 */
function WorkspaceHeaderCopyFrame({
  children,
  className,
  dimsWhileDragging = true,
  ...attrs
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly dimsWhileDragging?: boolean;
  readonly 'data-testid'?: string;
  readonly 'data-sidebar-workspace-sortable-header'?: string;
}): JSX.Element {
  const sortable = useContext(WorkspaceSortableStateContext);
  const dragging = dimsWhileDragging && sortable?.isDragging === true;
  return (
    <div
      {...attrs}
      className={dragging ? `${className} opacity-60` : className}
      data-sidebar-workspace-source-dragging={dragging ? 'true' : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The landing-edge line a project drag draws on the project under it. Reads the
 * sortable list's context, so it renders nothing outside a drag or a sortable
 * host.
 */
function WorkspaceDropIndicator({
  workspaceLocalId,
}: {
  readonly workspaceLocalId: string;
}): JSX.Element | null {
  const indicator = useContext(WorkspaceDropIndicatorContext);
  if (indicator?.workspaceLocalId !== workspaceLocalId) return null;
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute inset-x-1.5 z-20 h-0.5 rounded-full bg-accent ${
        indicator.position === 'before' ? '-top-px' : '-bottom-px'
      }`}
      data-drop-position={indicator.position}
      data-testid="workspace-drop-indicator"
    />
  );
}

const NO_PENDING_PROJECTS: readonly SidebarPendingProject[] = [];

export function WorkspacesSidebarSections({
  state,
  capabilities,
  capabilitiesFor,
  selected,
  onSelectWorkspace,
  workspaceNameTogglesCollapse,
  onSelectWorktree,
  worktreeMultiSelect,
  workEntryMultiSelectFor,
  onWorktreeIntent,
  touchTargets = false,
  className,
  rowPresentation = 'detailed',
  worktreeDiffStatsStyle = 'short',
  renderWorkspaceDragHandle,
  renderWorktreeDragHandle,
  wrapWorkspaceSection,
  wrapWorktreeList,
  wrapWorktreeRow,
  renderWorktreeActions,
  renderWorktreeStatus,
  renderWorktreeIdSlot,
  renderWorkspaceDialogs,
  renderWorkspaceContextMenuItems,
  isWorkspaceContextMenuAvailable,
  getWorkspaceHeaderEmphasis,
  isWorkspacePinned,
  getWorktreeSetupPhase,
  isWorktreeRemovalInProgress,
  getWorktreeQueuedRemoval,
  isWorktreeShared,
  isWorktreeSpaceMuted,
  isWorktreeListed,
  renderCoworkWorkspace,
  archivedCount,
  renderArchivedSection,
  archivedEntries,
  onLoadArchived,
  archivedExpanded,
  onArchivedExpandedChange,
  onViewArchived,
  onRestoreArchived,
  onDeleteArchived,
  renderArchivedActions,
  renderWorktreeDialogs,
  renderPipelinePopover,
  renderTerminalPopover,
  useWorktreeRowOverrides,
  derivePrStatus,
  deriveDoneLabel,
  deriveWorktreeRowLabel,
  onOpenWorkspaceSettings,
  onShareWorkspaceTemplate,
  onRemoveWorkspace,
  onWorkspaceCollapsedChange,
  visibleWorkspaceIds,
  paginateProjects = false,
  headerless = false,
  compactProjectPagination = false,
  hideWorkspaceCounts = false,
  hideWorkspaceOptionsForFinePointer = false,
  worktreeHoverPreview = false,
  worktreeRowGap,
  retainedWorkspaceIds = [],
  context,
  linkedPersonalWorkspaceIds,
  renderContextEmptyState,
  emptyListMark,
  additionalRows,
  pendingProjects = NO_PENDING_PROJECTS,
  additionalProjects,
  onWorktreeRowElement,
  pendingRevealTarget,
  onCreationError,
  onCreateWorktree,
  creationEnabled = false,
  isWorkspaceCommandDisabled,
  itemGroupCommandsFor,
  onReorderGroupedChild,
  branchGroupingEnabled = false,
  getBranchGrouping,
  testIds,
}: WorkspacesSidebarSectionsProps): JSX.Element | null {
  // A waiting question is carried per chat on the wire; the row dot is per
  // worktree. Keyed on the summaries array so a snapshot that did not change
  // them keeps the set (and every row's projection) stable.
  const pendingQuestionWorktreeKeys = useMemo(
    () => rollUpPendingQuestionWorktreeKeys(state.chatSummaries),
    [state.chatSummaries],
  );
  const pendingGroupByWorkspaceRef = useRef(new Map<string, string>());
  // Per workspace: opens its group list's editor from the selected row's
  // pinned copy, whose menu is built here rather than by the list.
  const itemGroupEditorsRef = useRef(
    new Map<string, CodeSidebarItemGroupEditorHandle>(),
  );
  const [collapsedOverrides, setCollapsedOverrides] = useState<
    Record<string, boolean>
  >({});
  const [hiddenWorkspacesExpanded, setHiddenWorkspacesExpanded] =
    useState(false);
  const [hiddenWorktreesExpanded, setHiddenWorktreesExpanded] = useState<
    Record<string, boolean>
  >({});
  const [archivedExpandedOverrides, setArchivedExpandedOverrides] = useState<
    Record<string, boolean>
  >({});
  const [archivedLoadStates, setArchivedLoadStates] = useState<
    Record<string, 'loading' | 'settled'>
  >({});
  const [pendingBaselines, setPendingBaselines] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(new Map());
  // A create may select at registration, before persistence or its snapshot
  // finishes. Never let a late receipt overwrite newer navigation, including
  // away-and-back to the same target. Count committed structural changes only.
  const selectionKey = selected
    ? JSON.stringify([
        selected.kind,
        selected.workspaceLocalId,
        selected.kind === 'worktree' ? selected.worktreeLocalId : null,
      ])
    : null;
  const selectionRevision = useRef({ key: selectionKey, revision: 0 });
  const pendingAttempts = useRef(
    new Map<string, { selectionRevision: number }>(),
  );
  useLayoutEffect(() => {
    if (selectionRevision.current.key === selectionKey) return;
    selectionRevision.current = {
      key: selectionKey,
      revision: selectionRevision.current.revision + 1,
    };
  }, [selectionKey]);
  const mountedRef = useRef(true);
  const activeRevealTargetRef = useRef<string | null>(null);
  const revealedTargetRef = useRef<string | null>(null);
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>());
  const rowElementCallbacksRef = useRef(
    new Map<string, (element: HTMLDivElement | null) => void>(),
  );
  const onWorktreeRowElementRef = useRef(onWorktreeRowElement);
  const pendingRevealTargetRef = useRef(pendingRevealTarget);
  onWorktreeRowElementRef.current = onWorktreeRowElement;
  pendingRevealTargetRef.current = pendingRevealTarget;
  const workspaces = state.workspaces;
  const worktrees = state.worktrees;
  // Sidebar-wide, not per workspace: the pip exists to say WHERE work runs, so
  // it earns its place only when the sidebar holds more than one answer. Cheap
  // single pass over the same rows the sections already read.
  const sidebarHasMixedBackends = ((): boolean => {
    let seen: SnapshotWorktree['backend'] | undefined;
    for (const workspace of workspaces) {
      const backend = deriveWorkspaceBackend(workspace, worktrees);
      if (backend === null || backend === undefined) continue;
      if (seen === undefined) {
        seen = backend;
        continue;
      }
      if (seen !== backend) return true;
    }
    return false;
  })();
  const requestArchivedLoad = useCallback(
    (workspaceLocalId: string): void => {
      if (!onLoadArchived) return;
      setArchivedLoadStates((previous) => ({
        ...previous,
        [workspaceLocalId]: 'loading',
      }));
      void Promise.resolve()
        .then(() => onLoadArchived(workspaceLocalId))
        .catch(() => undefined)
        .finally(() => {
          if (!mountedRef.current) return;
          setArchivedLoadStates((previous) =>
            previous[workspaceLocalId] === 'loading'
              ? {
                  ...previous,
                  [workspaceLocalId]: 'settled',
                }
              : previous,
          );
        });
    },
    [onLoadArchived],
  );
  const partitions = partitionWorkspaces(workspaces, worktrees, {
    includeFlat: renderCoworkWorkspace !== undefined,
    visibleWorkspaceIds,
    context,
    linkedPersonalWorkspaceIds,
    standaloneChats: state.standaloneChats,
  });
  const projects: readonly (SnapshotWorkspace | SidebarAdditionalProject)[] =
    additionalProjects?.length
      ? [...partitions.visible, ...additionalProjects]
      : partitions.visible;
  const projectPage = useProjectListPagination(
    projects,
    (workspace) => workspace.localId,
    [
      selected?.workspaceLocalId,
      ...retainedWorkspaceIds,
      pendingRevealTarget?.workspaceLocalId,
    ],
    context?.kind === 'organization' ? context.organizationId : 'personal',
    paginateProjects,
  );
  // The single capability-resolution site in this component. Every affordance
  // below reads through it with the id of the thing it actually addresses.
  const capsOf = (localId: string): CanopyCapabilities =>
    capabilitiesFor?.(localId) ?? capabilities;
  // Its transient-host-state counterpart, resolved the same way and for the same
  // reason: in a mixed list one leg being unreachable must not speak for the
  // other. A row needs BOTH — structurally capable, and reachable right now.
  const commandsDisabledFor = (localId: string): boolean =>
    isWorkspaceCommandDisabled?.(localId) === true;
  const revealIfTarget = useCallback(
    (key: string, element: HTMLDivElement): void => {
      const target = pendingRevealTargetRef.current;
      if (!target) return;
      const targetKey = `${target.workspaceLocalId}:${target.worktreeLocalId}`;
      if (key !== targetKey) return;
      if (activeRevealTargetRef.current !== targetKey) {
        activeRevealTargetRef.current = targetKey;
        revealedTargetRef.current = null;
      }
      if (revealedTargetRef.current === key) return;
      // Scroll the row itself (it carries the automation attributes the
      // desktop suite records), smoothly, as the legacy list did.
      (element.querySelector('[data-worktree-id]') ?? element).scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
      revealedTargetRef.current = key;
    },
    [],
  );
  const getRowElementRef = useCallback(
    (
      workspaceLocalId: string,
      worktreeLocalId: string,
    ): ((element: HTMLDivElement | null) => void) => {
      const key = `${workspaceLocalId}:${worktreeLocalId}`;
      const existing = rowElementCallbacksRef.current.get(key);
      if (existing) return existing;
      const callback = (element: HTMLDivElement | null): void => {
        if (element) {
          rowElementsRef.current.set(key, element);
          revealIfTarget(key, element);
        } else {
          rowElementsRef.current.delete(key);
        }
        onWorktreeRowElementRef.current?.(
          workspaceLocalId,
          worktreeLocalId,
          element,
        );
      };
      rowElementCallbacksRef.current.set(key, callback);
      return callback;
    },
    [revealIfTarget],
  );

  useEffect(() => {
    // Compute each pending workspace's newly-observed ids ONCE and reuse the
    // result for both selection and the baseline state update.
    //
    // Known tradeoff (no wire correlation id): a single new id is assumed to
    // be OUR create. If an unrelated worktree lands in the same workspace
    // while a create is pending, it may be auto-selected — rare (duplicate
    // creation per workspace is suppressed and creates resolve quickly) and
    // benign (a navigation, not a mutation). Multiple simultaneous additions
    // cannot be correlated, so they clear the pending row without selecting.
    const resolvedWorkspaces = new Map<string, readonly string[]>();
    pendingBaselines.forEach((baseline, workspaceLocalId) => {
      const newIds = newWorktreeIdsAfterSnapshot(
        baseline,
        workspaceLocalId,
        state.worktrees,
      );
      if (newIds.length > 0) {
        resolvedWorkspaces.set(workspaceLocalId, newIds);
      }
      if (
        newIds.length === 1 &&
        pendingAttempts.current.get(workspaceLocalId)?.selectionRevision ===
          selectionRevision.current.revision
      ) {
        onSelectWorktree(workspaceLocalId, newIds[0]);
      }
    });
    if (resolvedWorkspaces.size > 0) {
      // Release the pending row, but keep attempt ownership until its receipt
      // settles or a newer create replaces it. An ambiguous snapshot cannot
      // select, while the matching completion still knows the created id.
      // The model helper stays the single source of truth for baseline
      // resolution; gating on the precomputed result means it only runs
      // when something actually resolved instead of every snapshot cycle.
      setPendingBaselines((previous) =>
        pendingWorkspaceIdsAfterSnapshot(previous, state.worktrees),
      );
    }
  }, [onSelectWorktree, pendingBaselines, state.worktrees]);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!onLoadArchived || archivedCount === undefined) return;
    for (const workspace of workspaces) {
      const workspaceLocalId = workspace.localId;
      const expanded =
        archivedExpanded?.(workspaceLocalId) ??
        archivedExpandedOverrides[workspaceLocalId] ??
        false;
      if (!expanded) {
        if (archivedLoadStates[workspaceLocalId] !== undefined) {
          setArchivedLoadStates((previous) => {
            if (previous[workspaceLocalId] === undefined) return previous;
            const next = { ...previous };
            delete next[workspaceLocalId];
            return next;
          });
        }
        continue;
      }
      if (
        (archivedCount(workspaceLocalId) ?? 0) > 0 &&
        archivedEntries?.(workspaceLocalId) === undefined &&
        archivedLoadStates[workspaceLocalId] === undefined
      ) {
        requestArchivedLoad(workspaceLocalId);
      }
    }
  }, [
    archivedCount,
    archivedEntries,
    archivedExpanded,
    archivedExpandedOverrides,
    archivedLoadStates,
    onLoadArchived,
    requestArchivedLoad,
    workspaces,
  ]);
  useEffect(() => {
    if (!pendingRevealTarget) {
      activeRevealTargetRef.current = null;
      revealedTargetRef.current = null;
      return;
    }
    const key = `${pendingRevealTarget.workspaceLocalId}:${pendingRevealTarget.worktreeLocalId}`;
    if (activeRevealTargetRef.current !== key) {
      activeRevealTargetRef.current = key;
      revealedTargetRef.current = null;
    }
    const element = rowElementsRef.current.get(key);
    if (element) revealIfTarget(key, element);
  }, [pendingRevealTarget, revealIfTarget, state.worktrees]);

  // The rows each workspace renders, in order, for ranges and select-all.
  // Filled while rendering and reported once the render commits.
  const selectionRowsDraft = new Map<string, SidebarSelectionRow[]>();
  const reportSelectionRows = worktreeMultiSelect?.onRowsChange;
  useEffect(() => {
    reportSelectionRows?.(selectionRowsDraft);
  });
  useEffect(
    () => (): void => reportSelectionRows?.(new Map()),
    [reportSelectionRows],
  );
  if (
    projects.length === 0 &&
    partitions.hidden.length === 0 &&
    additionalRows === undefined &&
    pendingProjects.length === 0
  ) {
    return (
      <>
        {emptyListMark}
        {context?.kind === 'organization' && renderContextEmptyState
          ? renderContextEmptyState()
          : null}
      </>
    );
  }

  const pendingGroupByWorkspace = pendingGroupByWorkspaceRef.current;
  const createWorktree = (workspaceLocalId: string, groupId?: string): void => {
    if (pendingBaselines.has(workspaceLocalId)) return;
    const revision = selectionRevision.current.revision;
    // Object identity owns cleanup: a snapshot can release A before its
    // receipt arrives, allowing B to start in the same workspace.
    const attempt = { selectionRevision: revision };
    pendingAttempts.current.set(workspaceLocalId, attempt);
    const baseline =
      workspaceWorktreeIds(worktrees).get(workspaceLocalId) ?? new Set();
    setPendingBaselines((previous) => {
      const next = new Map(previous);
      next.set(workspaceLocalId, baseline);
      return next;
    });
    if (groupId) pendingGroupByWorkspace.set(workspaceLocalId, groupId);
    else pendingGroupByWorkspace.delete(workspaceLocalId);
    const clearPendingAttempt = (): void => {
      if (pendingAttempts.current.get(workspaceLocalId) !== attempt) return;
      pendingAttempts.current.delete(workspaceLocalId);
      setPendingBaselines((previous) => {
        if (previous.get(workspaceLocalId) !== baseline) return previous;
        const next = new Map(previous);
        next.delete(workspaceLocalId);
        return next;
      });
    };
    void onCreateWorktree(workspaceLocalId, groupId)
      .then((result) => {
        if (!mountedRef.current) return;
        if (result.status === 'completed') {
          if (pendingAttempts.current.get(workspaceLocalId) !== attempt) return;
          clearPendingAttempt();
          if (selectionRevision.current.revision === revision)
            onSelectWorktree(workspaceLocalId, result.worktreeId);
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        clearPendingAttempt();
        onCreationError?.(workspaceLocalId, error);
      });
  };

  const renderWorkspace = (
    workspace: SnapshotWorkspace,
    hidden: boolean,
    index: number,
    workspaceCount: number,
  ): ReactNode => {
    const workspaceCapabilities = capsOf(workspace.localId);
    const workspaceCommandsDisabled = commandsDisabledFor(workspace.localId);
    const canReorder =
      workspaceCapabilities.workspaceReordering === true &&
      !workspaceCommandsDisabled;
    // The ONE creation decision for this project, read by every entry point
    // that creates a worktree in it (the header `+` and the item-group
    // create affordances). Creation is the host's wiring AND this project's
    // own client: only a client that reports `worktreeCreation` implements
    // `worktree.create` for it (default-deny), so a project in a mixed list
    // answers for itself rather than for the list.
    const canCreateWorktree =
      creationEnabled &&
      workspaceCapabilities.worktreeCreation === true &&
      !workspaceCommandsDisabled;
    const canOpenSettings =
      (workspaceCapabilities.workspaceSettings === 'full' ||
        workspaceCapabilities.workspaceSettings === 'details') &&
      onOpenWorkspaceSettings !== undefined;
    // PLACEMENT, so it reads layout — not `type`. A cloud workspace classifies
    // as `cowork` but projects its chats into `worktrees`, so it must fall
    // through to the tree branch below; routing it here would hand it to the
    // standalone-chats projection and every cloud chat would vanish (REG-2819).
    if (workspaceLayout(workspace) === 'flat') {
      if (renderCoworkWorkspace === undefined) return null;
      const selectedWorkspace =
        selected?.kind === 'workspace' &&
        selected.workspaceLocalId === workspace.localId;
      const sortable = canReorder && !hidden;
      const context: CoworkWorkspaceSlotContext = {
        workspace,
        selected: selectedWorkspace,
        hidden,
        sortable,
        collapsed: workspace.collapsed === true,
        index,
        hasFollowingWorkspace: index < workspaceCount - 1,
        onSelect: onSelectWorkspace
          ? (): void => onSelectWorkspace(workspace.localId)
          : undefined,
        onCollapsedChange: onWorkspaceCollapsedChange
          ? (collapsed): void =>
              onWorkspaceCollapsedChange(workspace.localId, collapsed)
          : undefined,
        workEntryMultiSelect: workEntryMultiSelectFor?.(workspace.localId),
      };
      const section = (
        <div
          key={workspace.localId}
          className="relative"
          data-workspace-id={workspace.localId}
        >
          <WorkspaceDropIndicator workspaceLocalId={workspace.localId} />
          {renderCoworkWorkspace(context)}
        </div>
      );
      return sortable
        ? (wrapWorkspaceSection?.({ workspace, hidden, sortable }, section) ??
            section)
        : section;
    }
    const groupingInput =
      branchGroupingEnabled &&
      workspaceCapabilities.worktreeBranchGrouping === true &&
      !hidden
        ? getBranchGrouping?.(workspace)
        : undefined;
    // The paint order nests by parent as the host resolves it: its retained
    // parent entry (null detaches a pinned row) and its `ungroup` override
    // win over the snapshot's parent, so an ungrouped row lists flat at
    // once, as it did on desktop.
    const listedWorktrees = worktrees
      .filter(
        (worktree) =>
          worktree.workspaceLocalId !== workspace.localId ||
          isWorktreeListed?.(workspace.localId, worktree.localId) !== false,
      )
      .map((worktree) => {
        if (
          worktree.workspaceLocalId !== workspace.localId ||
          groupingInput === undefined
        ) {
          return worktree;
        }
        const retained = groupingInput.retainedParentByWorktreeId?.has(
          worktree.localId,
        )
          ? (groupingInput.retainedParentByWorktreeId.get(worktree.localId) ??
            undefined)
          : worktree.branchGroupingParentWorktreeId;
        const parent =
          groupingInput.overrideByWorktreeId?.get(worktree.localId) ===
          'ungroup'
            ? undefined
            : retained;
        return parent === worktree.branchGroupingParentWorktreeId
          ? worktree
          : { ...worktree, branchGroupingParentWorktreeId: parent };
      });
    // Older desktops omitted their manual default. Cloud rows keep recency
    // when no explicit mode is supplied; row ownership remains authoritative.
    const workspaceBackend = deriveWorkspaceBackend(workspace, listedWorktrees);
    const itemSortMode: SidebarSortMode =
      workspace.itemSortMode ??
      (workspaceBackend === 'cloud' ? 'last-updated' : 'manual');
    const rows = partitionWorktrees(
      listedWorktrees,
      workspace.localId,
      itemSortMode,
    );
    const workspaceType = workspaceKind(workspace);
    const childUnitLabel = workspaceChildUnitLabel(workspaceType).toLowerCase();
    const childUnitLabelPlural = workspaceChildUnitLabel(
      workspaceType,
      'plural',
    ).toLowerCase();
    const toGroupingNode = (
      worktree: SnapshotWorktree,
    ): BranchGroupingNode & { worktree: SnapshotWorktree } => ({
      id: worktree.localId,
      branch: worktree.branch,
      baseBranch: groupingInput?.baseBranchByWorktreeId.get(worktree.localId),
      // A host entry wins even when it is null: that is how a pinned row is
      // detached from its parent while the snapshot still names one.
      retainedParentId: groupingInput?.retainedParentByWorktreeId?.has(
        worktree.localId,
      )
        ? (groupingInput.retainedParentByWorktreeId.get(worktree.localId) ??
          undefined)
        : worktree.branchGroupingParentWorktreeId,
      groupingOverride: groupingInput?.overrideByWorktreeId?.get(
        worktree.localId,
      ),
      worktree,
    });
    // The TRUE structure (hidden rows included) resolves parents from the
    // base branches as well as retained parents; the depth badges and the
    // row menu read it, and so does the pinned-ancestor walk below.
    const depthGrouping = groupingInput
      ? computeBranchGroups(
          [...rows.visible, ...rows.hidden].map(toGroupingNode),
          groupingInput.defaultBranches,
          groupingInput.groupingEnabled,
        )
      : undefined;
    // The PAINTED grouping (child rails, containers) leaves pinned rows and
    // everything beneath a pinned ancestor out of the nesting, because a
    // pinned row leads the section (desktop's rule): a pinned child paints
    // flat but still offers "Unstack from base", and an unpinned child of a
    // pinned root lists after every pinned row instead of splitting them.
    const pinnedById = new Map(
      [...rows.visible, ...rows.hidden].map((worktree) => [
        worktree.localId,
        worktree.pinned === true,
      ]),
    );
    const detachedFromPaint = (worktree: SnapshotWorktree): boolean => {
      if (worktree.pinned === true) return true;
      const visited = new Set<string>([worktree.localId]);
      let parentId =
        depthGrouping?.stateById.get(worktree.localId)?.parentId ?? null;
      while (parentId !== null && !visited.has(parentId)) {
        if (pinnedById.get(parentId) === true) return true;
        visited.add(parentId);
        parentId = depthGrouping?.stateById.get(parentId)?.parentId ?? null;
      }
      return false;
    };
    const toPaintedGroupingNode = (
      worktree: SnapshotWorktree,
    ): BranchGroupingNode & { worktree: SnapshotWorktree } => {
      const node = toGroupingNode(worktree);
      return detachedFromPaint(worktree)
        ? { ...node, baseBranch: null, retainedParentId: null }
        : node;
    };
    const grouping = groupingInput
      ? computeBranchGroups(
          rows.visible.map(toPaintedGroupingNode),
          groupingInput.defaultBranches,
          groupingInput.groupingEnabled,
        )
      : undefined;
    // Depth badges read the TRUE structure (hidden rows included), as the
    // legacy section did: hops below the top-most base-branch ancestor, with
    // the direct parent named when it is not that ancestor.
    const nameByWorktreeId = new Map(
      [...rows.visible, ...rows.hidden].map((worktree) => [
        worktree.localId,
        { branchName: worktree.branch, animalName: worktree.localId },
      ]),
    );
    const depthBadgeFor = (
      worktreeLocalId: string,
    ): WorktreeRowDepthBadge | undefined => {
      const state = depthGrouping?.stateById.get(worktreeLocalId);
      if (
        !state ||
        state.ancestryDepth < 1 ||
        state.topMostAncestorId === null
      ) {
        return undefined;
      }
      const topMost = nameByWorktreeId.get(state.topMostAncestorId);
      if (!topMost) return undefined;
      const directParent =
        state.parentId !== null && state.parentId !== state.topMostAncestorId
          ? nameByWorktreeId.get(state.parentId)
          : undefined;
      return { depth: state.ancestryDepth, topMost, directParent };
    };
    const itemGroupCommands =
      !hidden &&
      !workspaceCommandsDisabled &&
      workspaceCapabilities.itemGrouping === true
        ? itemGroupCommandsFor?.(workspace.localId)
        : undefined;
    const itemGroupsEnabled =
      itemGroupCommands !== undefined ||
      (workspace.itemGroups?.length ?? 0) > 0;
    const rootUnits = grouping
      ? grouping.groups.map((group) => ({
          rootId: group.node.id,
          itemIds: [group.node.id, ...group.children.map((child) => child.id)],
          pinned: group.node.worktree.pinned === true,
          recencyMs: Math.max(
            ...[
              group.node.worktree,
              ...group.children.map((child) => child.worktree),
            ].map(
              (row) =>
                toRecencyMs(row.lastActivityAt) ??
                toRecencyMs(row.createdAt) ??
                0,
            ),
          ),
        }))
      : rows.visible.map((row) => ({
          rootId: row.localId,
          itemIds: [row.localId],
          pinned: row.pinned === true,
          recencyMs:
            toRecencyMs(row.lastActivityAt) ?? toRecencyMs(row.createdAt),
        }));
    const selectedItemId =
      selected?.kind === 'worktree' &&
      selected.workspaceLocalId === workspace.localId
        ? selected.worktreeLocalId
        : undefined;
    const itemBlocks: SidebarItemGroupBlock[] = itemGroupsEnabled
      ? buildSidebarItemGroupBlocks(
          rootUnits,
          workspace.itemGroups ?? [],
          itemSortMode,
          selectedItemId,
        )
      : [];
    const selectedItemBlock = selectedItemId
      ? itemBlocks.find((block) =>
          block.visibleItemIds.includes(selectedItemId),
        )
      : undefined;
    const containerByWorktreeId = grouping
      ? new Map(
          rows.visible.map((worktree) => {
            const root = grouping.stateById.get(worktree.localId)?.rootId;
            return [worktree.localId, root ? `group:${root}` : 'top'] as const;
          }),
        )
      : undefined;
    const persistedCollapsed = workspace.collapsed === true;
    const collapsed =
      collapsedOverrides[workspace.localId] ?? persistedCollapsed;
    if (worktreeMultiSelect !== undefined) {
      const visibleById =
        itemGroupsEnabled && !collapsed
          ? new Map(rows.visible.map((item) => [item.localId, item]))
          : undefined;
      const renderedWorktrees = collapsed
        ? []
        : visibleById !== undefined
          ? itemBlocks.flatMap((block) =>
              block.visibleItemIds.flatMap((id) => {
                const row = visibleById.get(id);
                return row ? [row] : [];
              }),
            )
          : grouping
            ? grouping.groups.flatMap((group) => [
                group.node.worktree,
                ...group.children.map((child) => child.worktree),
              ])
            : rows.visible;
      selectionRowsDraft.set(
        workspace.localId,
        worktreeSelectionRowsFor(
          workspace,
          renderedWorktrees,
          worktreeMultiSelect.isSelectable,
          selected?.kind === 'worktree' &&
            selected.workspaceLocalId === workspace.localId
            ? selected.worktreeLocalId
            : undefined,
        ),
      );
    }
    const archivedIsExpanded =
      archivedExpanded?.(workspace.localId) ??
      archivedExpandedOverrides[workspace.localId] ??
      false;
    const archivedItems = archivedEntries?.(workspace.localId);
    const archivedItemCount =
      archivedItems === undefined
        ? (archivedCount?.(workspace.localId) ?? 0)
        : archivedItems.length;
    // An expanded workspace with nothing under it, nothing being created, and
    // nothing retained says so rather than rendering an empty body, as the
    // desktop project section did (its header always toggles, so the line is
    // how an empty project answers the click).
    const showsEmptyState =
      !headerless &&
      !collapsed &&
      rows.visible.length === 0 &&
      rows.hidden.length === 0 &&
      itemBlocks.length === 0 &&
      !pendingBaselines.has(workspace.localId) &&
      archivedItemCount === 0;
    const workspaceSelected =
      selected?.kind === 'workspace' &&
      selected.workspaceLocalId === workspace.localId;
    // Headerless rows have no header to drag the workspace by.
    const sortable = canReorder && !hidden && !headerless;
    const workspaceRemoval = workspaceCapabilities.workspaceRemoval;
    // Default-deny, matching the capability's own contract: unset means the
    // host never implements removal. The row-level affordance exists only for
    // hosts that have removal but no settings dialog to hang it in — where
    // settings are `'full'`, its danger tab keeps owning removal.
    const canRemoveWorkspace =
      onRemoveWorkspace !== undefined &&
      workspaceRemoval !== undefined &&
      workspaceRemoval !== false &&
      workspaceCapabilities.workspaceSettings !== 'full' &&
      workspaceCapabilities.workspaceSettings !== 'details';
    const workspaceContext: WorkspaceSectionSlotContext = {
      workspace,
      selected: workspaceSelected,
      hidden,
      sortable,
      collapsed,
    };
    const canSortWorktree = (worktree: SnapshotWorktree): boolean =>
      ((capsOf(worktree.localId).worktreeReordering === true &&
        canDragSidebarRow(itemSortMode, worktree.pinned === true)) ||
        // A row its host withholds grouping from (a desktop cloud session the
        // local store cannot persist) is not a drag source either.
        (itemGroupCommands !== undefined &&
          capsOf(worktree.localId).itemGrouping !== false &&
          worktree.pinned !== true &&
          !grouping?.stateById.get(worktree.localId)?.isChild)) &&
      !commandsDisabledFor(worktree.localId) &&
      isWorktreeRemovalInProgress?.(workspace.localId, worktree.localId) !==
        true &&
      !hidden;
    // Shared by `renderRow` and the drag preview below (CAN-3053 finding 10):
    // the DISPLAY fields a worktree row shows regardless of interaction state
    // — the drag preview's own hand-built `rowProps` had drifted from this
    // set (missing `worktreeIdSlot`, `compact`, `lastKnownPrStatus`,
    // `doneLabel`, `setupPhase`, `sharedWithTeammates`, `depthBadge`,
    // `touchTarget`, `isTearingDownVisual`), silently regressing a repoless
    // Cowork row's preview to a raw-id, full-height ghost and a portal
    // preview to one missing its PR/done badges. Interaction-only fields
    // (selection, action/status slots, drag handle, identity `data-*`
    // attributes, nesting) stay caller-owned: a drag preview intentionally
    // carries no row identity or live click/drag wiring.
    const worktreeRowDisplayProps = (
      worktree: SnapshotWorktree,
      rowContext: WorktreeRowSlotContext,
    ): WorktreeRuntimeProjection &
      Pick<ComponentProps<typeof WorktreeRow>, 'branchLabel'> &
      Partial<ComponentProps<typeof WorktreeRow>> => {
      const repolessCoworkRow =
        workspace.type === 'cowork' &&
        (!worktree.branch || worktree.branch === 'cloud');
      // A row whose own client reports `'branch'` identifies itself by its
      // real branch alone: its id names no local checkout, so it gets no id
      // slot. Resolved from the ROW's id, like every other per-row capability
      // here; unset (desktop, Remote Control, Cowork) keeps the id slot.
      const branchIdentityRow =
        capsOf(worktree.localId).worktreeIdPresentation === 'branch';
      return {
        branchLabel:
          deriveWorktreeRowLabel?.(rowContext) ??
          sidebarRowLabel(workspace, worktree),
        branchName: workspace.type === 'cowork' ? undefined : worktree.branch,
        worktreeId: worktree.localId,
        worktreeIdSlot:
          repolessCoworkRow || branchIdentityRow
            ? null
            : (renderWorktreeIdSlot?.(rowContext) ?? worktree.localId),
        ...projectWorktreeRuntime(worktree, {
          hasPendingQuestion: pendingQuestionWorktreeKeys.has(
            worktreeRowKey(workspace.localId, worktree.localId),
          ),
          spaceMuted:
            isWorktreeSpaceMuted?.(workspace.localId, worktree.localId) ===
            true,
        }),
        ...(getWorktreeSetupPhase?.(workspace.localId, worktree.localId)
          ? {
              setupPhase: getWorktreeSetupPhase(
                workspace.localId,
                worktree.localId,
              ),
            }
          : {}),
        queuedRemoval: getWorktreeQueuedRemoval?.(
          workspace.localId,
          worktree.localId,
        ),
        diffStatsStyle: worktreeDiffStatsStyle,
        lastKnownPrStatus: derivePrStatus?.(rowContext),
        doneLabel: deriveDoneLabel?.(rowContext),
        touchTarget: touchTargets,
        textScale: 'sidebar',
        compact:
          repolessCoworkRow ||
          (rowPresentation === 'quiet' && worktree.backend === 'cloud'),
        depthBadge: depthBadgeFor(worktree.localId),
        sharedWithTeammates:
          isWorktreeShared?.(workspace.localId, worktree.localId) === true,
        pinnedToTop: worktree.pinned === true,
        isTearingDownVisual:
          isWorktreeRemovalInProgress?.(workspace.localId, worktree.localId) ===
          true,
      };
    };
    // The preview card names the branch a worktree was created from: the same
    // base the host resolves for branch grouping, read even while grouping is
    // off.
    const previewBaseBranches = worktreeHoverPreview
      ? (groupingInput ?? getBranchGrouping?.(workspace))
          ?.baseBranchByWorktreeId
      : undefined;
    const renderRow = (
      worktree: SnapshotWorktree,
      rowHidden: boolean,
      nestedChildDepth?: number,
      // A pinned COPY, not the row itself. Copies must not take the flow
      // row's ownership: one shared element ref that the copies' unmount would
      // erase, and dialogs that portal to the document body and so escape the
      // hidden pin host entirely — three focus traps and three identical
      // `role="dialog"` test ids for one user action.
      pinnedSurface?: 'pin-top' | 'pin-bottom' | 'sticky-slot',
      itemGroupMenuItems?: WorktreeMenuItem[],
    ): ReactNode => {
      const rowSelected =
        selected?.kind === 'worktree' &&
        selected.workspaceLocalId === workspace.localId &&
        selected.worktreeLocalId === worktree.localId;
      // A row resolves from its OWN local id, never inherited from its parent
      // workspace. Redundant while workspaces are single-backend, and
      // deliberately so: it is what lets a workspace holding rows from more
      // than one backend answer per row without re-threading these call sites.
      const rowCapabilities = capsOf(worktree.localId);
      const removalInProgress =
        isWorktreeRemovalInProgress?.(workspace.localId, worktree.localId) ===
        true;
      const rowContext: WorktreeRowSlotContext = {
        workspace,
        worktree,
        selected: rowSelected,
        hidden: rowHidden,
        // A copy carries the flow row's own worktree id, and the host wraps a
        // sortable row with `useSortable({ id })`. Two registrations of one id
        // in a single `SortableContext` collapse to one, so a mounted copy
        // silently disables dragging on the real row. The copies are portaled
        // out of the sortable list and could never be drop targets regardless.
        sortable:
          pinnedSurface === undefined &&
          canSortWorktree(worktree) &&
          worktreeMultiSelect?.selectModeFor(workspace.localId) !== true &&
          !rowHidden,
        worktreeRemoval: rowCapabilities.worktreeRemoval,
        itemGroupMenuItems,
        ...(pinnedSurface ? { pinnedSurface } : {}),
        // The menu's group/ungroup action reads the true structure, so a
        // pinned child (painted flat) still offers "Unstack from base".
        groupingState: (depthGrouping ?? grouping)?.stateById.get(
          worktree.localId,
        ),
        groupingContainerId: containerByWorktreeId?.get(worktree.localId),
        structuralDescendantIds: grouping
          ? collectDescendants(
              worktree.localId,
              grouping.structuralChildIdsById,
            )
          : undefined,
      };
      const actions = renderWorktreeActions?.(rowContext);
      const statusSlot = renderWorktreeStatus?.(rowContext);
      const rowKey = worktreeRowKey(workspace.localId, worktree.localId);
      const multiSelection = worktreeMultiSelect?.selection;
      const rowSelectable =
        multiSelection !== undefined &&
        !removalInProgress &&
        worktreeMultiSelect?.isSelectable(workspace, worktree) === true;
      const toggleRowSelection = (shiftKey: boolean): void => {
        if (multiSelection === undefined || !rowSelectable) return;
        if (shiftKey) multiSelection.selectRange(workspace.localId, rowKey);
        else multiSelection.toggle(workspace.localId, rowKey);
      };
      const row = (
        <SidebarRowFrame
          key={worktree.localId}
          elementRef={
            pinnedSurface
              ? undefined
              : getRowElementRef(workspace.localId, worktree.localId)
          }
          // The rail's selected-item sync measures the IN-FLOW row to decide
          // whether to reveal the pinned group; a copy carrying this mark
          // would have it measure itself.
          {...(rowSelected && !pinnedSurface
            ? { 'data-sidebar-selected-item': '' }
            : {})}
          // Pinned copies keep the attribute empty, so Shift+Up/Down focus
          // finds the in-flow row by its key.
          {...(multiSelection !== undefined
            ? { [SIDEBAR_SELECTION_ROW_ATTR]: pinnedSurface ? '' : rowKey }
            : {})}
          variant="bare"
          role={
            !pinnedSurface &&
            worktreeMultiSelect?.selectModeFor(workspace.localId)
              ? 'checkbox'
              : undefined
          }
          aria-checked={
            !pinnedSurface &&
            worktreeMultiSelect?.selectModeFor(workspace.localId)
              ? multiSelection?.isSelected(rowKey)
              : undefined
          }
          // The frame owns keyboard activation; the shared row owns pointer
          // intent. Ignore focus on nested status/menu controls.
          onFocus={
            onWorktreeIntent && !removalInProgress
              ? (event): void => {
                  if (event.target === event.currentTarget)
                    onWorktreeIntent(
                      workspace.localId,
                      worktree.localId,
                      'start',
                      'focus',
                    );
                }
              : undefined
          }
          onBlur={
            onWorktreeIntent && !removalInProgress
              ? (event): void => {
                  if (event.target === event.currentTarget)
                    onWorktreeIntent(
                      workspace.localId,
                      worktree.localId,
                      'end',
                      'focus',
                    );
                }
              : undefined
          }
          selected={rowSelected}
          density={touchTargets ? 'touch' : 'default'}
          aria-disabled={removalInProgress || undefined}
          inert={removalInProgress}
          onClick={
            removalInProgress
              ? undefined
              : (event): void => {
                  // Cmd-click (Ctrl-click off macOS) toggles and Shift-click
                  // extends the bulk selection, without navigating, selecting
                  // text, or opening a new tab. A plain click navigates,
                  // clears the selection, and anchors Shift ranges here.
                  const intent =
                    rowSelectable &&
                    worktreeMultiSelect?.selectModeFor(workspace.localId)
                      ? event.shiftKey
                        ? 'range'
                        : 'toggle'
                      : resolveSelectionClick(
                          event,
                          {
                            selectable: rowSelectable,
                            active: multiSelection?.active === true,
                          },
                          isMacPlatform(),
                        );
                  if (intent === 'toggle' || intent === 'range') {
                    event.preventDefault();
                    toggleRowSelection(intent === 'range');
                    return;
                  }
                  if (rowSelectable) {
                    multiSelection?.anchor(workspace.localId, rowKey);
                  } else {
                    // Also drops a stale anchor, so the next Cmd-click
                    // never seeds a row that is no longer open.
                    multiSelection?.clear();
                  }
                  onSelectWorktree(workspace.localId, worktree.localId);
                }
          }
          onDoubleClick={(event): void => {
            if (
              pinnedSurface ||
              !rowSelectable ||
              event.shiftKey ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey
            )
              return;
            if (
              !(event.target instanceof Element) ||
              !event.currentTarget.contains(event.target) ||
              event.target.closest('button, a, input, [role="menu"]')
            )
              return;
            worktreeMultiSelect?.onSelectItem?.(rowKey);
          }}
          onMouseDown={
            multiSelection === undefined || removalInProgress || !rowSelectable
              ? undefined
              : (event): void => {
                  // The browser selects text on a Shift-click's mousedown,
                  // before the click that extends the selection.
                  if (
                    shiftMouseDownSuppressesTextSelection(event, rowSelectable)
                  ) {
                    event.preventDefault();
                  }
                }
          }
          onKeyDown={
            multiSelection === undefined || removalInProgress
              ? undefined
              : (event): void => {
                  // Only the focused row itself: inline inputs, menus, and
                  // popovers that bubble through it keep their own keys.
                  if (event.target !== event.currentTarget) return;
                  const intent = resolveSelectionKey(
                    event,
                    {
                      selectable: rowSelectable,
                      active: multiSelection.active,
                      escapeClears: worktreeMultiSelect?.escapeClears === true,
                    },
                    isMacPlatform(),
                  );
                  if (intent === null) return;
                  event.preventDefault();
                  if (intent === 'toggle') toggleRowSelection(false);
                  else if (intent === 'extend-up' || intent === 'extend-down') {
                    const target = multiSelection.extend(
                      workspace.localId,
                      rowKey,
                      intent === 'extend-up' ? -1 : 1,
                    );
                    if (target !== undefined) {
                      focusSelectionRow(
                        event.currentTarget,
                        SIDEBAR_SELECTION_ROW_ATTR,
                        target,
                      );
                    }
                  } else if (intent === 'select-all') {
                    multiSelection.selectAllInList(workspace.localId);
                  } else multiSelection.clear();
                }
          }
          // Right-click (and the ContextMenu key, which the browser turns
          // into the same native `contextmenu` event on a focused row) opens
          // the row's existing ⋯ menu anchored at the pointer, matching the
          // legacy desktop rail. A row whose menu is empty has no trigger to
          // find, so the browser's native menu is left alone (CAN-3053).
          //
          // The row's own dialogs (Set label, Branch info) portal to
          // `document.body` via `renderWorktreeDialogs` below, but React
          // still bubbles their synthetic events through this REACT tree —
          // not the DOM tree — because that is how portals work. Without the
          // real DOM containment check, right-clicking inside a portaled
          // dialog's input or text (to use the OS's own Cut/Copy/Paste menu)
          // reached this handler and hijacked it into the row's actions menu.
          onContextMenu={
            removalInProgress
              ? undefined
              : (event): void => {
                  if (
                    !(event.target instanceof Node) ||
                    !event.currentTarget.contains(event.target)
                  ) {
                    return;
                  }
                  const opened = openWorktreeActionsMenuAt(
                    event.currentTarget,
                    { x: event.clientX, y: event.clientY },
                  );
                  if (opened) event.preventDefault();
                }
          }
        >
          <PopoverWorktreeRow
            rowContext={rowContext}
            useRowOverrides={useWorktreeRowOverrides}
            spaceMuted={
              isWorktreeSpaceMuted?.(workspace.localId, worktree.localId) ===
              true
            }
            renderPipelinePopover={renderPipelinePopover}
            renderTerminalPopover={renderTerminalPopover}
            rowProps={{
              ...worktreeRowDisplayProps(worktree, rowContext),
              onIntent:
                onWorktreeIntent && !removalInProgress
                  ? (phase, source): void =>
                      onWorktreeIntent(
                        workspace.localId,
                        worktree.localId,
                        phase,
                        source,
                      )
                  : undefined,
              hoverPreview: worktreeHoverPreview
                ? {
                    projectName: workspace.name,
                    // The header's own glyph: avatar or kind badge.
                    projectIcon: (
                      <ProjectAvatarBadge
                        kind={workspaceType}
                        color={workspace.color}
                        temporary={workspace.temporary}
                        avatarUrl={workspace.avatarUrl}
                        testIdSuffix="-preview"
                      />
                    ),
                    baseBranch:
                      previewBaseBranches?.get(worktree.localId) ?? undefined,
                  }
                : undefined,
              // A pinned copy suffixes the row's own fixed test ids (its
              // badges and indicators), as desktop's legacy copies did, so a
              // bare id still resolves to the one in-flow row (CAN-3127).
              testIdSuffix: pinnedSurface ? `-${pinnedSurface}` : undefined,
              selected: rowSelected && multiSelection?.active !== true,
              ...(multiSelection !== undefined
                ? {
                    multiSelect: {
                      selected:
                        !pinnedSurface && multiSelection.isSelected(rowKey),
                      selectMode:
                        !pinnedSurface &&
                        worktreeMultiSelect?.selectModeFor(workspace.localId),
                      selectable: rowSelectable,
                    },
                  }
                : {}),
              nested: nestedChildDepth !== undefined,
              nestedChildDepth,
              dragHandleSlot: renderWorktreeDragHandle?.(rowContext),
              statusSlot,
              actionChipSlot: actions ? actions.node : undefined,
              actionChipButtonCount: actions?.buttonCount ?? 1,
              // Portal follows desktop: done-row actions reveal on fine-pointer
              // hover/focus and stay visible only where coarse pointers need it.
              //
              // The row's automation contract lives on the row element itself,
              // with its identity attributes beside it, and the selected-item
              // mark on the frame AROUND it — the shape every desktop spec
              // walks (`[data-sidebar-selected-item] [data-testid="worktree-row"]
              // [data-branch=…]`), so flipping the desktop rail onto this
              // surface changes no selector (CAN-3053 flag flip).
              dataTestId: pinnedSurface
                ? `${testIds?.worktreeRow?.(workspace.localId, worktree.localId) ?? 'worktree-row'}-${pinnedSurface}`
                : testIds?.worktreeRow?.(workspace.localId, worktree.localId),
              dataWorktreeId: worktree.localId,
              dataProjectId: workspace.localId,
              dataBranch: worktree.branch,
            }}
          />
          {pinnedSurface ? null : renderWorktreeDialogs?.(rowContext)}
        </SidebarRowFrame>
      );
      return rowContext.sortable && !itemGroupsEnabled
        ? (wrapWorktreeRow?.(rowContext, row) ?? row)
        : row;
    };
    // The pending row must sit where the resolved row will land, or it jumps
    // across the list the moment the create completes. Hosts insert new chats
    // and worktrees at the top of the manual order, and pinned rows always
    // lead, so that is the first unpinned slot.
    const topLevelWorktrees = grouping
      ? grouping.groups.map((group) => group.node.worktree)
      : rows.visible;
    const firstUnpinnedIndex = topLevelWorktrees.findIndex(
      (worktree) => worktree.pinned !== true,
    );
    const creatingPlaceholderIndex =
      firstUnpinnedIndex === -1 ? topLevelWorktrees.length : firstUnpinnedIndex;
    const creatingPlaceholder = pendingBaselines.has(workspace.localId) ? (
      <li
        role="status"
        aria-label={`Creating ${childUnitLabel}`}
        // On the row grid of the row it is about to become, so the label does
        // not shift when the create resolves.
        className={`flex min-w-0 items-center ${SIDEBAR_ROW_GRID_CLASSNAME} py-2 pr-2 text-xs fg-secondary`}
        data-testid="sidebar-worktree-creating-placeholder"
      >
        <span className={SIDEBAR_ROW_LEADING_SLOT_CLASSNAME} aria-hidden="true">
          <LoadingSpinner
            tone="secondary"
            sizePx={12}
            decorative
            dataTestId="sidebar-worktree-creating-icon-skeleton"
          />
        </span>
        <span className="min-w-0 truncate">Creating {childUnitLabel}…</span>
      </li>
    ) : null;
    const flatVisibleList = (
      <SidebarList rowGap={worktreeRowGap ?? 'hairline'}>
        {grouping
          ? grouping.groups.map((group, index) => (
              <Fragment key={group.node.id}>
                {index === creatingPlaceholderIndex
                  ? creatingPlaceholder
                  : null}
                {/* One stack: 1px between its rows; the list spaces stacks. */}
                <div className="flex flex-col gap-px">
                  {renderRow(group.node.worktree, false)}
                  {group.children.length > 0 && (
                    <div
                      // Stacked children sit flush, or 1px apart while the rows
                      // are spaced; the outer wrapper keeps the row gap from
                      // surrounding rows.
                      className={
                        worktreeRowGap === 'hairline'
                          ? 'flex flex-col gap-px'
                          : undefined
                      }
                      data-testid="worktree-branch-group-children"
                      data-parent-worktree-id={group.node.id}
                    >
                      {group.children.map((child, childIndex) => (
                        <div
                          key={child.id}
                          className="relative"
                          data-testid="worktree-branch-group-child"
                          data-child-worktree-id={child.id}
                        >
                          {/* Per-row rail segments join into one continuous
                            line; the stack's first and last segments inset so
                            the line does not touch the group's edges. */}
                          <span
                            aria-hidden="true"
                            className={`pointer-events-none absolute left-8 w-px rounded-full bg-line-base/80 ${
                              childIndex === 0
                                ? 'top-1.5'
                                : worktreeRowGap === 'hairline'
                                  ? // Across the 1px gap to the row above.
                                    '-top-px'
                                  : 'top-0'
                            } ${
                              childIndex === group.children.length - 1
                                ? 'bottom-1.5'
                                : 'bottom-0'
                            }`}
                            data-testid="worktree-nesting-rail"
                          />
                          {renderRow(
                            child.worktree,
                            false,
                            depthGrouping?.stateById.get(child.id)
                              ?.ancestryDepth,
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Fragment>
            ))
          : rows.visible.map((worktree, index) => (
              <Fragment key={worktree.localId}>
                {index === creatingPlaceholderIndex
                  ? creatingPlaceholder
                  : null}
                {renderRow(worktree, false)}
              </Fragment>
            ))}
        {creatingPlaceholderIndex === topLevelWorktrees.length
          ? creatingPlaceholder
          : null}
      </SidebarList>
    );
    const renderGroupStatus = (block: SidebarItemGroupBlock): ReactNode => {
      const runtime = block.units
        .flatMap((unit) => unit.itemIds)
        .flatMap((id) => {
          const row = rows.visible.find((row) => row.localId === id);
          return row
            ? [
                projectWorktreeRuntime(row, {
                  spaceMuted:
                    isWorktreeSpaceMuted?.(workspace.localId, row.localId) ===
                    true,
                }),
              ]
            : [];
        });
      if (runtime.some((row) => row.isStreaming || row.isRunningRun))
        return (
          <span aria-label="Active work in group">
            <LoadingSpinner sizePx={14} decorative />
          </span>
        );
      // Unread outranks background work: a long-running server would hide it.
      if (runtime.some((row) => row.hasUnread))
        return <Dot tone="unread" label="Unread work in group" />;
      const backgroundTasks = runtime.reduce(
        (total, row) => total + (row.backgroundTasks ?? 0),
        0,
      );
      return backgroundTasks > 0 ? (
        <AgentStateGlyph state="background" backgroundTasks={backgroundTasks} />
      ) : null;
    };
    const itemGroupUnitLabel =
      workspace.type === 'cowork'
        ? { singular: 'task', plural: 'tasks' }
        : { singular: 'worktree', plural: 'worktrees' };
    const canDragItemRow = (id: string): boolean => {
      const row = rows.visible.find((row) => row.localId === id);
      return row !== undefined && canSortWorktree(row);
    };
    const isItemRowSelected =
      worktreeMultiSelect?.selection.active === true
        ? (id: string): boolean =>
            worktreeMultiSelect.selection.isSelected(
              worktreeRowKey(workspace.localId, id),
            )
        : undefined;
    const onItemGroupError = (error: unknown): void =>
      onCreationError?.(workspace.localId, error);
    let itemGroupEditor = itemGroupEditorsRef.current.get(workspace.localId);
    if (!itemGroupEditor) {
      itemGroupEditor = { current: null };
      itemGroupEditorsRef.current.set(workspace.localId, itemGroupEditor);
    }
    const editorHandle = itemGroupEditor;
    // The selected row's group entries for one pinned copy, from the same
    // blocks as the flow row's, so moving it from a sticky copy re-seats the
    // pin with the row. Stack children take none, as in flow.
    const selectedItemMenu = (
      surface: 'pin-top' | 'pin-bottom',
    ): WorktreeMenuItem[] | undefined =>
      itemGroupCommands &&
      selectedItemBlock &&
      selectedItemId !== undefined &&
      selectedItemBlock.units.some((unit) => unit.rootId === selectedItemId)
        ? codeSidebarItemGroupRowMenu(
            {
              blocks: itemBlocks,
              groups: workspace.itemGroups ?? [],
              mode: itemSortMode,
              commands: itemGroupCommands,
              unitLabel: itemGroupUnitLabel,
              canDragRow: canDragItemRow,
              isItemSelected: isItemRowSelected,
              selectionCount: worktreeMultiSelect?.selection.count,
              onError: onItemGroupError,
              onEdit: (groupId, itemId): void =>
                editorHandle.current?.(groupId, itemId, surface),
            },
            selectedItemBlock,
            selectedItemId,
          )
        : undefined;
    const visibleList = itemGroupsEnabled ? (
      <CodeSidebarItemGroups
        blocks={itemBlocks}
        selectedItemId={selectedItemId}
        groups={workspace.itemGroups ?? []}
        mode={itemSortMode}
        rowGap={worktreeRowGap}
        itemGap={worktreeRowGap}
        unitLabel={itemGroupUnitLabel}
        commands={itemGroupCommands}
        editorHandle={editorHandle}
        canDragRow={canDragItemRow}
        selectionCount={worktreeMultiSelect?.selection.count}
        isItemSelected={isItemRowSelected}
        renderStatus={renderGroupStatus}
        pendingGroupId={pendingGroupByWorkspace.get(workspace.localId) ?? null}
        placeholder={creatingPlaceholder}
        onCreate={(groupId): void => {
          void itemGroupCommands?.update(groupId, { collapsed: false });
          createWorktree(workspace.localId, groupId);
        }}
        canCreate={canCreateWorktree}
        onError={onItemGroupError}
        onReorderChild={
          onReorderGroupedChild
            ? (activeId, overId): void =>
                onReorderGroupedChild(workspace.localId, activeId, overId)
            : undefined
        }
        renderPreview={(id): ReactNode => {
          const worktree = rows.visible.find((row) => row.localId === id);
          if (!worktree) return null;
          const context: WorktreeRowSlotContext = {
            workspace,
            worktree,
            selected: false,
            hidden: false,
            sortable: false,
            worktreeRemoval: false,
          };
          return (
            <WorktreeRowDragPreview
              rowContext={context}
              useRowOverrides={useWorktreeRowOverrides}
              spaceMuted={
                isWorktreeSpaceMuted?.(workspace.localId, worktree.localId) ===
                true
              }
              rowProps={worktreeRowDisplayProps(worktree, context)}
            />
          );
        }}
        renderRow={(id, menu, nested): ReactNode => {
          const worktree = rows.visible.find((row) => row.localId === id);
          return worktree
            ? renderRow(
                worktree,
                false,
                nested
                  ? depthGrouping?.stateById.get(id)?.ancestryDepth
                  : undefined,
                undefined,
                menu,
              )
            : null;
        }}
      />
    ) : (
      flatVisibleList
    );
    const sortableWorktreeIds = hidden
      ? []
      : rows.visible
          .filter(canSortWorktree)
          .map((worktree) => worktree.localId);
    const wrappedVisibleList =
      (itemGroupsEnabled ? undefined : wrapWorktreeList)?.(
        {
          workspace,
          worktrees: rows.visible,
          sortable,
          sortableWorktreeIds,
          containerByWorktreeId,
          renderDragPreview: (worktreeLocalId): ReactNode => {
            const worktree = rows.visible.find(
              (candidate) => candidate.localId === worktreeLocalId,
            );
            if (!worktree) return null;
            const previewContext: WorktreeRowSlotContext = {
              workspace,
              worktree,
              selected: false,
              hidden: false,
              sortable: false,
              worktreeRemoval: capsOf(worktree.localId).worktreeRemoval,
            };
            return (
              <WorktreeRowDragPreview
                rowContext={previewContext}
                useRowOverrides={useWorktreeRowOverrides}
                spaceMuted={
                  isWorktreeSpaceMuted?.(
                    workspace.localId,
                    worktree.localId,
                  ) === true
                }
                // Same display projection `renderRow` uses (CAN-3053 finding
                // 10), so the preview never drifts from the in-flow row's
                // fields again — a repoless Cowork row stays compact and
                // id-suppressed, and a host with `useWorktreeRowOverrides`
                // (including the portal, which has no overrides hook of its
                // own) still shows its PR/done badges in the preview.
                rowProps={worktreeRowDisplayProps(worktree, previewContext)}
              />
            );
          },
        },
        visibleList,
      ) ?? visibleList;
    // The selected worktree, only when it belongs to THIS workspace and is
    // rendered in flow. The pinned bands must never show a row the list is not
    // also showing — a pin for a hidden or foreign row is a dead end.
    const selectedWorktreeInFlow =
      selected?.kind === 'worktree' &&
      selected.workspaceLocalId === workspace.localId
        ? rows.visible.find(
            (worktree) => worktree.localId === selected.worktreeLocalId,
          )
        : undefined;
    // One header, rendered in flow and again in every pinned host; the copies
    // suffix their test ids so they stay addressable apart from the in-flow
    // header (CAN-3127).
    const emphasis = getWorkspaceHeaderEmphasis?.(workspace.localId);
    // Only a workspace the host serves gets its menu rows; one it declines
    // (an organization catalog row) keeps the browser's own right-click.
    const hostContextMenuItems =
      renderWorkspaceContextMenuItems &&
      isWorkspaceContextMenuAvailable?.(workspace.localId) !== false
        ? (close: () => void): ReactNode =>
            renderWorkspaceContextMenuItems({ workspace, close })
        : undefined;
    const toggleTestId = testIds?.workspaceToggle?.(
      workspace.localId,
      workspace.type,
    );
    const renderWorkspaceHeader = (
      surface: 'flow' | 'sticky-slot' | 'pin-top' | 'pin-bottom',
    ): ReactNode => (
      <WorkspaceSectionHeader
        forceShowControls={
          surface === 'flow' && emphasis?.forceShowControls === true
        }
        forceShowAddButton={
          surface === 'flow' && emphasis?.forceShowControls === true
        }
        addButtonDataAttrs={
          surface === 'flow' && emphasis?.addAnchor !== undefined
            ? { 'data-onboarding-anchor': emphasis.addAnchor }
            : undefined
        }
        testIdSuffix={surface === 'flow' ? '' : `-${surface}`}
        dataTestId={testIds?.workspaceHeader?.(workspace.localId)}
        // Desktop's headers always toggled, an empty workspace included (its
        // legacy row expanded to an empty-state line); the portal keeps the
        // count-gated default.
        canToggleCollapse={workspaceNameTogglesCollapse ? true : undefined}
        name={workspace.name}
        colorHex={workspaceColor(workspace)}
        workspaceType={workspaceType}
        avatarUrl={workspace.avatarUrl}
        backend={
          rowPresentation === 'quiet' && !sidebarHasMixedBackends
            ? undefined
            : (workspaceBackend ?? undefined)
        }
        temporary={workspace.temporary}
        worktreeCount={rows.visible.length + rows.hidden.length}
        pinnedToTop={isWorkspacePinned?.(workspace.localId) === true}
        countPresentation={
          hideWorkspaceCounts
            ? 'hidden'
            : rowPresentation === 'quiet'
              ? 'collapsed-only'
              : 'at-rest'
        }
        textScale="sidebar"
        deferHoverActions
        // Desktop's disclosure: the icon swaps to a chevron on hover instead
        // of a trailing chevron control; a host drag handle wraps its own
        // icon in `WorkspaceIconDisclosureSwap` (see `SidebarSurface`). Other
        // hosts (the portal) keep the trailing chevron beside the name.
        inlineCollapseChevron={workspaceNameTogglesCollapse === true}
        showCollapseChevron={workspaceNameTogglesCollapse !== true}
        repoCount={workspace.repos?.length}
        repoNames={workspace.repos?.map((repo) => repo.name)}
        collapsed={collapsed}
        warning={
          workspace.warningState === 'missing-scripts' ||
          workspace.warningState === 'mismatch'
            ? 'settings-warning'
            : null
        }
        disableDrag={!sortable}
        // The name is a drag activator too, as on desktop: the sortable
        // wrapper forwards its pointer-down to dnd-kit (see
        // `SortableWorkspacesSidebar`).
        primaryButtonDataAttrs={{
          // Desktop's name doubles as a drag activator; other hosts (the
          // portal) keep the icon handle as their only one.
          ...(sortable && workspaceNameTogglesCollapse === true
            ? { 'data-workspace-drag-activator': 'label' }
            : {}),
          // The name button's own id (desktop's cowork rows expose their
          // toggle this way); pinned copies suffix it like every other id.
          ...(toggleTestId !== undefined
            ? {
                'data-testid': `${toggleTestId}${
                  surface === 'flow' ? '' : `-${surface}`
                }`,
              }
            : {}),
        }}
        // Only hosts that supply menu rows get the hover "…": the read-only
        // web rail keeps its right-click-only `Share template`.
        optionsOpensContextMenu={hostContextMenuItems !== undefined}
        hideOptionsForFinePointer={hideWorkspaceOptionsForFinePointer}
        optionsButtonDataAttrs={
          testIds?.workspaceOptionsButton
            ? {
                'data-testid': `${testIds.workspaceOptionsButton}${
                  surface === 'flow' ? '' : `-${surface}`
                }`,
              }
            : undefined
        }
        contextMenuTestId={
          testIds?.workspaceContextMenu
            ? `${testIds.workspaceContextMenu}${
                surface === 'flow' ? '' : `-${surface}`
              }`
            : undefined
        }
        renderContextMenuItems={hostContextMenuItems}
        dragHandleSlot={
          sortable
            ? renderWorkspaceDragHandle?.(
                surface === 'flow'
                  ? workspaceContext
                  : { ...workspaceContext, testIdSuffix: `-${surface}` },
              )
            : undefined
        }
        touchTarget={touchTargets}
        onToggleCollapse={(): void => {
          const nextCollapsed = !collapsed;
          if (onWorkspaceCollapsedChange) {
            onWorkspaceCollapsedChange(workspace.localId, nextCollapsed);
            return;
          }
          setCollapsedOverrides((previous) => ({
            ...previous,
            [workspace.localId]: nextCollapsed,
          }));
        }}
        // No `onSelectName` or `onSelectBadge`: a tree project's name expands
        // and collapses it on every host, as desktop's project header always
        // did, and a non-sortable header's badge is not a second way in.
        // Selecting a tree project only parked the portal on the dead-end
        // "Select a worktree" placeholder with its worktrees still hidden, and
        // desktop has no project view to open (CAN-3053); its rows are what
        // the user opens.
        onAdd={
          canCreateWorktree
            ? (): void => createWorktree(workspace.localId)
            : undefined
        }
        addDisabled={
          pendingBaselines.has(workspace.localId) ||
          emphasis?.addLocked === true ||
          (workspace.type === 'multi-repo' &&
            (workspace.repos?.length ?? 0) === 0)
        }
        addDisabledTitle={
          workspace.type === 'multi-repo' &&
          (workspace.repos?.length ?? 0) === 0
            ? 'Add repos first.'
            : undefined
        }
        onSettings={
          canOpenSettings
            ? (): void => onOpenWorkspaceSettings(workspace.localId)
            : undefined
        }
        contextMenuActions={
          onShareWorkspaceTemplate === undefined ||
          // Sharing is a tab of the full settings dialog.
          workspaceCapabilities.workspaceSettings !== 'full' ||
          workspace.type !== 'cowork' ||
          workspace.backend === 'remote-control'
            ? undefined
            : [
                {
                  id: 'share-template',
                  label: 'Share template',
                  testId: 'workspace-share-template-menu-item',
                  icon: <ShareIcon />,
                  onSelect: (): void =>
                    onShareWorkspaceTemplate(workspace.localId),
                },
              ]
        }
        onDelete={
          canRemoveWorkspace
            ? (): void => onRemoveWorkspace?.(workspace.localId)
            : undefined
        }
        removalPresentation={
          workspaceRemoval === 'delete' ? 'delete' : 'archive'
        }
      />
    );

    const section = (
      <div
        key={workspace.localId}
        // `relative` seats a drag's drop indicator on this project's edge, as
        // the desktop project section did.
        className="relative min-w-0"
        data-workspace-id={headerless ? undefined : workspace.localId}
        data-workspace-expanded={collapsed ? 'false' : 'true'}
        // The rail's selected-item sync walks UP from the selected row to find
        // the owning workspace, and bails out entirely without this. Distinct
        // from `data-workspace-id` above, which is the portal's own hook —
        // sharing one attribute for both would tie the rail's contract to a
        // test selector.
        data-sidebar-workspace-id={workspace.localId}
      >
        <WorkspaceDropIndicator workspaceLocalId={workspace.localId} />
        {/* Pinned copies of this header and the selected row, portaled into
            the hosts the rail reserves above its occlusion clip. Rendered
            wherever a header is: the component resolves those hosts itself
            and renders nothing where they do not exist, which is every host
            but a rail. Headerless rows have no header to pin, and the Chats
            header above them owns the sticky seat. */}
        {!headerless && (
          <WorkspaceStickyPins
            workspaceLocalId={workspace.localId}
            renderHeader={(surface): ReactNode => (
              // Same two layers as the in-flow header: the sortable wrapper the
              // desktop specs address by surface, around the header itself.
              <WorkspaceHeaderCopyFrame
                className="relative min-w-0"
                data-testid={
                  testIds?.workspaceSortableHeader
                    ? `${testIds.workspaceSortableHeader(workspace.localId)}-${surface}`
                    : undefined
                }
                // The slot copy is a drag surface like the in-flow header (the
                // desktop section's rule: only the selected-item pin copies are
                // not), so a reorder can start from the stuck header.
                data-sidebar-workspace-sortable-header={
                  surface === 'sticky-slot' && sortable
                    ? workspace.localId
                    : undefined
                }
                dimsWhileDragging={surface === 'sticky-slot'}
              >
                {renderWorkspaceHeader(surface)}
              </WorkspaceHeaderCopyFrame>
            )}
            renderSelectedGroupHeader={
              selectedItemBlock?.group &&
              (!selectedItemBlock.group.labelHidden ||
                selectedItemBlock.group.collapsed)
                ? (surface): ReactNode => (
                    <div
                      className="relative pointer-events-none"
                      inert
                      data-testid={`sidebar-item-group-header-frame-${surface}`}
                    >
                      <span
                        aria-hidden="true"
                        className="absolute -left-1.5 inset-y-0 w-0.5 rounded-full"
                        style={{
                          backgroundColor: sidebarItemGroupColor(
                            selectedItemBlock.group?.color ?? 'neutral',
                          ),
                        }}
                      />
                      {selectedItemBlock.group && (
                        <SidebarItemGroupHeader
                          group={selectedItemBlock.group}
                          testIdSuffix={`-${surface}`}
                          status={renderGroupStatus(selectedItemBlock)}
                          count={selectedItemBlock.units.length}
                          unitLabel={{
                            singular: childUnitLabel,
                            plural: childUnitLabelPlural,
                          }}
                          contentId={`${workspace.localId}-${selectedItemBlock.id}-${surface}`}
                          onToggle={(): void => undefined}
                          onCreate={(): void => undefined}
                          onMenu={(): void => undefined}
                        />
                      )}
                    </div>
                  )
                : undefined
            }
            renderSelectedRow={
              selectedWorktreeInFlow === undefined
                ? undefined
                : (surface): ReactNode => (
                    <div className="relative">
                      {selectedItemBlock?.group && (
                        <span
                          aria-hidden="true"
                          className="absolute -left-1.5 inset-y-0 w-0.5 rounded-full"
                          style={{
                            backgroundColor: sidebarItemGroupColor(
                              selectedItemBlock.group.color,
                            ),
                          }}
                        />
                      )}
                      {renderRow(
                        selectedWorktreeInFlow,
                        false,
                        undefined,
                        surface,
                        selectedItemMenu(surface),
                      )}
                    </div>
                  )
            }
          />
        )}
        <SidebarSection
          // No horizontal padding: desktop's rows sit 16px from the rail edge
          // (8px scroll gutter + 8px row inset), and a 4px section inset here
          // pushed every badge and label 4px right of the desktop reference
          // (web chat parity, slice 6).
          className="min-w-0"
          frame={headerless ? 'plain' : 'group'}
          selected={workspaceSelected}
          data-testid={
            typeof testIds?.workspace === 'function'
              ? testIds.workspace(workspace.localId)
              : testIds?.workspace
          }
          collapsible={false}
          collapsed={collapsed}
          // Headerless rows sit directly under the Chats header, so they take
          // no project frame either.
          hideHeader={headerless}
          header={
            // The rail collects `.sidebar-workspace-sticky-header` boxes to
            // decide which project owns the sticky slot. Without one, the slot
            // is filled and never revealed — copies portaled into a host the
            // sync has no reason to un-hide.
            //
            // `flex min-w-0 flex-1`: `SidebarSection` renders its header
            // content as a flex item, and the header itself carries the
            // `flex-1` that makes it span the rail. Interposing a plain block
            // wrapper broke that chain — the wrapper took `flex: 0 1 auto` and
            // shrank to the project name, so hover and selection painted a
            // short pill instead of a full-width row.
            <WorkspaceHeaderCopyFrame
              className="sidebar-workspace-sticky-header flex min-w-0 flex-1"
              data-testid={
                testIds?.workspaceSortableHeader?.(workspace.localId) ??
                'sidebar-workspace-header'
              }
              // The drag surface's mark, as the desktop's own section sets it
              // on the in-flow header and its slot copy.
              data-sidebar-workspace-sortable-header={
                sortable ? workspace.localId : undefined
              }
            >
              {renderWorkspaceHeader('flow')}
            </WorkspaceHeaderCopyFrame>
          }
        >
          {/*
           * `SidebarSection` is deliberately `collapsible={false}` — the
           * chevron lives in the custom `WorkspaceSectionHeader`, and letting
           * the section render its own header button would double-wrap it. The
           * body therefore has to honour `collapsed` here: without this the
           * whole affordance was inert everywhere (only the chevron rotated and
           * a `data-collapsed` attribute nothing styles was stamped), so a
           * workspace could not actually be collapsed on any host.
           */}
          {headerless && collapsed && selectedWorktreeInFlow !== undefined && (
            // Collapsed headerless rows keep exactly the selected one, as a
            // collapsed Chats section does.
            <SidebarList
              className="mt-px min-w-0"
              rowGap={worktreeRowGap ?? 'hairline'}
            >
              {renderRow(selectedWorktreeInFlow, false)}
            </SidebarList>
          )}
          {!collapsed &&
            (rows.visible.length > 0 ||
              rows.hidden.length > 0 ||
              itemBlocks.length > 0 ||
              pendingBaselines.has(workspace.localId) ||
              (archivedCount !== undefined && archivedItemCount > 0) ||
              renderArchivedSection !== undefined ||
              showsEmptyState) && (
              // 1px under the header and 1px between rows: the legacy
              // ProjectSection's `mt-px` / `space-y-px`. The rail's
              // sticky-seat geometry measures it rather than assuming it.
              <div
                className="mt-px min-w-0"
                // The workspace's rows surface, as the desktop project section
                // marked it: the rail's layout cache and project-drag geometry
                // find a header's rows by this mark.
                data-sidebar-folder-content={
                  workspaceType === 'cowork'
                    ? 'cowork-workspace'
                    : 'code-workspace'
                }
              >
                {showsEmptyState ? (
                  <div
                    className={`py-2 ${SIDEBAR_ROW_TEXT_INSET_CLASSNAME} pr-2 text-s fg-quaternary`}
                    data-testid={testIds?.workspaceEmpty?.(workspace.localId)}
                  >
                    {workspaceCapabilities.workspaceContents === false
                      ? 'Not available here yet'
                      : `No ${childUnitLabelPlural}`}
                  </div>
                ) : (
                  wrappedVisibleList
                )}
                {rows.hidden.length > 0 && (
                  <div
                    className="mt-0.5 min-w-0"
                    data-testid={testIds?.hiddenWorktreesSection}
                  >
                    <HiddenItemsRow
                      label={`Hidden ${WORKTREE_UNIT_LABEL_PLURAL}`}
                      count={rows.hidden.length}
                      expanded={
                        hiddenWorktreesExpanded[workspace.localId] === true
                      }
                      onToggle={(): void =>
                        setHiddenWorktreesExpanded((previous) => ({
                          ...previous,
                          [workspace.localId]:
                            previous[workspace.localId] !== true,
                        }))
                      }
                      dataTestId={testIds?.hiddenWorktreesToggle?.(
                        workspace.localId,
                      )}
                    />
                    {hiddenWorktreesExpanded[workspace.localId] === true && (
                      <SidebarList className="mt-0.5" rowGap="thin" quiet>
                        {rows.hidden.map((worktree) =>
                          renderRow(worktree, true),
                        )}
                      </SidebarList>
                    )}
                  </div>
                )}
                {renderArchivedSection?.(workspace.localId)}
                {!renderArchivedSection &&
                  archivedCount !== undefined &&
                  archivedItemCount > 0 && (
                    <div
                      className="mt-1"
                      data-testid="archived-worktrees-section"
                      data-archived-workspace-id={workspace.localId}
                    >
                      <SidebarToggleRow
                        label={`Archived (${archivedItemCount})`}
                        expanded={archivedIsExpanded}
                        leading={<ArchiveIcon size="sm" />}
                        testId={testIds?.archivedWorktreesToggle?.(
                          workspace.localId,
                        )}
                        onToggle={(): void => {
                          const nextExpanded = !archivedIsExpanded;
                          if (onArchivedExpandedChange) {
                            onArchivedExpandedChange(
                              workspace.localId,
                              nextExpanded,
                            );
                          } else {
                            setArchivedExpandedOverrides((previous) => ({
                              ...previous,
                              [workspace.localId]: nextExpanded,
                            }));
                          }
                        }}
                      />
                      {archivedIsExpanded &&
                        (archivedItems === undefined ? (
                          <div className="flex items-center gap-2 px-2 py-1.5">
                            {archivedLoadStates[workspace.localId] ===
                              'loading' && <LoadingSpinner tone="secondary" />}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {archivedItems.map((entry) => (
                              <div
                                key={entry.id}
                                className="group relative flex min-w-0 items-center rounded-row hover:bg-subtle"
                              >
                                <button
                                  type="button"
                                  data-testid={testIds?.archivedWorktreeRow?.(
                                    workspace.localId,
                                    entry.id,
                                  )}
                                  data-project-id={workspace.localId}
                                  data-archived-worktree-id={entry.id}
                                  onClick={(): void =>
                                    onViewArchived?.(
                                      workspace.localId,
                                      entry.id,
                                    )
                                  }
                                  className="focus-ring flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-row py-1 pl-8 pr-1.5 text-left group-hover:pr-8 group-focus-within:pr-8"
                                >
                                  <span className="min-w-0 flex-1">
                                    <span
                                      className={`${REPLAY_MASK_CLASS} block truncate text-s leading-snug fg-secondary`}
                                    >
                                      {entry.title}
                                    </span>
                                    {entry.subtitle && (
                                      <span
                                        className={`${REPLAY_MASK_CLASS} block truncate text-2xs fg-secondary`}
                                      >
                                        {entry.subtitle}
                                      </span>
                                    )}
                                  </span>
                                  {entry.locked && (
                                    <Lock
                                      size={10}
                                      aria-label="Locked"
                                      data-testid={`archived-worktree-lock-${entry.id}`}
                                      className="shrink-0 fg-warning"
                                    />
                                  )}
                                  {entry.timestamp && (
                                    <span className="shrink-0 text-2xs fg-secondary">
                                      {entry.timestamp}
                                    </span>
                                  )}
                                </button>
                                {renderArchivedActions ? (
                                  <span className="absolute inset-y-0 right-1 flex items-center">
                                    {renderArchivedActions(
                                      workspace.localId,
                                      entry,
                                    )}
                                  </span>
                                ) : onRestoreArchived ? (
                                  <Button
                                    variant="ghost-quiet"
                                    size="compact"
                                    iconOnly
                                    aria-label={`Restore ${entry.title}`}
                                    onClick={(): void =>
                                      onRestoreArchived(
                                        workspace.localId,
                                        entry.id,
                                      )
                                    }
                                  >
                                    <RefreshIcon size="sm" />
                                  </Button>
                                ) : null}
                                {!renderArchivedActions && onDeleteArchived && (
                                  <Button
                                    variant="ghost-quiet"
                                    size="compact"
                                    iconOnly
                                    aria-label={`Delete ${entry.title}`}
                                    onClick={(): void =>
                                      onDeleteArchived(
                                        workspace.localId,
                                        entry.id,
                                      )
                                    }
                                  >
                                    <TrashIcon size={16} />
                                  </Button>
                                )}
                              </div>
                            ))}
                          </div>
                        ))}
                    </div>
                  )}
              </div>
            )}
        </SidebarSection>
        {renderWorkspaceDialogs?.({ workspace, canOpenSettings })}
      </div>
    );
    // Only hand the section to the DnD wrapper when it is actually
    // sortable — a host wrapper may call useSortable, which requires an
    // ancestor DndContext that reorder-disabled hosts never mount.
    return sortable
      ? (wrapWorkspaceSection?.({ workspace, hidden, sortable }, section) ??
          section)
      : section;
  };

  return (
    <div className={className} data-testid={testIds?.root}>
      {projectPage.projects.map((workspace, index) =>
        'node' in workspace ? (
          <Fragment key={workspace.localId}>{workspace.node}</Fragment>
        ) : (
          renderWorkspace(workspace, false, index, projectPage.projects.length)
        ),
      )}
      <ProjectListPagination
        remainingCount={projectPage.remainingCount}
        expanded={projectPage.expanded}
        onShowMore={projectPage.showMore}
        onShowLess={projectPage.showLess}
        touchTargets={touchTargets}
        compactLabels={compactProjectPagination}
      />
      <PendingProjectRows projects={pendingProjects} />
      {additionalRows}
      {partitions.hidden.length > 0 && (
        <div className="pt-1 flex flex-col gap-1">
          <HiddenItemsRow
            label="Hidden projects"
            count={partitions.hidden.length}
            expanded={hiddenWorkspacesExpanded}
            onToggle={(): void =>
              setHiddenWorkspacesExpanded((previous) => !previous)
            }
            dataTestId={testIds?.hiddenWorkspacesToggle}
          />
          {hiddenWorkspacesExpanded && (
            <div className="flex flex-col gap-1 opacity-80">
              {partitions.hidden.map((workspace, index) =>
                renderWorkspace(
                  workspace,
                  true,
                  index,
                  partitions.hidden.length,
                ),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
