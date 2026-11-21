import type { JSX } from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { RemoteControlRowBackend } from '@canopy/protocol/remote-control/shell';
import type {
  SidebarBatchUnitLabel,
  SpaceNotificationMenuChoice,
  SpaceNotificationMenuState,
  WorktreeDirectAction,
  WorktreeMenuItem,
} from '@canopy/ui-shared/components';
import {
  SPACE_NOTIFICATION_MENU_HEADING,
  SpaceNotificationMenuRowIcon,
  spaceNotificationMenuChoices,
  spaceNotificationMenuStatus,
  spaceNotificationMenuUnavailable,
} from '@canopy/ui-shared/components';
import type { AppIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  deriveSelectionMenuItems,
  type SidebarBatchActionAvailability,
  type SidebarBatchActionState,
  type SidebarBatchAvailabilityRow,
  type SidebarBulkStateAction,
  type SidebarBulkStateActions,
} from './sidebar-selection-menu-items';
import {
  ArchiveIcon,
  BellIcon,
  BranchIcon,
  BuildingIcon,
  BugReportIcon,
  FormatIndentDecreaseIcon,
  FormatIndentIncreaseIcon,
  GitMergeIcon,
  EyeIcon,
  EyeOffIcon,
  GitPullRequestIcon,
  InfoIcon,
  LabelIcon,
  ListChecks,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PipelineIcon,
  RocketLaunchIcon,
  StopIcon,
  WorktreeIcon,
  TemporaryMultiRepoIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';

export interface WorktreeMenuContext {
  /** The row's user-facing unit. Cowork tree rows are sessions, not worktrees. */
  readonly subject: 'worktree' | 'session';
  readonly retentionDays?: number;
  readonly label: string;
  readonly branch: string;
  readonly hidden: boolean;
  /** Pinned to the top of its section; only hosts with pinning set it. */
  readonly pinned?: boolean;
  readonly done: boolean;
  readonly backend?: RemoteControlRowBackend;
  readonly launchAvailable: boolean;
  readonly launchRunning: boolean;
  /**
   * Host-owned: one or more of the row's scripts (launch, setup or any other)
   * is running and the host can stop them. Absent reads as none running.
   */
  readonly scriptsRunning?: boolean;
  readonly pipelineAvailable: boolean;
  /** Early access: rows read in sentence case ("Dispatch pipeline"). */
  readonly sentenceCaseLabels?: boolean;
  readonly splitPrEligible: boolean;
  readonly splitPrLocked: boolean;
  readonly splitPrBlockers: readonly string[];
  readonly groupingAction?: {
    readonly kind:
      | 'ungroup-from-base'
      | 'ungroup-children'
      | 'group-children'
      | 'group-with-base';
  };
  readonly addRepositoryAvailable: boolean;
  /** A saved attempt to resume or cancel keeps the item enabled. */
  readonly addRepositoryResumable?: boolean;
  readonly hasActiveSession: boolean;
  readonly setupPhase?: 'git-pending' | 'running-setup';
  readonly removalLockedBySplitPr: boolean;
  /**
   * Host-owned verdict that the hover-revealed removal chip may show on a row
   * that is not done: desktop shows Delete on a clean worktree (no line
   * changes, nothing uncommitted, nothing ahead or unpushed, or one created
   * moments ago whose stats have not loaded). The shared code has none of
   * that local-git state, so the host decides and the menu only renders it.
   */
  readonly directRemovalAvailable?: boolean;
  /**
   * Host-owned: this row's removal is already in flight (teardown, capture).
   * Removal is disabled, so the hover chip leaves the row, as on the legacy
   * desktop row.
   */
  readonly removalInProgress?: boolean;
  /**
   * Host-owned saved notification choice for this space. Absent when the host
   * cannot identify the space, in which case no choices are offered rather
   * than a default the host cannot vouch for.
   */
  readonly notifications?: SpaceNotificationMenuState;
  /**
   * Early access: the label row reads "Rename" with a pencil, as the Cowork
   * row's own menu does. Absent, it keeps "Set label" with the label glyph.
   */
  readonly renameLabelAction?: boolean;
  /** The row is in the bulk selection: its Select multiple item reads Deselect. */
  readonly multiSelected?: boolean;
  /**
   * The row belongs to a bulk selection of 2 or more. Its menu is then the
   * selection's: its state actions, Archive N, Delete N, and Clear
   * selection, nothing else.
   */
  readonly bulkSelection?: {
    readonly count: number;
    readonly availability: SidebarBatchActionAvailability;
    /** Names the rows: worktrees, or chats for cloud chat sessions. */
    readonly unitLabel: SidebarBatchUnitLabel;
    /** What every selected row's own menu offers: Pin, Hide, Notifications. */
    readonly stateActions?: SidebarBulkStateActions;
  };
}

/** Neutral equivalent of the desktop deriveSplitPrEligibilityInputs result. */
export interface SplitPrEligibilityInputs {
  readonly prState?: 'open' | 'closed' | 'merged' | 'draft';
  readonly prAdditions?: number;
  readonly prDeletions?: number;
  readonly diffStats?: {
    readonly insertions: number;
    readonly deletions: number;
  };
  readonly splitPrEnabled: boolean;
  readonly thresholdLines: number;
  readonly isSingleRepo: boolean;
}

export function isSplitPrEligible(inputs: SplitPrEligibilityInputs): boolean {
  const lineCount =
    inputs.prAdditions !== undefined && inputs.prDeletions !== undefined
      ? inputs.prAdditions + inputs.prDeletions
      : inputs.diffStats
        ? inputs.diffStats.insertions + inputs.diffStats.deletions
        : undefined;
  return (
    inputs.splitPrEnabled &&
    inputs.isSingleRepo &&
    inputs.prState === 'open' &&
    lineCount !== undefined &&
    lineCount >= inputs.thresholdLines
  );
}

export interface WorktreeMenuCapabilities {
  readonly pipelines: CanopyCapabilities['pipelines'];
  readonly worktreeSplitPr?: boolean;
  readonly worktreeBranchGrouping?: boolean;
  readonly worktreeRepositoryAttachment?: boolean;
  readonly removal: {
    readonly behavior: false | 'archive' | 'delete';
    readonly presentation?: 'archive' | 'delete';
    readonly retention?: 'archive-or-delete';
  };
}

export interface WorktreeMenuCallbacks {
  readonly onSelectItemRequested?: () => void;
  readonly onSetLabelRequested?: () => void;
  readonly onBranchInfoRequested?: () => void;
  readonly onDebugInfoRequested?: () => void;
  readonly onLaunchRequested?: () => void;
  /** Stops every script running in the row's worktree. */
  readonly onStopRunningScriptsRequested?: () => void;
  readonly onDispatchPipelineRequested?: () => void;
  readonly onSplitPrRequested?: () => void;
  readonly onCreateBranchRequested?: () => void;
  readonly onGroupingRequested?: () => void | Promise<void>;
  readonly onAddRepositoryRequested?: () => void;
  /**
   * Opens the host's Move to organization dialog for the row's project. The
   * host supplies it only for a Personal project it can move.
   */
  readonly onMoveToOrganizationRequested?: () => void;
  readonly onToggleHiddenRequested?: () => void;
  /** Pin or unpin the row at the top of its section; desktop only. */
  readonly onTogglePinnedRequested?: () => void;
  readonly onRemovalRequested?: (mode?: 'archive' | 'delete') => void;
  /** Opens the batch confirm for the whole selection. */
  readonly onBulkRemovalRequested?: (mode: 'archive' | 'delete') => void;
  /** Runs one state action on every selected row that needs it. */
  readonly onBulkStateActionRequested?: (
    action: SidebarBulkStateAction,
  ) => void;
  /** Saves this space's notification choice; `null` clears the override. */
  readonly onNotificationChoiceRequested?: (
    choice: SpaceNotificationMenuChoice,
  ) => void;
  readonly testIds?: Partial<Readonly<Record<WorktreeMenuTestIdKey, string>>>;
}

export type WorktreeMenuTestIdKey =
  | 'setLabel'
  | 'branchInfo'
  | 'debugInfo'
  | 'launch'
  | 'stopScripts'
  | 'dispatchPipeline'
  | 'splitPr'
  | 'grouping'
  | 'addRepository'
  | 'moveToOrganization'
  | 'createBranch'
  | 'toggleHidden'
  | 'togglePin'
  /** Prefix for the notification rows: `<id>-notify-mute`, `<id>-status`. */
  | 'notifications'
  | 'removal'
  | 'directRemoval'
  /** The hover-revealed Show chip on a hidden row. */
  | 'directShow'
  | 'delete'
  /**
   * The single removal item when it presents as Delete. Hosts that address
   * Delete apart from Archive (desktop's automation) set it; the shared
   * `removal` id serves otherwise, so the portal's contract is unchanged.
   */
  | 'removalDelete'
  | 'bulkPin'
  | 'bulkStopScripts'
  | 'bulkArchive'
  | 'bulkDelete';

export interface DerivedWorktreeMenu {
  readonly items: readonly WorktreeMenuItem[];
  readonly directActions: readonly WorktreeDirectAction[];
}

const GROUPING_LABELS = {
  'ungroup-from-base': 'Unstack from base',
  'ungroup-children': 'Unstack children',
  'group-children': 'Stack children',
  'group-with-base': 'Stack on base',
} as const;

export type WorktreeGroupingActionKind = keyof typeof GROUPING_LABELS;

/**
 * The shared and fallback desktop rails use the same action glyphs. Stack
 * direction and scope each have a distinct catalog glyph. Pin/Unpin
 * intentionally share a glyph as opposite states of the same action.
 */
export const WORKTREE_GROUPING_GLYPHS: Readonly<
  Record<WorktreeGroupingActionKind, JSX.Element>
> = {
  'group-with-base': <FormatIndentIncreaseIcon />,
  'ungroup-from-base': <FormatIndentDecreaseIcon />,
  'group-children': <GitMergeIcon />,
  'ungroup-children': <WorktreeIcon />,
};

/**
 * Rows that are rare or for advanced setups. The compact menu moves them into
 * one "More" submenu so the frequent rows stay short; nothing is removed.
 */
const MORE_MENU_KEYS: ReadonlySet<WorktreeMenuItem['key']> = new Set([
  'branch-info',
  'debug-info',
  'dispatch-pipeline',
  'split-pr',
  'create-branch',
  'ungroup-from-base',
  'ungroup-children',
  'group-children',
  'group-with-base',
  'add-repository',
  'split-workspace',
  'toggle-hidden',
]);

/**
 * Early access: folds the rare rows of a worktree menu into "More ›", placed
 * just before the removal rows (Archive, Delete), which keep a divider above
 * them. Every row stays reachable; the order inside More keeps the menu's.
 */
export function foldWorktreeMenuIntoMore(
  items: readonly WorktreeMenuItem[],
): WorktreeMenuItem[] {
  const more = items
    .filter((item) => MORE_MENU_KEYS.has(item.key))
    .map((item) => ({ ...item, separatorBefore: false }));
  if (more.length === 0) return [...items];
  const rest = items.filter((item) => !MORE_MENU_KEYS.has(item.key));
  const removalIndex = rest.findIndex(
    (item) => item.key === 'archive' || item.key === 'delete',
  );
  const moreItem: WorktreeMenuItem = {
    key: 'more',
    kind: 'submenu',
    label: 'More',
    icon: <MoreHorizontalIcon />,
    submenu: more,
    testId: 'worktree-actions-menu-more',
  };
  if (removalIndex === -1) return [...rest, moreItem];
  const removal = rest[removalIndex];
  return [
    ...rest.slice(0, removalIndex),
    moreItem,
    ...(removal ? [{ ...removal, separatorBefore: true }] : []),
    ...rest.slice(removalIndex + 1),
  ];
}

/** The per-row facts that decide whether a removal can run right now. */
export interface WorktreeRemovalBlockInputs {
  readonly removalLockedBySplitPr: boolean;
  readonly removalInProgress: boolean;
  /** A streaming chat or a live managed delegate on the worktree. */
  readonly hasActiveSession?: boolean;
  readonly setupPhase?: 'git-pending' | 'running-setup';
}

/**
 * Why a worktree's removal can't run right now, or `undefined` when nothing
 * blocks it. Bulk removal lists a blocked row under Not included with this
 * reason, so it and the single row say the same thing.
 */
export function worktreeRemovalBlockedReason({
  removalLockedBySplitPr,
  removalInProgress,
  hasActiveSession,
  setupPhase,
}: WorktreeRemovalBlockInputs): string | undefined {
  if (removalInProgress) return 'Removal is already in progress';
  if (removalLockedBySplitPr) {
    return 'A Split PR is in progress; it must finish before archiving.';
  }
  if (hasActiveSession === true) return 'Stop all sessions before archiving';
  if (setupPhase !== undefined) return 'Wait for setup to finish';
  return undefined;
}

/**
 * Why a worktree's Archive can't run right now, for a control that stays
 * shown while unavailable (early-access compact rows). An active session is
 * the remaining case when the caller has no other fact.
 */
export function worktreeArchiveBlockedReason(
  inputs: WorktreeRemovalBlockInputs,
): string {
  return (
    worktreeRemovalBlockedReason(inputs) ?? 'Stop all sessions before archiving'
  );
}

export {
  batchActionAvailability,
  type SidebarBatchActionAvailability,
  type SidebarBatchActionState,
  type SidebarBatchAvailabilityRow,
} from './sidebar-selection-menu-items';
export type WorktreeBatchAvailabilityRow = SidebarBatchAvailabilityRow;
export type WorktreeBatchActionState = SidebarBatchActionState;
export type WorktreeBatchActionAvailability = SidebarBatchActionAvailability;

export function deriveWorktreeMenuItems(
  context: WorktreeMenuContext,
  capabilities: WorktreeMenuCapabilities,
  callbacks: WorktreeMenuCallbacks,
): DerivedWorktreeMenu {
  if (
    context.bulkSelection !== undefined &&
    context.bulkSelection.count >= 2 &&
    callbacks.onBulkRemovalRequested
  ) {
    return {
      items: deriveSelectionMenuItems({
        availability: context.bulkSelection.availability,
        onBulkRemoval: callbacks.onBulkRemovalRequested,
        stateActions: context.bulkSelection.stateActions,
        onStateAction: callbacks.onBulkStateActionRequested,
        testIds: callbacks.testIds,
      }),
      directActions: [],
    };
  }
  const items: WorktreeMenuItem[] = [];
  if (callbacks.onTogglePinnedRequested) {
    // Same wording and first position as the desktop's own row menu.
    items.push({
      key: 'toggle-pin',
      label: context.pinned ? 'Unpin' : 'Pin to top',
      icon: <PinIcon />,
      onSelect: callbacks.onTogglePinnedRequested,
      testId: callbacks.testIds?.togglePin,
    });
  }
  if (callbacks.onSetLabelRequested) {
    items.push({
      key: 'set-label',
      label: context.renameLabelAction === true ? 'Rename' : 'Set label',
      icon: context.renameLabelAction === true ? <PencilIcon /> : <LabelIcon />,
      onSelect: callbacks.onSetLabelRequested,
      testId: callbacks.testIds?.setLabel,
    });
  }
  if (callbacks.onBranchInfoRequested) {
    items.push({
      key: 'branch-info',
      label: 'Branch info',
      icon: <InfoIcon />,
      onSelect: callbacks.onBranchInfoRequested,
      testId: callbacks.testIds?.branchInfo,
    });
  }
  if (callbacks.onDebugInfoRequested) {
    items.push({
      key: 'debug-info',
      label: 'Debug info',
      icon: <BugReportIcon />,
      onSelect: callbacks.onDebugInfoRequested,
      testId: callbacks.testIds?.debugInfo,
    });
  }
  if (context.launchAvailable && callbacks.onLaunchRequested) {
    items.push({
      key: 'launch',
      label: 'Launch',
      icon: <RocketLaunchIcon />,
      onSelect: callbacks.onLaunchRequested,
      disabled: context.launchRunning,
      tooltip: context.launchRunning
        ? 'Launch script is already running'
        : undefined,
      testId: callbacks.testIds?.launch,
    });
  }
  if (
    context.scriptsRunning === true &&
    callbacks.onStopRunningScriptsRequested
  ) {
    items.push({
      key: 'stop-scripts',
      label: 'Stop running scripts',
      icon: <StopIcon />,
      onSelect: callbacks.onStopRunningScriptsRequested,
      testId: callbacks.testIds?.stopScripts,
    });
  }
  if (
    context.pipelineAvailable &&
    capabilities.pipelines !== 'read-only' &&
    callbacks.onDispatchPipelineRequested
  ) {
    items.push({
      key: 'dispatch-pipeline',
      label:
        context.sentenceCaseLabels === true
          ? 'Dispatch workflow'
          : 'Dispatch workflow',
      icon: <PipelineIcon />,
      onSelect: callbacks.onDispatchPipelineRequested,
      testId: callbacks.testIds?.dispatchPipeline,
    });
  }
  if (
    capabilities.worktreeSplitPr === true &&
    // A done worktree's PR has shipped; the legacy row never offered it one.
    !context.done &&
    context.splitPrEligible &&
    callbacks.onSplitPrRequested
  ) {
    // A blocked Split PR stays in the menu, disabled, and explains itself in
    // a hover card (title plus one line per blocker), as desktop's row did.
    const splitPrBlockedReasons = context.splitPrLocked
      ? ['A Split PR is already in progress for this worktree.']
      : context.splitPrBlockers;
    items.push({
      key: 'split-pr',
      label: 'Split PR…',
      icon: <GitPullRequestIcon />,
      onSelect: callbacks.onSplitPrRequested,
      testId: callbacks.testIds?.splitPr,
      disabled: splitPrBlockedReasons.length > 0,
      richTooltip:
        splitPrBlockedReasons.length > 0 ? (
          <SplitPrBlockedTooltip reasons={splitPrBlockedReasons} />
        ) : undefined,
    });
  }
  if (!context.done && callbacks.onCreateBranchRequested) {
    items.push({
      key: 'create-branch',
      label: 'Branch from',
      icon: <BranchIcon size="md" />,
      onSelect: callbacks.onCreateBranchRequested,
      testId: callbacks.testIds?.createBranch,
    });
  }
  if (
    capabilities.worktreeBranchGrouping === true &&
    context.groupingAction &&
    callbacks.onGroupingRequested
  ) {
    items.push({
      key: context.groupingAction.kind,
      label: GROUPING_LABELS[context.groupingAction.kind],
      icon: WORKTREE_GROUPING_GLYPHS[context.groupingAction.kind],
      onSelect: callbacks.onGroupingRequested,
      testId: callbacks.testIds?.grouping,
    });
  }
  if (
    capabilities.worktreeRepositoryAttachment === true &&
    context.addRepositoryAvailable &&
    callbacks.onAddRepositoryRequested
  ) {
    const disabled =
      context.addRepositoryResumable !== true &&
      (context.hasActiveSession ||
        context.done ||
        context.setupPhase !== undefined);
    items.push({
      key: 'add-repository',
      label: 'Add repository',
      icon: <TemporaryMultiRepoIcon />,
      onSelect: callbacks.onAddRepositoryRequested,
      testId: callbacks.testIds?.addRepository,
      disabled,
      tooltip: !disabled
        ? undefined
        : context.hasActiveSession
          ? 'Stop active sessions before adding a repo'
          : context.done
            ? 'Done worktrees cannot add repos'
            : context.setupPhase !== undefined
              ? 'Wait for setup to finish before adding a repo'
              : undefined,
    });
  }
  if (callbacks.onMoveToOrganizationRequested) {
    // The move unit is the project: every worktree in it moves together.
    items.push({
      key: 'move-to-organization',
      label: 'Move to org…',
      icon: <BuildingIcon size="xl" />,
      onSelect: callbacks.onMoveToOrganizationRequested,
      testId: callbacks.testIds?.moveToOrganization,
    });
  }
  items.push(...deriveNotificationItems(context, callbacks, items.length > 0));
  if (callbacks.onSelectItemRequested) {
    items.push({
      key: 'toggle-selection',
      label: 'Select multiple',
      icon: <ListChecks />,
      onSelect: callbacks.onSelectItemRequested,
    });
  }
  if (callbacks.onToggleHiddenRequested) {
    items.push({
      key: 'toggle-hidden',
      label: context.hidden ? 'Show' : 'Hide',
      icon: context.hidden ? <EyeIcon /> : <EyeOffIcon />,
      onSelect: callbacks.onToggleHiddenRequested,
      separatorBefore: true,
      testId: callbacks.testIds?.toggleHidden,
    });
  }
  const removalPresentation =
    capabilities.removal.presentation ?? capabilities.removal.behavior;
  if (capabilities.removal.behavior !== false && callbacks.onRemovalRequested) {
    const destructive = removalPresentation === 'delete';
    const archiveLabel =
      context.subject === 'session' ? 'Archive session' : 'Archive';
    const disabled =
      context.removalLockedBySplitPr ||
      context.hasActiveSession ||
      context.removalInProgress === true;
    if (capabilities.removal.retention === 'archive-or-delete') {
      items.push({
        key: 'archive',
        label: 'Archive',
        icon: <ArchiveIcon />,
        tooltip: 'Kept until you delete it',
        onSelect: () => callbacks.onRemovalRequested?.('archive'),
        disabled,
        tone: 'default',
        separatorBefore: !callbacks.onToggleHiddenRequested,
        testId: callbacks.testIds?.removal,
      });
      items.push({
        key: 'delete',
        label: 'Delete',
        icon: <TrashIcon />,
        tooltip:
          context.retentionDays === undefined
            ? 'Kept for a while, then removed'
            : `Kept for ${context.retentionDays} ${context.retentionDays === 1 ? 'day' : 'days'}, then removed`,
        onSelect: () => callbacks.onRemovalRequested?.('delete'),
        disabled,
        // Retained for the window, then removed: recoverable, so it reads
        // neutral like Archive. Only permanent deletion is destructive.
        tone: 'default',
        testId: callbacks.testIds?.delete,
      });
    } else
      items.push({
        key: destructive ? 'delete' : 'archive',
        label: destructive ? 'Delete' : archiveLabel,
        icon: destructive ? <TrashIcon /> : <ArchiveIcon />,
        onSelect: callbacks.onRemovalRequested,
        disabled,
        tooltip: context.removalLockedBySplitPr
          ? 'Removal is locked while Split PR is active.'
          : context.hasActiveSession
            ? 'Stop the active session before removing this worktree.'
            : undefined,
        tone: destructive ? 'destructive' : 'default',
        separatorBefore: !callbacks.onToggleHiddenRequested,
        testId: destructive
          ? (callbacks.testIds?.removalDelete ?? callbacks.testIds?.removal)
          : callbacks.testIds?.removal,
      });
  }
  const retention = capabilities.removal.retention === 'archive-or-delete';
  const directPresentation = retention ? 'delete' : removalPresentation;
  const removalItem = items.find((item) =>
    retention
      ? item.key === 'delete'
      : item.key === 'archive' || item.key === 'delete',
  );
  // Cloud task rows have no desktop done/merged lifecycle. Their retention
  // shortcut uses the same availability and confirmation as menu Delete.
  const directRemovalEligible =
    context.done ||
    (retention && context.backend === 'cloud') ||
    context.directRemovalAvailable === true;
  // A hidden row reveals Show ahead of any removal chip, as desktop does.
  const showAction: WorktreeDirectAction[] =
    context.hidden && callbacks.onToggleHiddenRequested
      ? [
          {
            key: 'show',
            icon: EyeIcon,
            label: 'Show',
            onSelect: callbacks.onToggleHiddenRequested,
            tone: 'neutral',
            testId: callbacks.testIds?.directShow,
          },
        ]
      : [];
  const removeAction: WorktreeDirectAction[] =
    directRemovalEligible && removalItem?.onSelect && !removalItem.disabled
      ? [
          {
            key: 'remove',
            icon: destructiveIcon(directPresentation),
            // A session names itself, never its branch: an untitled cloud
            // session's branch is the synthetic `cloud` placeholder.
            label: `${directPresentation === 'delete' ? 'Delete' : 'Archive'} ${
              context.subject === 'session'
                ? context.label
                  ? `session ${context.label}`
                  : 'session'
                : context.label || context.branch
            }`,
            onSelect: removalItem.onSelect,
            // A retained Delete is recoverable and reads neutral, as the
            // menu item does; only a permanent delete is destructive.
            tone:
              directPresentation === 'delete' && !retention
                ? 'destructive'
                : 'neutral',
            testId: callbacks.testIds?.directRemoval,
            visibility: 'fine-pointer',
          },
        ]
      : [];
  return {
    items,
    directActions: [...showAction, ...removeAction],
  };
}

/**
 * Moves the notification choices out of the menu's own rows and
 * into one "Notifications ›" submenu, in the place the group held. The choices
 * keep their checks, pending spinner and status line; the submenu's label
 * replaces the group heading.
 */
export function foldWorktreeNotificationsIntoSubmenu(
  items: readonly WorktreeMenuItem[],
): WorktreeMenuItem[] {
  const first = items.findIndex((item) => item.role === 'menuitemradio');
  if (first === -1) return [...items];
  const choices = items
    .filter((item) => item.role === 'menuitemradio')
    .map((item) => ({
      ...item,
      separatorBefore: false,
      sectionLabel: undefined,
    }));
  const submenuItem: WorktreeMenuItem = {
    key: 'notifications',
    kind: 'submenu',
    label: SPACE_NOTIFICATION_MENU_HEADING,
    icon: <BellIcon />,
    submenu: choices,
    testId: 'worktree-actions-menu-notifications',
  };
  return [
    ...items.slice(0, first),
    submenuItem,
    ...items.slice(first).filter((item) => item.role !== 'menuitemradio'),
  ];
}

/**
 * The three notification choices as one labelled radio group. The selected
 * row is always the choice the server last acknowledged.
 */
function deriveNotificationItems(
  context: WorktreeMenuContext,
  callbacks: WorktreeMenuCallbacks,
  hasPrecedingItems: boolean,
): readonly WorktreeMenuItem[] {
  const state = context.notifications;
  const request = callbacks.onNotificationChoiceRequested;
  if (!state || !request || spaceNotificationMenuUnavailable(state)) return [];
  const prefix = callbacks.testIds?.notifications;
  const rows = spaceNotificationMenuChoices(state);
  const status = spaceNotificationMenuStatus(state);
  return rows.map((row, index): WorktreeMenuItem => {
    const last = index === rows.length - 1;
    return {
      key: row.key,
      label: row.label,
      icon: <SpaceNotificationMenuRowIcon row={row} />,
      role: 'menuitemradio',
      checked: row.checked,
      busy: row.pending,
      disabled: row.disabled,
      tooltip: row.description,
      onSelect: row.selectable ? (): void => request(row.choice) : undefined,
      separatorBefore: index === 0 && hasPrecedingItems,
      sectionLabel: index === 0 ? SPACE_NOTIFICATION_MENU_HEADING : undefined,
      sectionStatus: last ? status : undefined,
      sectionStatusTestId:
        last && prefix !== undefined ? `${prefix}-status` : undefined,
      testId: prefix === undefined ? undefined : `${prefix}-${row.key}`,
    };
  });
}

function SplitPrBlockedTooltip({
  reasons,
}: {
  readonly reasons: readonly string[];
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

function destructiveIcon(presentation: false | 'archive' | 'delete'): AppIcon {
  return presentation === 'delete' ? TrashIcon : ArchiveIcon;
}
