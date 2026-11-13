'use client';

import {
  SidebarAutoDeleteProvider,
  SidebarAutoDeleteNotice,
  useSidebarAutoDeleteMenu,
} from './SidebarAutoDelete';

import { Surface, Stack, Heading } from '@canopy/ui-shared/components';
import { DEFAULT_ARCHIVE_RETENTION_DAYS } from '@canopy/protocol/archive-retention';
import { useSidebarHeaderRest } from '@canopy/ui-shared/lib';
import {
  offerLifecycleJournalQuarantine,
  offerProjectDeletionDiscard,
} from '@canopy/app-state';

import {
  WORKSPACE_LABEL_PLURAL,
  defaultCoworkWorkspaceIdForContext,
} from '@canopy/protocol/ui-labels';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type {
  CanopyCapabilities,
  WorkspaceCreateResult,
  WorktreeCreateResult,
} from '@canopy/app-core';
import type {
  PortalRowBackend,
  PortalWorkspaceCreatePayload,
} from '@canopy/protocol/portal';
import {
  DEFAULT_SIDEBAR_NAV_LAYOUT,
  splitSidebarNavLayout,
  type SidebarNavLayout,
} from '@canopy/protocol/sidebar';
import {
  ConfirmDialog,
  TitlebarIconButton,
  PipelinePickerDialog,
  WorkspaceIconDisclosureSwap,
  ProjectAvatarBadge,
  type SpaceNotificationMenuChoice,
  type SpaceNotificationMenuState,
  type WorktreeMenuItem,
  type WorktreeSetupPhase,
  DeferredWorkspaceSettingsDialog,
  type WorkspaceSettingsDangerCopy,
  WorktreeActionsMenu,
  worktreeActionsMenuButtonCount,
  type WorktreeDirectAction,
  WorktreeInfoDialog,
  isSpaceNotificationMuted,
  type PipelineStatusPopoverEntry,
  type TerminalPopoverRow,
  EmptyStateRow,
} from '@canopy/ui-shared/components';
import { SidebarMoreControl } from '@canopy/ui-shared';
import {
  RailSectionHeader,
  SidebarSelectionHeaderActions,
  SidebarSelectionToolbar,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuDivider,
  SearchField,
  SIDEBAR_LIST_ICON_CLASSNAME,
  SIDEBAR_NAV_ICON_CLASSNAME,
  sidebarNavIconItemClassName,
  sidebarNavItemClassName,
  SidebarNavRow,
  Tooltip,
  useDropdownMenuRowStyle,
  useIsMobile,
} from '@canopy/ui-shared/components';
import {
  ArchiveBoxIcon,
  ChevronDownMediumIcon,
  ListChecks,
  EditBigIcon,
  PinFilledIcon,
  PinIcon,
  SearchIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  getSidebarNavItemDefs,
  type SidebarNavItemDef,
  type SidebarNavItemKey,
} from './sidebar-nav-items';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';
import { SidebarPipelineStatusPopover } from './SidebarPipelineStatusPopover';
import { SidebarTerminalStatusPopover } from './SidebarTerminalStatusPopover';
import { SortableWorkspacesSidebar } from './SortableWorkspacesSidebar';
import {
  SidebarChatsSkeleton,
  SidebarProjectsSkeleton,
} from './SidebarProjectsSkeleton';
import { newWorktreeIdsAfterSnapshot } from './workspace-sections-model';
import {
  StandaloneChatsSidebarSection,
  standaloneChatsForWorkspace,
} from './StandaloneChatsSidebarSection';
import type {
  WorkEntryNotificationHandlers,
  StandaloneChatsSidebarChat,
  StandaloneChatsSidebarRowsState,
  StandaloneChatsSidebarSnapshot,
} from './StandaloneChatsSidebarSection';
import {
  PROJECTS_HEADER_SELECTOR,
  RAIL_SECTION_HEADER_PADDING_RIGHT,
  shouldShowProjectsPin,
  SIDEBAR_FOOTER_CALLOUT_HOST_SELECTOR,
  SIDEBAR_ROOT_SELECTOR,
  SIDEBAR_VIEWPORT_ATTR,
  SIDEBAR_VIEWPORT_SELECTOR,
  SidebarChrome,
  STICKY_WORKSPACE_SLOT_SELECTOR,
  SHARED_WITH_YOU_SECTION_LABEL,
} from './sidebar';
import { createPortal } from 'react-dom';
import { prefersReducedMotion } from '@canopy/ui-shared/lib';
import {
  deriveWorktreeMenuItems,
  foldWorktreeMenuIntoMore,
  foldWorktreeNotificationsIntoSubmenu,
  isSplitPrEligible,
  type SplitPrEligibilityInputs,
  worktreeArchiveBlockedReason,
} from './worktree-menu-items';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  isSidebarActivityAvailable,
  withSidebarActivitySpaceMute,
  type SidebarActivityHost,
} from './sidebar-activity-host';
import { SidebarActivityModeSwitch } from './SidebarActivityModeView';
import { SidebarContextHeader } from './sidebar/SidebarContextHeader';
import type {
  GetWorktreeBatchRemovalFacts,
  RemoveWorktreeInBatch,
  SidebarBatchRemovalUiState,
  WorktreeBatchRemovalUiState,
} from './sidebar/use-sidebar-batch-removal';
import {
  useSidebarWorkEntryBulk,
  type GetWorkEntryBatchRemovalFacts,
  type GetWorkEntryBulkState,
  type RemoveWorkEntryInBatch,
  type WorkEntryMultiSelectBinding,
} from './sidebar/use-sidebar-work-entry-bulk';
import { withSelectionGroupItems } from './sidebar-selection-menu-items';
import { SidebarActivityModeToggle } from './SidebarActivityModeToggle';
import {
  useSidebarWorktreeBulk,
  worktreeBulkRowMenu,
} from './sidebar/use-sidebar-worktree-bulk';
import {
  useSidebarBulk,
  useSidebarSelectionRows,
  type SidebarRowMultiSelect,
} from './sidebar/use-sidebar-bulk';

/**
 * How many chats the hoisted Chats section lists before "Show all".
 *
 * THE cap, not a copy of desktop's: `SidebarChatsSection` re-exports this
 * rather than declaring its own, so the shared section and the host that caps
 * its own rows cannot drift apart. An earlier revision had two constants and
 * a comment claiming they were shared, which they were not — this file's
 * symbol was never exported from the package barrel, so the host could not
 * have imported it.
 */
export const CHATS_SECTION_VISIBLE_ENTRIES = 5;
import type {
  UseWorktreeRowOverrides,
  WorkspaceBranchGrouping,
  WorkspaceContextMenuSlotContext,
  WorkspaceHeaderEmphasis,
  WorkspacesSidebarSectionsProps,
  WorktreeActionsSlot,
  WorktreeRowSlotContext,
} from './WorkspacesSidebarSections';
import type { SidebarWorkspace, SnapshotWorktree } from './worktree-status';
import { sidebarRowLabel, workspaceLayout } from './worktree-status';
import {
  derivePrBadgeStatus,
  hasAllKnownPrsMerged,
  workspaceColor,
  workspaceKind,
} from './sidebar-model';
import {
  isWorktreeDone,
  snapshotWorkspaceMatchesContext,
  worktreeRowKey,
  type WorkspaceSectionsSnapshot,
} from './workspace-sections-model';
import {
  filterSidebarChatSearchResults,
  type SidebarChatSearchResult,
} from './sidebar-chat-search-model';
import { activateSidebarNavItem } from './sidebar/sidebar-nav-activation';

export type SidebarSelection =
  | { readonly kind: 'workspace'; readonly workspaceLocalId: string }
  | {
      readonly kind: 'worktree';
      readonly workspaceLocalId: string;
      readonly worktreeLocalId: string;
    }
  | { readonly kind: 'standalone-chat'; readonly standaloneChatId: string }
  | null;

export interface SidebarPipelineEntry {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
}

/**
 * Minimal structural snapshot consumed by the consolidated sidebar. It
 * deliberately excludes unrelated session collections so browser-local
 * projections need not masquerade as the full protocol session model.
 */
export interface SidebarSurfaceSnapshot extends StandaloneChatsSidebarSnapshot {
  readonly workspaces: readonly SidebarWorkspace[];
  readonly worktrees: readonly SnapshotWorktree[];
  /** Per-chat attention rolled up onto worktree rows (waiting questions). */
  readonly chatSummaries?: WorkspaceSectionsSnapshot['chatSummaries'];
}

type WorktreeTestId =
  | string
  | ((workspaceLocalId: string, worktreeLocalId: string) => string);

export interface SidebarSurfaceTestIds {
  readonly root?: string;
  readonly scroll?: string;
  readonly loading?: string;
  readonly empty?: string;
  readonly workspaceList?: string;
  readonly workspaceSection?: string | ((workspaceLocalId: string) => string);
  /** The project header itself; pinned copies suffix their own ids. */
  readonly workspaceHeader?: (workspaceLocalId: string) => string;
  /**
   * The header's name button that toggles collapse; pinned copies suffix it.
   * Receives the workspace type so a host can keep per-kind legacy ids.
   */
  readonly workspaceToggle?: (
    workspaceLocalId: string,
    workspaceType: string,
  ) => string;
  /** The header's sortable wrapper, in flow and around each pinned copy. */
  readonly workspaceSortableHeader?: (workspaceLocalId: string) => string;
  /** The header's hover-revealed options button; pinned copies suffix it. */
  readonly workspaceOptionsButton?: string;
  /** The header's right-click / options menu; pinned copies suffix it. */
  readonly workspaceContextMenu?: string;
  /** The line an expanded project with no rows shows in their place. */
  readonly workspaceEmpty?: (workspaceLocalId: string) => string;
  /** The Projects section (header and list) inside the rail. */
  readonly workspacesSection?: string;
  /** The Projects section's collapse toggle. */
  readonly workspacesSectionToggle?: string;
  /** The Chats section and its header controls; hosts map their own ids. */
  readonly chatsSection?: string;
  readonly chatsSectionToggle?: string;
  readonly chatsSectionSettings?: string;
  readonly chatsSectionMenu?: string;
  readonly chatsSectionMenuContent?: string;
  readonly chatsSectionShowAll?: string;
  readonly chatsSectionCreateChat?: string;
  /** The `None found` row an empty Chats section lists. */
  readonly chatsSectionEmpty?: string;
  /** The Chats section's rows container. */
  readonly chatsSectionContent?: string;
  readonly worktreeRow?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => string;
  readonly hiddenWorkspacesToggle?: string;
  readonly hiddenWorktreesToggle?: (workspaceLocalId: string) => string;
  readonly hiddenWorktreesSection?: string;
  readonly addWorkspace?: string;
  readonly workspacesSectionMenu?: string;
  readonly workspacesSectionMenuContent?: string;
  readonly createWorkspaceDialog?: string;
  readonly worktreeActionsMenuButton?: WorktreeTestId;
  readonly worktreeActionsMenu?: WorktreeTestId;
  readonly worktreeActionSetLabel?: WorktreeTestId;
  readonly worktreeActionBranchInfo?: WorktreeTestId;
  readonly worktreeActionLaunch?: WorktreeTestId;
  readonly worktreeActionDispatchPipeline?: WorktreeTestId;
  readonly worktreeActionSplitPr?: WorktreeTestId;
  readonly worktreeActionAddRepository?: WorktreeTestId;
  readonly worktreeActionCreateBranch?: WorktreeTestId;
  readonly worktreeActionToggleHidden?: WorktreeTestId;
  readonly worktreeActionTogglePin?: WorktreeTestId;
  readonly worktreeActionMoveToOrganization?: WorktreeTestId;
  /** The branch-grouping item (group/ungroup with base or children). */
  readonly worktreeActionGrouping?: WorktreeTestId;
  readonly worktreeRemoval?: WorktreeTestId;
  /** The destructive (Delete) removal item, where a host tells it apart from Archive. */
  readonly worktreeDeletion?: WorktreeTestId;
  readonly worktreeDirectRemoval?: WorktreeTestId;
  /** The hover-revealed Show chip on a hidden row. */
  readonly worktreeDirectShow?: WorktreeTestId;
  /** Prefix for a row's notification choices and their status line. */
  readonly worktreeNotifications?: WorktreeTestId;
  readonly worktreeRemovalConfirm?: WorktreeTestId;
  readonly worktreeBatchRemovalDialog?: string;
  /** The Work Entry batch dialog; defaults to `work-entry-batch-removal-dialog`. */
  readonly workEntryBatchRemovalDialog?: string;
  readonly workspaceRemovalConfirm?: string;
  readonly coworkWorkspace?: (workspaceLocalId: string) => string;
  readonly standaloneChatList?: string;
  readonly standaloneChatFolderToggle?: string;
  readonly standaloneChatRow?: (chatLocalId: string) => string;
}

/**
 * Host wiring for the sidebar chat search (CAN-1990). The host builds the
 * flat candidate inventory (worktree chat summaries + standalone chats) via
 * `buildSidebarChatSearchCandidates` and handles result selection; the
 * surface owns the query state, filtering, and result presentation.
 */
export interface SidebarChatSearchHost {
  readonly candidates: readonly SidebarChatSearchResult[];
  /**
   * True while the batched chat-summary hydration is still in flight —
   * results may be incomplete, so the results view shows a syncing hint.
   */
  readonly hydrating?: boolean;
  readonly onSelectResult: (result: SidebarChatSearchResult) => void;
}

/** Host-provided action that enables one sidebar nav item. */
export interface SidebarNavItemAction {
  /**
   * Renders the item as a real link. The surface is router-agnostic (ui-app
   * must not import `next/link`), so this is a plain anchor; hosts that need
   * client-side routing supply `onSelect` instead of (or alongside) `href`.
   */
  readonly href?: string;
  /** Invoked when the item is activated (pointer or keyboard). */
  readonly onSelect?: () => void;
  /** Marks the item as the current destination. */
  readonly active?: boolean;
  /**
   * Invoked instead of `onSelect` when the current item is activated: it
   * returns the section to its root, the same as entering it fresh (see
   * `activateSidebarNavItem`). An `href` item routes to its href either way,
   * which for a URL host is already the section's root.
   */
  readonly onReturnToRoot?: () => void;
}

export interface SidebarSurfaceProps {
  /**
   * Layout SHAPE. A `'rail'` is a fixed-width column; a `'drawer'` fills its
   * parent. This is deliberately not a statement about the input device — see
   * `pointer`.
   */
  readonly variant: 'rail' | 'drawer';
  /**
   * Hit-target sizing. Defaults to whatever `variant` implies — a drawer is a
   * phone surface, a rail is not — so hosts that never think about it are
   * unchanged.
   *
   * It is a separate axis because one real host needs the two to disagree: the
   * desktop rail nests this surface inside its own scroll area, which is
   * drawer-shaped, on a mouse-and-keyboard machine. Folded into `variant`, it
   * had to choose between the wrong layout and 44px touch rows under a mouse
   * pointer, and chose the latter.
   */
  readonly pointer?: 'fine' | 'coarse';
  readonly snapshot: SidebarSurfaceSnapshot;
  /**
   * Identity token for the host's authoritative workspace projection. Hosts
   * that derive the rendered snapshot (for example, by overlaying local
   * collapse state) pass the source workspace collection so presentation-only
   * rerenders do not look like a newly applied workspace snapshot.
   */
  readonly workspaceSnapshotVersion?: object;
  readonly selection: SidebarSelection;
  /** Host-owned targets, including newly added projects, archives, and flat chats. */
  readonly projectListRetainedWorkspaceIds?: readonly (
    | string
    | null
    | undefined
  )[];
  /**
   * Baseline for chrome that addresses no particular row, and the fallback for
   * `capabilitiesFor`.
   */
  readonly capabilities: CanopyCapabilities;
  /**
   * Per-row capability resolution, addressed by any workspace or worktree local
   * id. Supplied by hosts whose client fronts more than one backend; omitted
   * (the desktop host), every row falls back to `capabilities`.
   */
  readonly capabilitiesFor?: (localId: string) => CanopyCapabilities;
  /**
   * Identity of whatever currently supplies the command handlers, for hosts
   * that can swap it under a mounted rail.
   *
   * The web rail hands down a different set of mutation handlers depending on
   * whether `/chat` owns the live session, and it does that WITHOUT
   * remounting, so the user keeps their search and menus across the handoff.
   * The command-bound dialogs cannot come along: their handler may be gone on
   * the other side, and confirming one then silently does nothing. Change this
   * value whenever the handler set changes and those dialogs reset.
   *
   * Omit it on a host with one permanent owner (the desktop app).
   */
  readonly dataOwnerId?: string;
  readonly contentState: 'waiting' | 'loading' | 'empty' | 'ready';
  /** Reserve Chats while loading, before the host has rows or callbacks. */
  readonly loadingChatsSection?: boolean;
  /**
   * Header chrome presentation. `'full'` (the default) renders the command
   * entry points — the New Task button and the More menu — alongside the
   * navigation rows. `'navigation-only'` suppresses exactly those two
   * controls for read-only hosts (e.g. the web Plugins section's sidebar),
   * where a permanently disabled New Task button and a menu of dead entries
   * are phantom chrome: omitting the mutation handlers already blocks the
   * commands, but not the controls' presence. Rows, the Workspaces header,
   * and the main-nav items (plain navigation, and only ever rendered for keys
   * the host actually serves) are unaffected.
   */
  readonly chrome?: 'full' | 'navigation-only';
  readonly onSelect: (selection: SidebarSelection) => void;
  readonly onCreateTask?: () => void;
  readonly createTaskTooltip?: string;
  /**
   * Marks the New task row as the current destination, the way desktop selects
   * its New task row while the Home page is showing (web chat parity, slice 6).
   */
  readonly createTaskActive?: boolean;
  readonly onCreateWorkspace?: (
    payload: PortalWorkspaceCreatePayload,
  ) => Promise<WorkspaceCreateResult>;
  readonly onOpenCreateWorkspaceOverride?: () => boolean;
  readonly onCreateWorktree?: (
    workspaceLocalId: string,
    sidebarItemGroupId?: string,
  ) => Promise<WorktreeCreateResult> | void;
  readonly itemGroupCommandsFor?: WorkspacesSidebarSectionsProps['itemGroupCommandsFor'];
  readonly onCreateStandaloneGroupItem?: (
    workspaceLocalId: string,
    groupId: string,
  ) => void;
  readonly onGroupError?: (workspaceLocalId: string, error: unknown) => void;
  /**
   * Archives a standalone chat's whole Work Entry, locked and restorable on
   * desktop (CAN-5461). Offered only for rows whose owning project's
   * capabilities include `standaloneChatArchive` and whose commands are
   * enabled; never in a read-only list or for a cloud project. Settle once
   * the removal is confirmed or failed; the host reports failures.
   */
  readonly onArchiveStandaloneChat?: (
    chat: StandaloneChatsSidebarChat & { readonly projectLocalId: string },
  ) => void | Promise<void>;
  readonly onCreateBranchWorktree?: (
    workspaceLocalId: string,
    baseWorktreeLocalId: string,
  ) => void;
  /** Read-only diagnostics, offered for cloud rows when the host supplies it. */
  readonly onShowWorktreeDebugInfo?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  readonly onArchiveWorktree?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    mode?: 'archive' | 'delete',
  ) => void;
  /**
   * Bulk removal (CAN-3975): removes one worktree of a confirmed batch and
   * settles when that removal has finished, rejecting with the reason when
   * it failed. Omitted: rows offer no multi-select, the Select item is
   * absent, and no selection bar renders.
   */
  readonly onRemoveWorktreeInBatch?: RemoveWorktreeInBatch;
  /**
   * Host facts for a batch confirm row: local work to warn about and a
   * host-only reason the worktree can't be removed right now (desktop: the
   * delete action is disabled or an archive is in flight). Omitted or
   * `undefined`: the shared signals alone decide.
   */
  readonly getWorktreeBatchRemovalFacts?: GetWorktreeBatchRemovalFacts;
  /**
   * The batch confirm offers the keep-local-branch switch, applied to every
   * included worktree. Only hosts whose removal takes a branch choice set it.
   */
  readonly worktreeBatchBranchChoice?: boolean;
  /** The batch dialog opened, changed phase, or closed (`null`). */
  readonly onWorktreeBatchRemovalStateChange?: (
    state: WorktreeBatchRemovalUiState | null,
  ) => void;
  /**
   * Bulk removal of Work Entries (chats): removes one entry of a confirmed
   * batch and settles when that removal has finished, rejecting with the
   * reason when it failed. Omitted: Work Entry rows offer no multi-select.
   */
  readonly onRemoveWorkEntryInBatch?: RemoveWorkEntryInBatch;
  /**
   * Host facts for one Work Entry of a batch: `undefined` when the entry no
   * longer exists, a reason when it can't be removed right now. Hosts that
   * wire {@link onRemoveWorkEntryInBatch} wire this too.
   */
  readonly getWorkEntryBatchRemovalFacts?: GetWorkEntryBatchRemovalFacts;
  /**
   * A Work Entry's pin and done state for the selection's Pin and Mark
   * items. Hosts that wire {@link onSetWorkEntryPinned} or
   * {@link onSetWorkEntryStatus} wire this too.
   */
  readonly getWorkEntryBulkState?: GetWorkEntryBulkState;
  /** The Work Entry row's own Pin to top, for a selection; settles when saved. */
  readonly onSetWorkEntryPinned?: (
    workspaceLocalId: string,
    workEntryId: string,
    pinned: boolean,
  ) => Promise<void>;
  /** The Work Entry row's own Mark done / Mark active, for a selection. */
  readonly onSetWorkEntryStatus?: (
    workspaceLocalId: string,
    workEntryId: string,
    status: 'active' | 'done',
  ) => Promise<void>;
  /** A workspace's deletion-retention window for the Work Entry batch copy. */
  readonly workEntryRetentionDaysFor?: (
    workspaceLocalId: string,
  ) => number | undefined;
  /** The Work Entry batch dialog opened, changed phase, or closed (`null`). */
  readonly onWorkEntryBatchRemovalStateChange?: (
    state: SidebarBatchRemovalUiState | null,
  ) => void;
  /**
   * The saved notification choice for a row's space, read synchronously from
   * host state on render. `undefined` means the host cannot identify the
   * space, and the row offers no notification choices.
   */
  readonly getWorktreeNotificationSettings?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => SpaceNotificationMenuState | undefined;
  /** A row's menu opened: the host refreshes that space's saved choice. */
  readonly onWorktreeNotificationSettingsRequested?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  /** Saves a space's notification choice; `null` clears the override. */
  readonly onSetWorktreeNotificationLevel?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    choice: SpaceNotificationMenuChoice,
  ) => void;
  readonly onDeleteWorkspace?: (
    workspaceLocalId: string,
    mode?: 'archive' | 'delete',
  ) => Promise<void>;
  /**
   * Renders the first-class "Advisor" sidebar item (CAN-2562), mirroring the
   * desktop sidebar. The host gates availability (capability + kill-switch)
   * and owns the overlay; omitted, the row is absent.
   */
  readonly onOpenAppAdvisor?: () => void;
  /** Marks the Advisor navigation row as the current destination. */
  readonly appAdvisorActive?: boolean;
  /**
   * Enables individual sidebar nav items, keyed by the canonical nav keys the
   * desktop sidebar uses (`@canopy/protocol/sidebar`), so both hosts render one
   * vocabulary instead of two hand-maintained lists.
   *
   * A host supplies an action only for the sections that actually exist there
   * (web wires Plugins and Pipelines to its portal routes and Remote Control to
   * its pairing flow; desktop navigates to its own pages). Keys without an
   * action are dropped from both regions —
   * main-nav rows and More entries alike — rather than rendered as dead rows or
   * disabled entries, and the More trigger itself is omitted once its list
   * comes out empty.
   */
  readonly navItemActions?: Partial<
    Record<SidebarNavItemKey, SidebarNavItemAction>
  >;
  /**
   * Client-side routing for the rail's anchors (nav rows, More entries, and
   * the current destination). An unmodified primary click is handed to the
   * host instead of loading a new document; modified and middle clicks keep
   * the browser's link behavior. Omitted (desktop), anchors navigate natively.
   */
  readonly onNavigateHref?: (href: string) => void;
  /**
   * One host-supplied row marking the destination the host is currently
   * showing, for destinations that have no permanent nav row. Rendered in the
   * nav block below the served nav items, always as the current page.
   *
   * Exists so a host whose right-hand pane is showing something the rail
   * cannot otherwise name (web's `/account`, `/organization`, `/admin`, a plan
   * or a run) still has exactly one row *in the rail* carrying
   * `aria-current="page"`, and that row describes what is on screen. The
   * guarantee is scoped to this nav block: a page is free to mark its own
   * current tab the same way in its own nav set (web's account and admin tabs
   * both do), which is conformant because they are distinct nav sets. Hosts
   * whose every destination has a real nav row (desktop, `/chat`) omit the
   * prop and are unchanged.
   */
  readonly currentDestination?: {
    readonly label: string;
    readonly icon?: ReactNode;
    /** Section root; omitted renders a non-interactive row. */
    readonly href?: string;
    readonly testId?: string;
  };
  /**
   * Ordering and the main-nav/More split. Defaults to the same layout a fresh
   * desktop install starts from; the desktop host passes the user's persisted
   * customization.
   */
  readonly navLayout?: SidebarNavLayout;
  /**
   * Host-owned routing for the settings dialog. `initialTab` lets an entry
   * point land directly on one tab — the sidebar's `Share template` opens
   * settings on `'share'` rather than on Details.
   */
  readonly onOpenWorkspaceSettingsOverride?: (
    workspaceLocalId: string,
    initialTab?: string,
  ) => boolean;
  readonly onConfirmWorktreeRemovalOverride?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    label: string,
    mode: 'archive' | 'delete' | undefined,
  ) => boolean;
  /**
   * Host-owned Branch Info: return `true` to take the request (desktop opens
   * its git-aware dialog), `false` to let the shared info dialog open.
   */
  readonly onBranchInfoRequestedOverride?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /**
   * Host-owned Set label: return `true` to take the request (desktop opens
   * Branch Info with the label field active), `false` for the shared sheet.
   */
  readonly onSetLabelRequestedOverride?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  readonly onUpdateWorktree?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    patch: {
      label?: string | null;
      hidden?: boolean;
      /** Pin the row to the top of its section (desktop sidebar parity). */
      pinned?: boolean;
    },
  ) => void;
  readonly branchGroupingEnabled?: boolean;
  readonly getBranchGrouping?: (
    workspace: SidebarSurfaceSnapshot['workspaces'][number],
  ) => WorkspaceBranchGrouping | undefined;
  readonly onSetBranchGroupingOverride?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    override: 'group' | 'ungroup',
  ) => void | Promise<void>;
  readonly onReorderWorkspaces?: (activeId: string, overId: string) => void;
  readonly onReorderWorktrees?: (
    workspaceLocalId: string,
    activeId: string,
    overId: string,
  ) => void;
  readonly onLaunchWorktree?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  /**
   * Stops every script running in a worktree: its menu's Stop running
   * scripts, and the bulk selection's, row by row.
   */
  readonly onStopRunningScripts?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  readonly getSplitPrEligibilityInputs?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => SplitPrEligibilityInputs;
  readonly getSplitPrBlockers?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => readonly string[];
  /** Host-owned preflight/modal entry point; shared code owns no workflow UI. */
  readonly onSplitPrRequested?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  /** Host-owned availability; omitted/false keeps repository attachment hidden. */
  readonly isAddRepositoryAvailable?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /**
   * The row holds a saved Add repository attempt to resume or cancel: the
   * item stays enabled through the active-work rule, which the attempt
   * itself may be what keeps busy.
   */
  readonly isAddRepositoryResumable?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /** Runtime session state used by the desktop-compatible disabled rule. */
  readonly hasActiveWorktreeSession?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /**
   * Host verdict that a row which is not done may still show the hover
   * removal chip (desktop: a clean or freshly created worktree). The shared
   * rail has no local-git state to decide this itself.
   */
  readonly isDirectRemovalAvailable?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /**
   * Host-owned rows for a workspace header's right-click menu (also opened
   * by the header's options button). See `WorkspacesSidebarSectionsProps`.
   */
  readonly renderWorkspaceContextMenuItems?: (
    context: WorkspaceContextMenuSlotContext,
  ) => ReactNode;
  /**
   * Whether the host serves a context menu for this workspace. Headers it
   * declines get neither the hover "…" nor a right-click menu. Omitted: every
   * workspace is served when `renderWorkspaceContextMenuItems` is supplied.
   */
  readonly isWorkspaceContextMenuAvailable?: (
    workspaceLocalId: string,
  ) => boolean;
  /** Host-driven emphasis on a header's controls (onboarding tour). */
  readonly getWorkspaceHeaderEmphasis?: (
    workspaceLocalId: string,
  ) => WorkspaceHeaderEmphasis | undefined;
  /**
   * Host-owned: the project is pinned to the top of the Projects list (the
   * header's pin mark). The portable snapshot carries no workspace pin, so a
   * host without project pinning omits this and headers show no mark.
   */
  readonly isWorkspacePinned?: (workspaceLocalId: string) => boolean;
  /**
   * Host-owned rows for a worktree's actions menu, placed after Branch info
   * (desktop's Share). Omitted hosts get the shared items only.
   */
  readonly getWorktreeExtraMenuItems?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => readonly WorktreeMenuItem[];
  /** Host-owned setup/teardown phase for a row (desktop tracks it live). */
  readonly getWorktreeSetupPhase?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => WorktreeSetupPhase | undefined;
  /**
   * Host-owned: the row's removal is in flight (desktop: teardown and archive
   * capture). The row is muted and inert and offers no removal meanwhile.
   */
  readonly isWorktreeRemovalInProgress?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /** Host-owned: the worktree is shared with teammates (badge on the row). */
  readonly isWorktreeShared?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /** Host veto on listing a snapshot row (desktop: an archive in flight). */
  readonly isWorktreeListed?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => boolean;
  /**
   * Host-owned Move to organization dialog for a Personal project. Offered
   * only with the `workspaceMoveToOrganization` capability and when
   * `isWorkspaceMoveToOrganizationAvailable` returns `true` for the project.
   */
  readonly onMoveWorkspaceToOrganizationRequested?: (
    workspaceLocalId: string,
  ) => void;
  /** Host verdict that this project can move; absent means it cannot. */
  readonly isWorkspaceMoveToOrganizationAvailable?: (
    workspaceLocalId: string,
  ) => boolean;
  /** Host-owned modal entry point; shared code owns no repository picker UI. */
  readonly onAddRepositoryRequested?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  readonly onDispatchPipeline?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    pipelineLocalId: string,
  ) => void;
  /**
   * Host-owned Dispatch Pipeline dialog. Desktop's lists the pipelines, the
   * working directory and the inputs itself, so a host that supplies this
   * offers Dispatch Pipeline on every row and opens its own dialog instead of
   * the shared picker; `getPipelineEntries`/`onDispatchPipeline` then do not
   * gate the item.
   */
  readonly onDispatchPipelineRequested?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => void;
  readonly getPipelineEntries?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
  ) => readonly SidebarPipelineEntry[];
  /**
   * Launch availability and progress for a row. The workspace id is passed
   * for hosts whose worktree ids are only unique within a workspace.
   */
  readonly isLaunchAvailable?: (
    worktreeLocalId: string,
    workspaceLocalId: string,
  ) => boolean;
  readonly isLaunchRunning?: (
    worktreeLocalId: string,
    workspaceLocalId: string,
  ) => boolean;
  /** Any of the row's scripts is running (the row's Scripts running badge). */
  readonly hasRunningScripts?: (
    worktreeLocalId: string,
    workspaceLocalId: string,
  ) => boolean;
  /**
   * The runs behind a row's pipeline badge. `workspaceLocalId` disambiguates
   * hosts whose worktree ids are only unique within a workspace (desktop).
   */
  readonly getPipelinePopoverEntries?: (
    worktreeLocalId: string,
    workspaceLocalId: string,
  ) => PipelineStatusPopoverEntry[];
  /**
   * Keeps an open pipeline popover live. A run's job list or status can
   * change (or a new run start) while the row's own aggregate `pipelineStatus`
   * badge does not, so a host whose rows come from its own stores subscribes
   * here and the popover re-reads `getPipelinePopoverEntries` on each
   * notification, the same shape as `subscribeTerminalPopoverRows` below.
   * Without it, entries are read once when the popover opens.
   */
  readonly subscribePipelinePopoverEntries?: (
    worktreeLocalId: string,
    workspaceLocalId: string,
    onChange: () => void,
  ) => () => void;
  /**
   * Live per-row state the host layers over the snapshot. A hook run inside
   * each row; see `UseWorktreeRowOverrides`.
   */
  readonly useWorktreeRowOverrides?: UseWorktreeRowOverrides;
  readonly getTerminalPopoverRows?: (
    worktreeLocalId: string,
  ) => TerminalPopoverRow[];
  /**
   * Keeps an open terminal popover live. A row's terminals can change while
   * its `terminalStatus` does not (a second command starts, a terminal is
   * renamed), so a host whose rows come from its own stores subscribes here
   * and the popover re-reads `getTerminalPopoverRows` on each notification.
   * With this set, `getTerminalPopoverRows` must return the same array until
   * the rows change.
   */
  readonly subscribeTerminalPopoverRows?: (
    worktreeLocalId: string,
    onChange: () => void,
  ) => () => void;
  readonly onLoadClaudeMd?: (
    workspaceLocalId: string,
  ) => Promise<string | null>;
  readonly onSaveClaudeMd?: (
    workspaceLocalId: string,
    content: string,
  ) => Promise<void>;
  readonly onUpdateWorkspace?: (
    workspaceLocalId: string,
    patch: { name?: string; color?: string },
  ) => Promise<void>;
  /** The settings dialog's removal copy for a row whose host words it. */
  readonly workspaceDangerCopy?: (
    workspaceLocalId: string,
  ) => WorkspaceSettingsDangerCopy | undefined;
  readonly onLoadScripts?: (
    workspaceLocalId: string,
  ) => Promise<Record<string, string> | null>;
  readonly onSaveScripts?: (
    workspaceLocalId: string,
    commands: Record<string, string>,
  ) => Promise<void>;
  /** Host content for the organization workspace’s Repositories tab. */
  readonly renderWorkspaceRepositoriesAccessory?: (
    workspaceLocalId: string,
    onClose: () => void,
    onOpenDestination: (workspaceLocalId: string) => Promise<void>,
  ) => ReactNode;
  /** Host content for a workspace's settings Scripts tab. */
  readonly renderWorkspaceScriptsAccessory?: (
    workspaceLocalId: string,
  ) => ReactNode;
  /**
   * Initial collapse of the whole "Workspaces" section (only meaningful with
   * `workspacesSectionCollapsible`). The surface owns the live state; a host
   * that wants the choice to survive a reload seeds it here and persists the
   * value reported by {@link onWorkspacesSectionCollapsedChange}.
   */
  readonly workspacesSectionInitiallyCollapsed?: boolean;
  readonly onWorkspacesSectionCollapsedChange?: (collapsed: boolean) => void;
  /**
   * Desktop's project headers. Tree workspace names toggle collapse on every
   * host; this also makes flat (chat) workspace names toggle instead of
   * selecting the workspace — desktop's legacy cowork row toggled on its name
   * and opened chats from its entries — and gives tree headers desktop's
   * icon-slot disclosure and name drag activator.
   */
  readonly workspaceNameTogglesCollapse?: boolean;
  /**
   * A host rail's sticky band, rendered around the Projects header in the
   * flow after the Chats section. Desktop's rail seats its workspace headers,
   * selected-row pins, and header slot relative to that band.
   */
  readonly renderProjectsBand?: (header: ReactNode) => ReactNode;
  readonly onWorkspaceCollapsedChange?: (
    workspaceLocalId: string,
    collapsed: boolean,
  ) => void;
  /**
   * Per-workspace command gate. `true` ⇒ that workspace's host cannot accept
   * commands right now, so its mutation affordances (create/label/hide/launch/
   * dispatch/archive/delete/reorder) are withheld while read-only ones stay.
   *
   * Exists because a host can front MORE THAN ONE backend (the web Chat tab
   * fronts always-on cloud workspaces beside a possibly-disconnected desktop),
   * which a single global `commandsDisabled` cannot express. Omitted — the
   * desktop host — nothing is gated and every render path is unchanged.
   */
  readonly isWorkspaceCommandDisabled?: (workspaceLocalId: string) => boolean;
  /** Host-identified recipient placeholders rendered outside Projects. */
  readonly sharedWorkspaceIds?: ReadonlySet<string>;
  /**
   * Notices about shares that ended, at the top of Shared with you. Present
   * (not nullish) keeps the section even with nothing else in it, and before
   * the rows are ready: they do not depend on any workspace.
   */
  readonly sharedWithMeNotices?: ReactNode;
  /** Host-withheld rows that remain mounted elsewhere, such as an active revoked chat. */
  readonly hiddenWorktreeIds?: ReadonlySet<string>;
  /** Optional host policy for adding or suppressing row-menu entries. */
  readonly transformWorktreeMenuItems?: (
    context: WorktreeRowSlotContext,
    items: readonly WorktreeMenuItem[],
  ) => readonly WorktreeMenuItem[];
  /** Optional host-owned status rendered beside a row's action menu. */
  readonly renderWorktreeStatus?: (
    context: WorktreeRowSlotContext,
  ) => ReactNode;
  /**
   * Optional host-owned replacement for a row's worktree id (desktop: the
   * stop control while the launch script runs). Returning nothing keeps the
   * plain id.
   */
  readonly renderWorktreeIdSlot?: (
    context: WorktreeRowSlotContext,
  ) => ReactNode;
  /** Forwarded verbatim to {@link WorkspacesSidebarSections}. */
  readonly deriveWorktreeRowLabel?: WorkspacesSidebarSectionsProps['deriveWorktreeRowLabel'];
  /**
   * Rendered beneath the workspace list, in every content state INCLUDING
   * `empty` — the affordance a host hangs here is typically the one that
   * populates an empty sidebar, so the "Nothing here yet." placeholder must not
   * replace it (REG-2814).
   */
  readonly listFooter?: ReactNode;
  /**
   * Host-owned sections that follow the Projects section (and its Hidden
   * disclosure) in the rail's flow: desktop's "Shared with me". Rendered in
   * every content state and while Projects is collapsed, because a section of
   * its own does not depend on the project list; ahead of {@link listFooter}.
   * The section owns its header, collapse, and rows.
   */
  readonly trailingSections?: ReactNode;
  /**
   * Pinned to the bottom of the sidebar: rendered OUTSIDE the scroll region,
   * directly above {@link footer}, so it stays on screen no matter how long the
   * workspace list grows.
   *
   * Distinct from {@link listFooter}, which scrolls away with the list, and
   * from {@link footer}, which is a single-row status strip. This slot is for a
   * persistent card-shaped notice — the web Chat tab's connect/reconnect CTA —
   * whose whole job is to explain the state of the list above it. Something
   * that has to be read to make sense of the tree cannot be allowed to scroll
   * out of view.
   *
   * Carries no divider, and suppresses {@link footer}'s: the content here is
   * expected to be a self-bounded card, which separates itself. Stacking rules
   * around it is the exact clutter the pinned card was meant to reduce.
   */
  readonly footerCallout?: ReactNode;
  readonly visibleWorkspaceIds?: ReadonlySet<string>;
  /** Selected Personal/organization context; see WorkspacesSidebarSectionsProps. */
  readonly context?: WorkspacesSidebarSectionsProps['context'];
  /**
   * The empty organization Projects list (see WorkspacesSidebarSectionsProps).
   * `chatsListed` is true when the organization's Chats section shows above
   * it (CAN-3537). The host still renders its empty Projects row; the flag
   * only lets it hold back copy that would call the organization empty.
   */
  readonly renderContextEmptyState?: (state: {
    readonly chatsListed: boolean;
  }) => ReactNode;
  /** Host-owned extra rows; see WorkspacesSidebarSectionsProps. */
  readonly additionalRows?: WorkspacesSidebarSectionsProps['additionalRows'];
  /**
   * Projects the host is still adding. Forwarded to the owned Projects list
   * directly, never through `additionalRows`, so the read-only and
   * collapsible-section rules for host rows cannot drop them.
   */
  readonly pendingProjects?: WorkspacesSidebarSectionsProps['pendingProjects'];
  readonly additionalProjects?: WorkspacesSidebarSectionsProps['additionalProjects'];
  readonly linkedPersonalWorkspaceIds?: WorkspacesSidebarSectionsProps['linkedPersonalWorkspaceIds'];
  readonly onWorktreeIntent?: WorkspacesSidebarSectionsProps['onWorktreeIntent'];
  readonly onWorktreeRowElement?: (
    workspaceLocalId: string,
    worktreeLocalId: string,
    element: HTMLDivElement | null,
  ) => void;
  readonly pendingRevealTarget?: {
    readonly workspaceLocalId: string;
    readonly worktreeLocalId: string;
  } | null;
  readonly renderCoworkWorkspace?: WorkspacesSidebarSectionsProps['renderCoworkWorkspace'];
  /**
   * Rows for the hoisted Chats section, when the host's differ from the
   * portal's flat chats. The shared header, its controls, the sticky marks and
   * the scroll mask stay shared either way.
   *
   * Desktop supplies this because its Chats bucket holds multi-chat Work
   * Entries; the portal wire carries flat chats. That is a protocol
   * divergence with an open product decision behind it, not a UI gap, so the
   * seam is deliberately the ROWS only — see `StandaloneChatsSidebarSection`'s
   * `renderRows`.
   *
   * Supplying it also takes over the section's emptiness rule: the host knows
   * whether it has rows, and desktop deliberately keeps the header visible
   * while empty because it carries the only entry point to a first chat.
   *
   * Collapsed, the rows are asked for their collapsed form (the selected
   * chat only), and only while {@link chatsSectionHasSelectedRow} is set.
   */
  readonly renderChatsSectionRows?: (
    state: StandaloneChatsSidebarRowsState,
  ) => ReactNode;
  /**
   * Whether {@link renderChatsSectionRows}' rows hold the selected chat, so
   * a collapsed Chats section keeps that one row.
   */
  readonly chatsSectionHasSelectedRow?: boolean;
  /**
   * Whether {@link renderChatsSectionRows}' rows are empty, so the Chats "+"
   * stays on screen as the only way in rather than waiting for a hover.
   */
  readonly chatsSectionEmpty?: boolean;
  /**
   * Entries for the Chats header's overflow menu. The control and its menu
   * shell stay shared; only the actions differ, because desktop offers
   * template sharing, session import and a sort mode the portal has no
   * equivalent for.
   */
  readonly renderChatsSectionMenuItems?: () => ReactNode;
  /** First-use placeholder: disable settings/overflow, but keep "+" active. */
  readonly chatsSectionPending?: boolean;

  /**
   * Entries for the Projects header's overflow menu, on the same seam the
   * Chats header uses: the control and its menu shell stay shared, the actions
   * are the host's. They have to be, because every one of them reads state
   * this package cannot see — the sort mode, the hidden-project ids, and the
   * cloud-connect gate behind session import.
   *
   * Receives `closeMenu`, because the menu mixes two kinds of entry: the
   * visibility rows are multi-select and must leave it open, while a command
   * like picking a sort mode should dismiss it the way the Chats header's
   * menu does. `closeOnSelect` is a single switch for the whole menu and
   * cannot express both, so the entries that want it close it themselves.
   */
  readonly renderWorkspacesSectionMenuItems?: (
    closeMenu: () => void,
  ) => ReactNode;

  /**
   * Whether a project filter is currently hiding rows.
   *
   * Hidden projects are the one piece of sidebar state the list itself cannot
   * show, so the control that reverses it must not wait for a hover — a user
   * who hides a project and forgets would otherwise have nothing to aim at.
   * The legacy rail pins the control open and marks it for the same reason.
   */
  readonly workspacesSectionFiltered?: boolean;
  /**
   * Host-owned Chats collapse: desktop keeps it as a preference rather than
   * the catch-all workspace's own collapsed flag. Omitted hosts use the flag.
   */
  /** Shows the Chats rows' last-activity age (`5m`, `3h`, `2d`). */
  readonly showChatActivityAge?: boolean;
  /** Where the Chats rows show their status (`WorkEntryRow`). */
  readonly chatsRowStatusPlacement?: 'trailing' | 'leading';
  /** The Chats and project list disclosures read `More` / `Less`, no count. */
  readonly compactListDisclosures?: boolean;
  /** Project headers drop their row counters. */
  readonly hideWorkspaceCounts?: boolean;
  /** `hairline`: 1px between every worktree row, stacks and groups included. */
  readonly worktreeRowGap?: 'hairline';
  /**
   * Worktree rows offer Pin and Archive on hover; the full menu opens by
   * right-click (and stays on ••• for touch, which has no right-click).
   */
  readonly compactWorktreeHoverActions?: boolean;
  /** A short hover on a worktree row opens its preview card. */
  readonly worktreeHoverPreview?: boolean;
  /** Worktree menu rows read in sentence case ("Dispatch pipeline"). */
  readonly sentenceCaseMenuLabels?: boolean;
  readonly chatsSectionCollapsed?: boolean;
  readonly onChatsSectionCollapsedChange?: (collapsed: boolean) => void;
  /**
   * Keep the Projects "+" visible at rest (onboarding spotlight, filter on).
   * The surface also keeps it there while the Projects body lists no project.
   */
  readonly addWorkspaceRevealed?: boolean;
  /** Data attributes for the Projects "+" (an onboarding anchor, for one). */
  readonly addWorkspaceButtonDataAttrs?: Record<`data-${string}`, string>;
  /**
   * Creates a chat in the Chats bucket. Desktop's creates a Work Entry; the
   * portal has no equivalent action to bind, so it supplies nothing and the
   * "+" does not render rather than rendering dead.
   */
  readonly onCreateChatsSectionChat?: () => void;
  /**
   * One line an EMPTY Chats section lists under its header, for a host whose
   * rail would otherwise show a header over nothing (a web guest with no
   * chats yet, CAN-2989). Unset keeps the existing rule: Personal lists no
   * row, an organization lists `None found`. Set, it lists a host row in any
   * context and replaces `None found` when the section renders its own rows.
   * Hosts that pass `renderChatsSectionRows` own their empty state instead.
   * Whether the header renders at all still follows `onCreateChatsSectionChat`,
   * `renderChatsSectionRows`, and the list. Unrelated to `chatsSectionEmpty`
   * (the host-rendered-rows emptiness flag).
   */
  readonly chatsSectionEmptyLabel?: string;
  /**
   * Who owns the scrolling viewport the sections live in.
   *
   * `'surface'` (the default) makes the surface its own scroll container, as
   * the portal needs. `'host'` is for a surface nested inside a rail that
   * already has one — desktop's `AppSidebar`, which owns the custom
   * scrollbar, the sticky-rail sync and the selected-item pin.
   *
   * This is not cosmetic. Nesting a second `overflow-y-auto` makes it the
   * nearest scrolling ancestor, so the section headers inside stick to a box
   * that never scrolls instead of to the rail's real viewport — and its
   * padding lands on top of the host's, indenting every row.
   */
  readonly scrollOwner?: 'surface' | 'host';
  readonly worktreeRetentionDaysFor?: (
    workspaceLocalId: string,
  ) => number | undefined;
  readonly renderArchivedSection?: WorkspacesSidebarSectionsProps['renderArchivedSection'];
  readonly archivedCount?: WorkspacesSidebarSectionsProps['archivedCount'];
  readonly archivedEntries?: WorkspacesSidebarSectionsProps['archivedEntries'];
  readonly onLoadArchived?: WorkspacesSidebarSectionsProps['onLoadArchived'];
  readonly archivedExpanded?: WorkspacesSidebarSectionsProps['archivedExpanded'];
  readonly onArchivedExpandedChange?: WorkspacesSidebarSectionsProps['onArchivedExpandedChange'];
  readonly onViewArchived?: WorkspacesSidebarSectionsProps['onViewArchived'];
  readonly onRestoreArchived?: WorkspacesSidebarSectionsProps['onRestoreArchived'];
  readonly onDeleteArchived?: WorkspacesSidebarSectionsProps['onDeleteArchived'];
  readonly renderArchivedActions?: WorkspacesSidebarSectionsProps['renderArchivedActions'];
  readonly footer?: ReactNode;
  /**
   * Rendered in place of an empty Personal Projects list that sits under the
   * Chats catch-all, where the list otherwise renders nothing. Not used for an
   * organization, a non-empty list, or the `'empty'` content state. Omitted ⇒
   * nothing renders (desktop).
   */
  readonly emptyProjectsSlot?: ReactNode;
  /** Omitted → no search affordance renders (host opts in). */
  readonly chatSearch?: SidebarChatSearchHost;
  /**
   * Activity mode wiring (CAN-390). With `capabilities.sidebarActivityMode`,
   * Activity replaces the workspace tree while it is on. Supplying a host does
   * not place a bell; see {@link activityToggleInHeader}.
   */
  readonly activity?: SidebarActivityHost;
  /**
   * Render the Activity bell in the surface header, or beside the context
   * switcher with activityToggleInContextRow. Desktop places its own bell
   * outside this surface and leaves this off.
   */
  readonly activityToggleInHeader?: boolean;
  /** Seat the header bell beside the context switcher, with a header fallback. */
  readonly activityToggleInContextRow?: boolean;
  /**
   * Rendered above the New Task / Advisor block, inside the sidebar's own
   * chrome. Chromeless hosts (web `/chat` and `/portal/plugins/*`) put the
   * brand row here, since the site header that used to carry it no longer
   * renders on those routes. Omitted ⇒ nothing renders (desktop).
   */
  readonly headerSlot?: ReactNode;
  /**
   * The Personal/organization switcher, directly below {@link headerSlot} and
   * above New task (CAN-4057). Hosts pass it only when the switcher is
   * available, decided before mounting: an element that later renders `null`
   * would still leave its wrapper. Omitted ⇒ nothing renders.
   */
  readonly contextRowSlot?: ReactNode;
  /**
   * How {@link chatSearch} is disclosed.
   *
   * - `'row'` (default) — a permanent search row between the nav block and the
   *   sections (above the Chats and Projects headers, where desktop keeps its
   *   Search row).
   * - `'header-icon'` — a magnifier at the right of {@link headerSlot} that
   *   toggles the SAME input in place. A disclosure change only, so the input,
   *   its testids, the query state, and the results overlay are identical
   *   either way.
   * - `'nav-row'` — a `Search` row directly under New task, where the desktop
   *   sidebar keeps its Search row, toggling that same input. The chromeless
   *   web chat shell picks this (web chat parity, slice 6).
   *
   * Disclosed search moves beside Activity when a context row is present.
   * Never more than one: two search affordances is worse than either one.
   */
  readonly chatSearchPresentation?: 'row' | 'header-icon' | 'nav-row';
  /**
   * Whether the Workspaces heading owns a section-wide disclosure.
   *
   * Defaults off so existing desktop and navigation-only hosts keep the
   * static heading they had before the web chat restyle. Chromeless `/chat`
   * opts in alongside its other sidebar-owned chrome.
   */
  readonly workspacesSectionCollapsible?: boolean;
  /** Forwarded verbatim to {@link WorkspacesSidebarSections}. */
  readonly rowPresentation?: WorkspacesSidebarSectionsProps['rowPresentation'];
  readonly worktreeDiffStatsStyle?: 'short' | 'complete';
  readonly testIds?: SidebarSurfaceTestIds;
}

/**
 * Apply grouping overrides in desktop-compatible sequence. Mutations stop at
 * the first failure and the rejected promise is returned to the caller.
 */
export async function applyBranchGroupingOverrides(
  ids: readonly string[],
  override: 'group' | 'ungroup',
  apply: (id: string, override: 'group' | 'ungroup') => void | Promise<void>,
): Promise<void> {
  const ordered = override === 'ungroup' ? [...ids].reverse() : ids;
  for (const id of ordered) {
    await apply(id, override);
  }
}

/**
 * Desktop's sidebar row icon size. The shared rail used to render 20px glyphs;
 * web chat parity (slice 6) pins it to the desktop reference.
 */
const NAV_ICON_SIZE = 16;

/** Built once: the defs are immutable label/icon pairs. */
const NAV_ITEM_DEFS = getSidebarNavItemDefs(NAV_ICON_SIZE);

/**
 * Look a def up by an untrusted key. Layout keys arrive as `string[]` from a
 * persisted, user-ordered list, so this narrows instead of indexing the
 * exhaustive record directly.
 */
/**
 * The removal confirmation of a worktree whose client asks for the
 * saved-changes wording (`worktreeRemovalCopy`): its removal saves the
 * worktree's changes first and asks the user when it cannot. Delete archives
 * first; no mode is the archive of a host without retention.
 */
function savedChangesRemovalMessage(
  mode: 'archive' | 'delete' | undefined,
  retentionDays: number,
): string {
  const fallback = "If they can't be saved, you choose what happens.";
  if (mode === 'delete') {
    const kept = `${retentionDays} ${retentionDays === 1 ? 'day' : 'days'}`;
    return `It's archived first, with its changes saved. ${fallback} Deleted worktrees are kept for ${kept}, then removed. You can restore it from Archived and deleted.`;
  }
  const saved = `Its changes are saved before it stops. ${fallback}`;
  return mode === 'archive'
    ? `${saved} Archived worktrees are kept until you delete them.`
    : saved;
}

function navItemDef(key: string): SidebarNavItemDef | undefined {
  return Object.entries(NAV_ITEM_DEFS).find(([defKey]) => defKey === key)?.[1];
}

/** The row a worktree or session removal confirmation was opened for. */
interface WorktreeRemovalConfirmTarget {
  readonly label: string;
  readonly subject: 'worktree' | 'session';
  readonly mode?: 'archive' | 'delete';
  readonly backend?: PortalRowBackend;
  readonly presentation: 'archive' | 'delete';
  readonly copy?: 'saved-changes';
}

/**
 * Title, sentence and action for a row removal confirmation. The title is a
 * question naming the row, the action repeats its verb and noun, and the
 * sentence says what happens to the work. Cloud rows are chats to the user,
 * so they read as chats.
 */
function worktreeRemovalConfirmCopy(
  target: WorktreeRemovalConfirmTarget,
  retentionDays: number,
  remoteRetentionWindow: string,
): { title: ReactNode; message: string; confirmLabel: string } {
  const removal = target.mode ?? target.presentation;
  const verb = removal === 'archive' ? 'Archive' : 'Delete';
  const chatLike = target.backend === 'cloud';
  const noun = chatLike ? 'chat' : target.subject;
  const label = target.label.trim();
  // A row's name is user-authored, so it is masked in session replay.
  const title =
    label === '' ? (
      `${verb} ${noun}?`
    ) : (
      <>
        {chatLike ? verb : `${verb} ${noun}`} “
        <span className={REPLAY_MASK_CLASS}>{label}</span>”?
      </>
    );
  const kept = `${retentionDays} ${retentionDays === 1 ? 'day' : 'days'}`;
  let message: string;
  if (target.copy === 'saved-changes') {
    message = savedChangesRemovalMessage(target.mode, retentionDays);
  } else if (target.mode === 'archive') {
    message =
      target.backend === 'cloud'
        ? 'Archived chats are kept until you delete them.'
        : 'This removes the active checkout. Archived worktrees are kept until you delete them. Restore it from the desktop app.';
  } else if (target.mode === 'delete') {
    message =
      target.backend === 'cloud'
        ? `Deleted chats are kept for ${kept}, then removed. You can restore it from Archived and deleted.`
        : `This removes the active checkout. Deleted worktrees are kept for ${remoteRetentionWindow}, then removed. Restore it from the desktop app.`;
  } else if (removal === 'archive') {
    message =
      target.subject === 'session'
        ? 'This removes the session from the sidebar while keeping its chat history.'
        : 'This removes the worktree from disk while keeping its chats and eligible workflow history.';
  } else {
    message = 'This removes the worktree and its checkout and can’t be undone.';
  }
  return { title, message, confirmLabel: `${verb} ${noun}` };
}

/**
 * Split the canonical nav keys into the rows rendered inline and the entries
 * rendered inside the More menu. Both regions follow one policy: keys the host
 * cannot serve are dropped. A permanently dead row — or a More list of things
 * you cannot open — is phantom chrome, not a signpost.
 *
 * `slots` caps the inline destinations plus the More trigger. When every
 * served main-nav key and a needed More fit, nothing moves. Otherwise one slot
 * goes to More and the main-nav keys past the rest fold into the front of More,
 * in resolved order, so every served key stays reachable exactly once. The fold
 * runs after layout resolution and the served filter, on fresh arrays —
 * neither the layout nor the actions are mutated, and no different layout is
 * persisted.
 */
function sidebarNavRegions(
  layout: SidebarNavLayout | undefined,
  actions: SidebarSurfaceProps['navItemActions'],
  slots?: number,
): { mainNav: string[]; more: string[] } {
  const regions = splitSidebarNavLayout(layout ?? DEFAULT_SIDEBAR_NAV_LAYOUT);
  const mainNav = regions.mainNav.filter((key) => isServed(actions, key));
  const more = regions.more.filter((key) => isServed(actions, key));
  if (
    slots === undefined ||
    mainNav.length + (more.length > 0 ? 1 : 0) <= slots
  ) {
    return { mainNav, more };
  }
  const keepMainNav = Math.max(slots - 1, 0);
  const kept = new Set(mainNav.slice(0, keepMainNav));
  const isActive = (key: string): boolean =>
    navActionFor(actions, key)?.active === true;
  // The current destination must stay visible. When no kept row is active,
  // the first active key in resolved order takes the last kept slot; an
  // already-kept active key wins over a folded one, so a malformed state with
  // several active flags stays deterministic without growing the row budget.
  if (!mainNav.some((key) => kept.has(key) && isActive(key))) {
    const promoted = mainNav.find(isActive);
    const displaced = mainNav[keepMainNav - 1];
    if (promoted !== undefined && displaced !== undefined) {
      kept.delete(displaced);
      kept.add(promoted);
    }
  }
  return {
    mainNav: mainNav.filter((key) => kept.has(key)),
    more: [...mainNav.filter((key) => !kept.has(key)), ...more],
  };
}

/**
 * How many 44px icon buttons the narrow-width strip holds: Search, the
 * destinations, a host current destination, and More. Five fit the narrowest
 * drawer, 85% of a 320px phone less the nav block's 8px sides (256px), with
 * the strip's 4px gaps. What does not fit folds into More, so the whole nav
 * block above Projects stays two rows tall: New task and the strip.
 */
const NARROW_NAV_STRIP_SLOTS = 5;

/**
 * The one served-ness policy, expressed over an action so every caller shares
 * it: a key is served only when its action can actually go somewhere. Both nav
 * regions filter on it and `MoreMenu` re-applies it, so the policy cannot drift
 * into two subtly different shapes.
 */
function isServedAction(action: SidebarNavItemAction): boolean {
  return action.href !== undefined || !!action.onSelect;
}

function isServed(
  actions: SidebarSurfaceProps['navItemActions'],
  key: string,
): boolean {
  const action = navActionFor(actions, key);
  return action !== undefined && isServedAction(action);
}

/**
 * Hands an unmodified primary anchor click to the host router. Anything the
 * browser gives a meaning of its own (new tab, new window, download, a
 * non-self target) stays a native link.
 */
function routeAnchorClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigateHref: ((href: string) => void) | undefined,
): void {
  if (
    onNavigateHref === undefined ||
    event.defaultPrevented ||
    !opensAnchorInPlace(event)
  ) {
    return;
  }
  event.preventDefault();
  onNavigateHref(href);
}

/**
 * An unmodified primary click on a same-tab anchor. Anything else opens the
 * link elsewhere (new tab, new window, download), leaving this tab as it is.
 */
function opensAnchorInPlace(
  event: ReactMouseEvent<HTMLAnchorElement>,
): boolean {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return false;
  }
  const target = event.currentTarget.getAttribute('target');
  return target === null || target === '' || target === '_self';
}

function navActionFor(
  actions: SidebarSurfaceProps['navItemActions'],
  key: string,
): SidebarNavItemAction | undefined {
  if (!actions) return undefined;
  return Object.entries(actions).find(([entryKey]) => entryKey === key)?.[1];
}

export function scriptsForSave(
  initialScripts: Record<string, string>,
  scripts: Record<string, string>,
): Record<string, string> | undefined {
  const keys = new Set([
    ...Object.keys(initialScripts),
    ...Object.keys(scripts),
  ]);
  const normalized: Record<string, string> = {};
  let changed = false;
  keys.forEach((key) => {
    const nextValue = scripts[key] ?? '';
    normalized[key] = nextValue;
    if (nextValue !== (initialScripts[key] ?? '')) changed = true;
  });
  return changed ? normalized : undefined;
}

/**
 * One inline sidebar nav row. Anchors keep browser link affordances
 * (middle-click, new tab) for hosts that navigate by URL; hosts that route
 * client-side supply `onSelect`. `app-advisor` keeps its historical testid —
 * the Advisor row predates this shared model and E2E specs select it by name.
 */
interface SidebarNavItemRowProps {
  readonly navKey: string;
  readonly action: SidebarNavItemAction | undefined;
  readonly touch: boolean;
  /** Icon only, for the narrow-width strip; the label names it instead. */
  readonly compact?: boolean;
  readonly onNavigateHref?: (href: string) => void;
}

/**
 * The ONE active-state vocabulary for rows in the nav block. Shared by
 * `SidebarNavItemRow` and the host-supplied `currentDestination` anchor so the
 * anchor is visually indistinguishable from an active Plugins/Pipelines row —
 * two literals here would let the rail grow two ways of saying "current".
 */
function sidebarNavRowClassName(active: boolean, touch: boolean): string {
  return sidebarNavItemClassName(active, touch);
}

/**
 * A nav item's class list and content: a labelled row, or in the narrow
 * strip, a 44px icon button whose label becomes its accessible name and
 * tooltip. The current item's glyph takes the primary ink beside the selected
 * background, so the state reads from more than one cue.
 */
function sidebarNavItemPresentation(
  icon: ReactNode,
  label: string,
  active: boolean,
  touch: boolean,
  compact: boolean,
): { className: string; content: ReactNode; ariaLabel: string | undefined } {
  if (!compact) {
    return {
      className: sidebarNavRowClassName(active, touch),
      content: (
        <>
          <span className={SIDEBAR_NAV_ICON_CLASSNAME}>{icon}</span>
          {label}
        </>
      ),
      ariaLabel: undefined,
    };
  }
  return {
    className: sidebarNavIconItemClassName(active),
    content: (
      <span
        className={`${SIDEBAR_LIST_ICON_CLASSNAME} ${active ? 'fg-primary' : 'fg-secondary'}`}
      >
        {icon}
      </span>
    ),
    ariaLabel: label,
  };
}

/** Icon-only strip items name themselves in a tooltip; rows show the label. */
function NavItemTooltip({
  label,
  compact,
  children,
}: {
  readonly label: string;
  readonly compact: boolean;
  readonly children: JSX.Element;
}): JSX.Element {
  return compact ? <Tooltip label={label}>{children}</Tooltip> : children;
}

/**
 * The host's current destination, rendered with the active nav row's exact
 * presentation. Always current: the host only supplies it for the destination
 * it is showing right now.
 */
function SidebarCurrentDestinationRow({
  destination,
  touch,
  compact = false,
  onNavigateHref,
}: {
  readonly destination: NonNullable<SidebarSurfaceProps['currentDestination']>;
  readonly touch: boolean;
  readonly compact?: boolean;
  readonly onNavigateHref?: (href: string) => void;
}): JSX.Element {
  // Without a glyph there is nothing to draw in an icon slot, so the strip
  // keeps the label as text rather than inventing an icon.
  const iconOnly = compact && destination.icon !== undefined;
  const presentation = sidebarNavItemPresentation(
    destination.icon,
    destination.label,
    true,
    touch,
    iconOnly,
  );
  const className =
    compact && !iconOnly
      ? `${sidebarNavIconItemClassName(true)} w-auto min-w-0 px-2 text-s`
      : presentation.className;
  const content =
    compact && !iconOnly ? (
      <span className="truncate">{destination.label}</span>
    ) : (
      presentation.content
    );
  const href = destination.href;
  if (href !== undefined) {
    return (
      <NavItemTooltip label={destination.label} compact={iconOnly}>
        <a
          href={href}
          onClick={(event): void =>
            routeAnchorClick(event, href, onNavigateHref)
          }
          data-testid={destination.testId}
          aria-current="page"
          aria-label={presentation.ariaLabel}
          data-selected
          className={className}
        >
          {content}
        </a>
      </NavItemTooltip>
    );
  }
  return (
    <NavItemTooltip label={destination.label} compact={iconOnly}>
      <div
        data-testid={destination.testId}
        aria-current="page"
        aria-label={presentation.ariaLabel}
        data-selected
        className={className}
      >
        {content}
      </div>
    </NavItemTooltip>
  );
}

function SidebarNavItemRow({
  navKey,
  action,
  touch,
  compact = false,
  onNavigateHref,
}: SidebarNavItemRowProps): JSX.Element | null {
  const def = navItemDef(navKey);
  if (!def || !action) return null;
  const testId =
    navKey === 'app-advisor'
      ? 'portal-sidebar-advisor'
      : `portal-sidebar-nav-${navKey}`;
  const { className, content, ariaLabel } = sidebarNavItemPresentation(
    def.icon,
    def.label,
    action.active === true,
    touch,
    compact,
  );
  const href = action.href;
  if (href !== undefined) {
    return (
      <NavItemTooltip label={def.label} compact={compact}>
        <a
          href={href}
          onClick={(event): void => {
            // Opening the current row in a new tab leaves this tab's section
            // where it is.
            activateSidebarNavItem(
              opensAnchorInPlace(event)
                ? action
                : { ...action, onReturnToRoot: undefined },
            );
            routeAnchorClick(event, href, onNavigateHref);
          }}
          data-testid={testId}
          aria-current={action.active ? 'page' : undefined}
          aria-label={ariaLabel}
          data-selected={action.active || undefined}
          className={className}
        >
          {content}
        </a>
      </NavItemTooltip>
    );
  }
  return (
    <NavItemTooltip label={def.label} compact={compact}>
      <button
        type="button"
        onClick={(): void => activateSidebarNavItem(action)}
        data-testid={testId}
        aria-current={action.active ? 'page' : undefined}
        aria-label={ariaLabel}
        data-selected={action.active || undefined}
        className={className}
      >
        {content}
      </button>
    </NavItemTooltip>
  );
}

/**
 * A More destination that is a real anchor, so it keeps browser link
 * affordances (middle-click, new tab). `FloatingMenu` drives every
 * `[role="menuitem"]` element — roving arrow-key focus, Enter/Space
 * activation, and close-on-select — so the anchor only needs the role and the
 * canonical `DropdownMenuItem` presentation in the menu's row style (its
 * enabled default tone; anchors have no `:enabled` pseudo-class).
 */
function MoreMenuAnchorRow({
  testId,
  href,
  icon,
  label,
  className,
  onClick,
}: {
  readonly testId: string;
  readonly href: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly className: string;
  readonly onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}): JSX.Element {
  const rowStyle = useDropdownMenuRowStyle();
  const textClassName = rowStyle.textStyle === 'small' ? 'text-xs' : 'text-s';
  return (
    <a
      role="menuitem"
      data-testid={testId}
      href={href}
      onClick={onClick}
      className={`canopy-dropdown-menu-item outline-none flex h-8 w-full items-center gap-2 rounded-md px-2 text-left ${textClassName} font-normal fg-primary transition-colors hover:bg-subtle focus-visible:bg-subtle ${className}`}
    >
      <DropdownMenuItemIcon
        tone={rowStyle.iconTone === 'tertiary' ? 'tertiary' : undefined}
      >
        {icon}
      </DropdownMenuItemIcon>
      {label}
    </a>
  );
}

function MoreMenu({
  touch,
  compact = false,
  itemKeys,
  itemActions,
  onNavigateHref,
}: {
  readonly touch: boolean;
  /** Icon only, as the last item of the narrow-width strip. */
  readonly compact?: boolean;
  readonly itemKeys: readonly string[];
  readonly itemActions?: SidebarSurfaceProps['navItemActions'];
  readonly onNavigateHref?: (href: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // The 44px floor for touch on the anchor variant; the button variant takes
  // it through `DropdownMenuItem`'s `touchTarget`. `h-8` stays: it does not
  // override a CSS minimum height, so the row grows with its content centered.
  const touchItemClassName = touch ? 'min-h-11' : '';
  return (
    <SidebarMoreControl
      open={open}
      onOpenChange={setOpen}
      triggerRef={triggerRef}
      triggerTestId="portal-more"
      menuTestId="portal-more-menu"
      compact={compact}
      touchTarget={touch ? 'always' : 'none'}
    >
      {itemKeys.map((key) => {
        const item = navItemDef(key);
        if (!item) return null;
        // `sidebarNavRegions` already dropped the keys this host cannot
        // serve, so today every key reaching here is served. Re-applying the
        // same predicate — rather than a weaker bare `!action` check — is
        // what keeps that true if `itemKeys` ever gains a second caller: an
        // action carrying only presentational fields (`{ active: true }`) is
        // truthy, so `!action` alone would let it through as an enabled row
        // whose click does nothing.
        const action = navActionFor(itemActions, key);
        if (!action || !isServedAction(action)) return null;
        const href = action.href;
        if (href !== undefined) {
          return (
            <MoreMenuAnchorRow
              key={key}
              testId={`portal-more-item-${key}`}
              href={href}
              icon={item.icon}
              label={item.label}
              className={touchItemClassName}
              onClick={(event): void => {
                action.onSelect?.();
                routeAnchorClick(event, href, onNavigateHref);
                // FloatingMenu's close-on-select skips defaultPrevented
                // clicks, and a host router that intercepts the anchor
                // prevents its default — close here so the menu never
                // lingers over a client-side navigation, and return focus
                // to the trigger ourselves (the unmounting anchor would
                // otherwise drop focus to <body>). Ordinary clicks keep the
                // single focus from FloatingMenu's own close-and-focus.
                setOpen(false);
                if (event.defaultPrevented) {
                  triggerRef.current?.focus({ preventScroll: true });
                }
              }}
            />
          );
        }
        return (
          <DropdownMenuItem
            key={key}
            role="menuitem"
            data-testid={`portal-more-item-${key}`}
            onClick={(): void => action.onSelect?.()}
            touchTarget={touch}
          >
            <DropdownMenuItemIcon>{item.icon}</DropdownMenuItemIcon>
            {item.label}
          </DropdownMenuItem>
        );
      })}
    </SidebarMoreControl>
  );
}

/**
 * Mounted wherever the Projects body renders no project row, so the surface
 * learns the list is empty from the code that decides it, rather than from a
 * second copy of the list's own partitioning.
 */
function ProjectsEmptyStateMark({
  onChange,
}: {
  readonly onChange: (shown: boolean) => void;
}): null {
  useEffect(() => {
    onChange(true);
    return (): void => onChange(false);
  }, [onChange]);
  return null;
}

/** Splices a host's rows in after Branch info, or at the end without one. */
function withHostMenuItems(
  items: readonly WorktreeMenuItem[],
  extra: readonly WorktreeMenuItem[] | undefined,
): readonly WorktreeMenuItem[] {
  if (!extra || extra.length === 0) return items;
  const anchor = items.findIndex((item) => item.key === 'branch-info');
  if (anchor === -1) return [...items, ...extra];
  return [...items.slice(0, anchor + 1), ...extra, ...items.slice(anchor + 1)];
}

/**
 * Extends a list's binding with Work Entry selectability. Built outside the
 * render on purpose: the cached binding outlives the render that created it,
 * and a closure made inside the render would keep that render's whole scope
 * (and the host data its props hold) alive for as long as the cache does.
 */
function withWorkEntrySelectability(
  base: SidebarRowMultiSelect,
  isSelectableRef: { readonly current: (workspaceLocalId: string) => boolean },
): WorkEntryMultiSelectBinding {
  return {
    ...base,
    isSelectable: (workspace) => isSelectableRef.current(workspace),
  };
}

export function SidebarSurface(props: SidebarSurfaceProps): JSX.Element {
  return (
    <SidebarAutoDeleteProvider
      retentionDaysFor={props.worktreeRetentionDaysFor}
    >
      <SidebarSurfaceContent {...props} />
    </SidebarAutoDeleteProvider>
  );
}

function SidebarSurfaceContent(props: SidebarSurfaceProps): JSX.Element {
  const autoDelete = useSidebarAutoDeleteMenu();
  const {
    variant,
    snapshot,
    selection,
    capabilities,
    contentState,
    onSelect,
    testIds,
  } = props;
  const scopedSnapshot = useMemo((): SidebarSurfaceSnapshot => {
    if (props.context === undefined) return snapshot;
    const workspaces = snapshot.workspaces.filter((workspace): boolean =>
      snapshotWorkspaceMatchesContext(
        workspace,
        props.context,
        props.linkedPersonalWorkspaceIds,
      ),
    );
    const workspaceIds = new Set(
      workspaces.map((workspace): string => workspace.localId),
    );
    return {
      ...snapshot,
      workspaces,
      standaloneChats: snapshot.standaloneChats.filter((chat): boolean =>
        chat.projectLocalId === undefined
          ? props.context?.kind === 'personal'
          : workspaceIds.has(chat.projectLocalId),
      ),
    };
  }, [snapshot, props.context, props.linkedPersonalWorkspaceIds]);
  // Shape and pointer are separate questions; `variant` only answers the first.
  const fillsParent = variant === 'drawer';
  const touch =
    (props.pointer ?? (fillsParent ? 'coarse' : 'fine')) === 'coarse';
  const commandChrome = (props.chrome ?? 'full') === 'full';
  const narrow = useIsMobile();
  // This surface scrolls itself only when no host rail owns the viewport; the
  // desktop rail carries its own stand-in and must not get a second.
  const ownsScroll = props.scrollOwner !== 'host';
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  // Keep the lifecycle gate mounted after a host disappears, while preserving
  // the provider-free tree contract for callers that never attach Activity.
  const [activityAttached, setActivityAttached] = useState(
    props.activity !== undefined,
  );
  if (props.activity !== undefined && !activityAttached)
    setActivityAttached(true);
  const activityToggleAvailable =
    props.activityToggleInHeader === true &&
    isSidebarActivityAvailable(capabilities, props.activity);
  const activityToggleInContextRow =
    activityToggleAvailable &&
    props.activityToggleInContextRow === true &&
    props.contextRowSlot != null;
  const activityToggleInHeader =
    activityToggleAvailable && !activityToggleInContextRow;
  // Entering or leaving Activity starts the list from the top; the tree's
  // own position is deliberately not preserved across the swap.
  const resetActivityScroll = (): void => {
    const scroller = scrollViewportRef.current?.closest<HTMLElement>(
      SIDEBAR_VIEWPORT_SELECTOR,
    );
    if (scroller) scroller.scrollTop = 0;
  };
  const projectsPinRef = useRef<HTMLButtonElement | null>(null);
  // The rail's slot container. Its per-workspace rows are the portal targets
  // for pinned header copies, and the rail creates the container but not the
  // rows — whoever renders the workspace list owns those, because only it
  // knows which workspaces there are.
  const [slotContainer, setSlotContainer] = useState<HTMLElement | null>(null);
  const [chatsStuck, setChatsStuck] = useState(false);
  const [pendingCloudChat, setPendingCloudChat] = useState<{
    workspaceLocalId: string;
    baseline: ReadonlySet<string>;
    worktreeId?: string;
  } | null>(null);
  // The Projects body lists no project: its header "+" is then the only way
  // to add one, so it stays on screen instead of waiting for a hover.
  const [projectsListEmpty, setProjectsListEmpty] = useState(false);
  // A rail that owns scrolling seats the footer callout in its footer stack;
  // in flow here it would scroll away with the rows below the fold.
  const [footerCalloutHost, setFooterCalloutHost] =
    useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (props.scrollOwner !== 'host') {
      setSlotContainer(null);
      setFooterCalloutHost(null);
      return;
    }
    // Reached from the viewport rather than a root ref: `SidebarChrome`
    // forwards none, and this element is inside the rail either way.
    const rail = scrollViewportRef.current?.closest<HTMLElement>(
      SIDEBAR_ROOT_SELECTOR,
    );
    setSlotContainer(
      rail?.querySelector<HTMLElement>(STICKY_WORKSPACE_SLOT_SELECTOR) ?? null,
    );
    setFooterCalloutHost(
      rail?.querySelector<HTMLElement>(SIDEBAR_FOOTER_CALLOUT_HOST_SELECTOR) ??
        null,
    );
  }, [props.scrollOwner]);
  useEffect((): (() => void) | undefined => {
    if (!ownsScroll) return;
    const viewport = scrollViewportRef.current;
    const pin = projectsPinRef.current;
    if (!viewport || !pin) return;
    // Reads only, and only two rects: the decision is a pure predicate shared
    // with the desktop rail, so the two platforms cannot drift on when the
    // stand-in appears.
    const sync = (): void => {
      const header = viewport.querySelector<HTMLElement>(
        PROJECTS_HEADER_SELECTOR,
      );
      const headerRect = header?.getBoundingClientRect();
      const nextHidden =
        headerRect === undefined ||
        !shouldShowProjectsPin({
          controlsTop: headerRect.top,
          controlsHeight: headerRect.height,
          hostBottom: viewport.getBoundingClientRect().bottom,
          // At rest the measurement and the decision share a frame.
          scrollDelta: 0,
        });
      if (pin.hidden !== nextHidden) pin.hidden = nextHidden;
    };
    sync();
    viewport.addEventListener('scroll', sync, { passive: true });
    // Expanding the chat list pushes Projects below the fold WITHOUT moving
    // the scroll position, so a scroll listener alone never re-measures.
    // Optional because jsdom has no `ResizeObserver`; without it the stand-in
    // simply waits for the next scroll rather than crashing the whole surface.
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    observer?.observe(viewport);
    const content = viewport.firstElementChild;
    if (content) observer?.observe(content);
    return (): void => {
      viewport.removeEventListener('scroll', sync);
      observer?.disconnect();
    };
    // `ownsScroll` only. With no dependency array this re-ran on every commit
    // — a forced synchronous layout plus an observer teardown and rebuild per
    // keystroke in the search box, on the PORTAL's default path, in the
    // component whose `getBoundingClientRect` cost CLAUDE.md already calls
    // out. The refs are stable for the component's lifetime, and content
    // growth reaches `sync` through the observer rather than a re-subscribe.
  }, [ownsScroll]);

  // `onOpenAppAdvisor`/`appAdvisorActive` predate the shared nav model and stay
  // the Advisor row's contract, so hosts did not have to be rewritten; folding
  // them in here keeps Advisor ordered by the canonical layout like every other
  // key rather than pinned to a hand-placed slot.
  const navItemActions: SidebarSurfaceProps['navItemActions'] =
    props.onOpenAppAdvisor
      ? {
          ...props.navItemActions,
          'app-advisor': props.navItemActions?.['app-advisor'] ?? {
            onSelect: props.onOpenAppAdvisor,
            active: props.appAdvisorActive,
          },
        }
      : props.navItemActions;
  const chatSearchInNav =
    props.chatSearch !== undefined &&
    props.chatSearchPresentation === 'nav-row' &&
    !props.contextRowSlot;
  const chatSearchInContextRow =
    props.chatSearch !== undefined &&
    Boolean(props.contextRowSlot) &&
    (props.chatSearchPresentation === 'nav-row' ||
      props.chatSearchPresentation === 'header-icon');
  // Below 1024px, New task stays a row and everything else in the nav block
  // becomes one strip of icon buttons; what does not fit folds into More. The
  // gate is WIDTH alone, not "coarse pointer or narrow": a touch laptop keeps
  // the full rail. It also requires `commandChrome` because More is command
  // chrome — a `navigation-only` surface has no trigger, so folding there
  // would make the folded keys unreachable.
  const navStrip = narrow && commandChrome;
  const navRegions = sidebarNavRegions(
    props.navLayout,
    navItemActions,
    navStrip
      ? NARROW_NAV_STRIP_SLOTS -
          (chatSearchInNav ? 1 : 0) -
          (props.currentDestination ? 1 : 0)
      : undefined,
  );
  const navBlockRef = useRef<HTMLDivElement | null>(null);
  const focusedNavRef = useRef<HTMLElement | null>(null);
  useLayoutEffect((): void => {
    const previous = focusedNavRef.current;
    const block = navBlockRef.current;
    if (!previous || previous.isConnected || !block) return;
    focusedNavRef.current = null;
    const doc = block.ownerDocument;
    if (doc.activeElement !== doc.body) return;
    // A resize (or availability update) can remove the focused menu item or
    // row. Follow its destination into the new partition instead of leaving
    // keyboard focus on body; portal focus events bubble through this block.
    const id = previous.dataset.testid ?? '';
    const inBlock = (testId: string): HTMLElement | undefined =>
      Array.from(block.querySelectorAll<HTMLElement>('[data-testid]')).find(
        (node) => node.dataset.testid === testId,
      );
    // Crossing the breakpoint remounts controls that stay visible (a row
    // becomes a strip icon), so the same control, found by its own id, wins.
    const sameControl = id === '' ? undefined : inBlock(id);
    const key =
      id === 'portal-sidebar-advisor'
        ? 'app-advisor'
        : id.replace(/^portal-(?:more-item-|sidebar-nav-)/, '');
    const destination = inBlock(
      key === 'app-advisor'
        ? 'portal-sidebar-advisor'
        : `portal-sidebar-nav-${key}`,
    );
    const menuItem = Array.from(
      doc.querySelectorAll<HTMLElement>('[data-testid^="portal-more-item-"]'),
    ).find((node) => node.dataset.testid === `portal-more-item-${key}`);
    const fallback = block.querySelector<HTMLElement>(
      'button:not(:disabled), a[href]',
    );
    (
      sameControl ??
      destination ??
      menuItem ??
      block.querySelector<HTMLElement>('[data-testid="portal-more"]') ??
      fallback
    )?.focus();
  }, [navRegions.mainNav, navRegions.more]);
  const removalPresentation =
    capabilities.worktreeRemoval === 'archive' ? 'archive' : 'delete';
  const capabilitiesOf = (localId: string): CanopyCapabilities =>
    props.capabilitiesFor?.(localId) ?? capabilities;
  const workspaceRemovalOf = (
    localId: string,
  ): false | 'archive' | 'delete' => {
    const removal = capabilitiesOf(localId).workspaceRemoval;
    return removal === undefined ? false : removal;
  };
  const [createOpen, setCreateOpen] = useState(false);
  const [workspacesMenuOpen, setWorkspacesMenuOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const chatSearchInHeader =
    props.chatSearch !== undefined &&
    props.chatSearchPresentation === 'header-icon' &&
    !chatSearchInContextRow;
  // The two disclosed presentations share one reveal state; `'row'` is always
  // open.
  const chatSearchDisclosed =
    chatSearchInHeader || chatSearchInNav || chatSearchInContextRow;
  const [chatSearchRevealed, setChatSearchRevealed] = useState(false);
  const chatSearchInputRef = useRef<HTMLInputElement | null>(null);
  // The disclosure's trigger (header magnifier or Search row). Collapsing
  // from the keyboard unmounts the focused input, so focus is handed back
  // here rather than dropped on `<body>`.
  const chatSearchToggleRef = useRef<HTMLButtonElement | null>(null);
  const chatSearchInputId = useId();
  const chatSearchVisible = !chatSearchDisclosed || chatSearchRevealed;
  // Collapsing must not strand a query the user can no longer see or clear.
  const collapseChatSearch = (): void => {
    setChatSearchRevealed(false);
    setChatSearchQuery('');
  };
  const toggleChatSearch = (): void => {
    if (chatSearchRevealed) {
      collapseChatSearch();
      return;
    }
    setChatSearchRevealed(true);
  };
  const [workspacesSectionCollapsed, setWorkspacesSectionCollapsed] = useState(
    props.workspacesSectionInitiallyCollapsed === true,
  );
  const workspacesHeaderRest = useSidebarHeaderRest(
    workspacesSectionCollapsed,
    workspacesMenuOpen,
  );
  // The host can hand down a DIFFERENT initial value after mount: the web
  // rail's baseline data leg does not know the persisted collapse and the live
  // leg does, so the value arrives at the tier handoff rather than at mount.
  // That used to be carried by a `key` remount in the host, which reset every
  // other piece of state in this component too — an open chat search, an open
  // menu, a pending confirmation dialog. Reconciling here is what let that key
  // go.
  //
  // Adjusted during render against the previous prop rather than in an effect:
  // an effect would paint the stale side first, and the section is large
  // enough that the correction reads as a flash. Still the INITIAL value, not
  // a controlled one — re-rendering for any other reason must not yank the
  // section back from wherever the user just put it.
  const [lastInitialCollapsed, setLastInitialCollapsed] = useState(
    props.workspacesSectionInitiallyCollapsed,
  );
  if (props.workspacesSectionInitiallyCollapsed !== lastInitialCollapsed) {
    setLastInitialCollapsed(props.workspacesSectionInitiallyCollapsed);
    setWorkspacesSectionCollapsed(
      props.workspacesSectionInitiallyCollapsed === true,
    );
  }
  const chatSearchActive =
    props.chatSearch !== undefined && chatSearchQuery.trim().length > 0;
  const chatSearchResults = chatSearchActive
    ? filterSidebarChatSearchResults(
        props.chatSearch?.candidates ?? [],
        chatSearchQuery,
      )
    : [];
  const [pendingDelete, setPendingDelete] = useState<{
    workspaceId: string;
    worktreeId: string;
    label: string;
    subject: 'worktree' | 'session';
    mode?: 'archive' | 'delete';
    backend?: PortalRowBackend;
    presentation: 'archive' | 'delete';
    /** The row's client asks for its own removal wording. */
    copy?: CanopyCapabilities['worktreeRemovalCopy'];
  } | null>(null);
  const pendingRetentionDays = pendingDelete
    ? props.worktreeRetentionDaysFor?.(pendingDelete.workspaceId)
    : undefined;
  const remoteRetentionWindow =
    pendingRetentionDays === undefined
      ? "the project's retention window"
      : `${pendingRetentionDays} ${pendingRetentionDays === 1 ? 'day' : 'days'}`;
  const [pendingWorkspaceRemoval, setPendingWorkspaceRemoval] = useState<{
    workspaceId: string;
    name: string;
    presentation: 'archive' | 'delete';
    busy: boolean;
    error: string | null;
  } | null>(null);
  const [worktreeDialog, setWorktreeDialog] = useState<{
    workspaceId: string;
    id: string;
    mode: 'label' | 'info' | 'pipeline';
    focus: { readonly current: HTMLButtonElement | null };
  } | null>(null);
  const [settingsDialog, setSettingsDialog] = useState<{
    workspace: SidebarSurfaceSnapshot['workspaces'][number];
    initialTab?: string;
    content: string;
    scripts: Record<string, string>;
    /** The row's `workspaceSettings` is `'details'`: name, colour, removal. */
    detailsOnly?: true;
  } | null>(null);
  const [pendingWorkspaceMetadata, setPendingWorkspaceMetadata] = useState<
    Readonly<
      Record<
        string,
        {
          name?: {
            value: string;
            before: string;
            afterSnapshotVersion: object;
          };
          color?: {
            value: string;
            before: string | undefined;
            afterSnapshotVersion: object;
          };
        }
      >
    >
  >({});
  // Interaction state divides in two, and the data owner is the line.
  //
  // A search disclosure, an open menu, and the section collapse belong to the
  // USER and survive an owner change — that is the whole point of dropping the
  // host's `key`. These dialogs belong to a COMMAND, and the handler that
  // command needs can disappear with the owner: the web rail only mounts the
  // mutation session on `/chat`, so navigating away leaves `onArchiveWorktree`
  // undefined. The confirm path calls it optionally and then closes
  // regardless, so a stale removal dialog would report a destructive action as
  // done having done nothing. Reset them when the owner changes.
  //
  // Adjusted during render for the same reason as the collapse above: an
  // effect would let the stale dialog paint once, and that frame is clickable.
  const [lastDataOwnerId, setLastDataOwnerId] = useState(props.dataOwnerId);
  const [ownerGeneration, setOwnerGeneration] = useState(0);
  if (props.dataOwnerId !== lastDataOwnerId) {
    setLastDataOwnerId(props.dataOwnerId);
    setOwnerGeneration((generation) => generation + 1);
    setPendingDelete(null);
    setPendingWorkspaceRemoval(null);
    setWorktreeDialog(null);
    setSettingsDialog(null);
    setPendingWorkspaceMetadata({});
    setPendingCloudChat(null);
  }
  const workspaceSnapshotVersion =
    props.workspaceSnapshotVersion ?? snapshot.workspaces;
  const currentWorkspaceSnapshot = useRef({
    version: workspaceSnapshotVersion,
    workspaces: snapshot.workspaces,
  });
  useEffect(() => {
    currentWorkspaceSnapshot.current = {
      version: workspaceSnapshotVersion,
      workspaces: snapshot.workspaces,
    };
  }, [snapshot.workspaces, workspaceSnapshotVersion]);
  const settingsRequest = useRef(0);
  // How many times the owner has changed, readable from an async continuation.
  //
  // Clearing the dialogs when the owner changes is not enough on its own: a
  // command already in flight resolves later and writes state back. Removing a
  // project and then leaving `/chat` and returning used to be covered by the
  // host's `key` — the continuation landed on an unmounted instance and did
  // nothing — and dropping that key makes these writes live again. A rejected
  // removal would otherwise reopen its confirmation against a session that
  // never issued it.
  //
  // A COUNTER rather than the owner id, because the id comes back: away and
  // back is `live:live -> live:navigation-only -> live:live`, and comparing
  // identity finds those equal and lets the stale write through. Mirrored into
  // a ref so callbacks read the latest value; written in an effect and never
  // during render.
  //
  // LAYOUT effect, not a passive one. A passive effect is scheduled, so a
  // promise settling in the gap between the owner-change commit and that
  // callback would still read the old generation and write through the guard —
  // the exact interleaving the guard exists to stop. Layout effects run inside
  // the commit, which closes it.
  const generationRef = useRef(ownerGeneration);
  useLayoutEffect(() => {
    generationRef.current = ownerGeneration;
  }, [ownerGeneration]);
  // CAN-5337: a discard confirmation's Retry runs the current owner's
  // deletion, and only for the owner that offered it.
  const deleteWorkspaceRef = useRef(props.onDeleteWorkspace);
  useLayoutEffect(() => {
    deleteWorkspaceRef.current = props.onDeleteWorkspace;
  });
  /**
   * CAN-5337: offers the discards a refused project deletion can take. The
   * host opens the confirmation only when discardable items are all that
   * block it (`onOpen` then hands over from this surface's own dialog);
   * otherwise the refusal shown here stands. A retry that is refused again
   * shows its refusal and offers again. A refusal that settles after the
   * owner changed offers nothing: the new owner did not issue it.
   */
  const offerDeletionDiscard = (
    removal: {
      workspaceId: string;
      name: string;
      presentation: 'archive' | 'delete';
    },
    message: string,
    generation: number,
    onOpen: () => void,
  ): void => {
    if (generationRef.current !== generation) return;
    if (capabilitiesOf(removal.workspaceId).projectDeletionDiscard !== true)
      return;
    offerProjectDeletionDiscard({
      workspaceId: removal.workspaceId,
      projectName: removal.name,
      message,
      onOpen,
      retry: () => {
        const remove = deleteWorkspaceRef.current;
        if (!remove || generationRef.current !== generation) return;
        remove(removal.workspaceId).catch((error: unknown) => {
          offerLifecycleJournalQuarantine(error);
          if (generationRef.current !== generation) return;
          const text =
            error instanceof Error && error.message
              ? error.message
              : `Could not ${removal.presentation} this project.`;
          setPendingWorkspaceRemoval({ ...removal, busy: false, error: text });
          offerDeletionDiscard(removal, text, generation, () => {
            if (generationRef.current === generation)
              setPendingWorkspaceRemoval(null);
          });
        });
      },
    });
  };
  // The workspace the open settings dialog describes, re-read from the live
  // snapshot every render. Renaming or recoloring from Details persists through
  // the host and comes back on the next overview refresh, so holding the object
  // captured at open time would leave the dialog subtitle naming the pre-rename
  // workspace and would keep Save diffing against a stale baseline — re-sending
  // an update that changes nothing on every later save. Falls back to the
  // captured workspace so a snapshot that momentarily drops the row (a refresh
  // in flight) does not blank out an open dialog.
  const liveSettingsWorkspace = settingsDialog
    ? snapshot.workspaces.find(
        (item) => item.localId === settingsDialog.workspace.localId,
      )
    : undefined;
  const settingsPendingMetadata = settingsDialog
    ? pendingWorkspaceMetadata[settingsDialog.workspace.localId]
    : undefined;
  const settingsWorkspace = settingsDialog
    ? settingsPendingMetadata
      ? {
          ...(liveSettingsWorkspace ?? settingsDialog.workspace),
          ...(settingsPendingMetadata.name
            ? { name: settingsPendingMetadata.name.value }
            : {}),
          ...(settingsPendingMetadata.color
            ? { color: settingsPendingMetadata.color.value }
            : {}),
        }
      : (liveSettingsWorkspace ?? settingsDialog.workspace)
    : null;
  useEffect(() => {
    const entries = Object.entries(pendingWorkspaceMetadata);
    if (entries.length === 0) return;
    const liveById = new Map(
      snapshot.workspaces.map((workspace) => [workspace.localId, workspace]),
    );
    setPendingWorkspaceMetadata((current) => {
      if (current !== pendingWorkspaceMetadata) return current;
      let changed = false;
      const next = { ...current };
      for (const [workspaceId, pending] of entries) {
        const live = liveById.get(workspaceId);
        if (!live) continue;
        const nameReconciled =
          pending.name !== undefined &&
          workspaceSnapshotVersion !== pending.name.afterSnapshotVersion &&
          (live.name === pending.name.value ||
            live.name !== pending.name.before);
        const colorReconciled =
          pending.color !== undefined &&
          workspaceSnapshotVersion !== pending.color.afterSnapshotVersion &&
          (live.color === pending.color.value ||
            live.color !== pending.color.before);
        if (!nameReconciled && !colorReconciled) continue;
        changed = true;
        if (
          (!pending.name || nameReconciled) &&
          (!pending.color || colorReconciled)
        ) {
          delete next[workspaceId];
          continue;
        }
        next[workspaceId] = {
          ...(!nameReconciled && pending.name ? { name: pending.name } : {}),
          ...(!colorReconciled && pending.color
            ? { color: pending.color }
            : {}),
        };
      }
      return changed ? next : current;
    });
  }, [pendingWorkspaceMetadata, snapshot.workspaces, workspaceSnapshotVersion]);
  const worktreeTestIdsFor =
    (
      workspaceLocalId: string,
      worktreeLocalId: string,
    ): ((value: WorktreeTestId | undefined, fallback: string) => string) =>
    (value, fallback) =>
      (typeof value === 'function'
        ? value(workspaceLocalId, worktreeLocalId)
        : value) ?? fallback;
  // Bulk selection and removal (CAN-3975): offered only where the host wired
  // an awaitable batch removal.
  // Normalize both classification axes once, so the list below and the
  // placement branches inside it read concrete values (REG-2819).
  const sections = scopedSnapshot.workspaces.map((workspace) => ({
    ...workspace,
    type: workspace.type ?? workspaceKind(workspace),
    layout: workspaceLayout(workspace),
  }));
  const defaultChatsWorkspaceId = defaultCoworkWorkspaceIdForContext(
    props.context,
  );
  const defaultChatsWorkspace = sections.find(
    (workspace) =>
      workspace.layout === 'flat' &&
      workspace.localId === defaultChatsWorkspaceId,
  );
  // CAN-3898: with no flat catch-all in this context, the automatic default
  // cloud workspace owns Chats, keeping its tree rows. The server's marker
  // elects it, never its name; more than one candidate hoists none rather
  // than choosing by order. `sections` is already context-scoped, so an
  // out-of-context default never reaches this.
  const cloudChatsCandidates = defaultChatsWorkspace
    ? []
    : sections.filter(
        (workspace) =>
          workspace.chatsHome === true &&
          workspace.layout === 'tree' &&
          workspace.backend === 'cloud' &&
          workspace.sharedFrom !== true &&
          props.sharedWorkspaceIds?.has(workspace.localId) !== true,
      );
  const cloudChatsWorkspace =
    cloudChatsCandidates.length === 1 ? cloudChatsCandidates[0] : undefined;
  const chatsOwner = defaultChatsWorkspace ?? cloudChatsWorkspace;
  const selectionRows = useSidebarSelectionRows();
  const worktreeBulk = useSidebarWorktreeBulk({
    enabled: props.onRemoveWorktreeInBatch !== undefined,
    snapshot,
    navigation: selection,
    capabilitiesOf,
    remove: props.onRemoveWorktreeInBatch,
    getFacts: props.getWorktreeBatchRemovalFacts,
    branchChoice: props.worktreeBatchBranchChoice === true,
    onStateChange: props.onWorktreeBatchRemovalStateChange,
    isWorkspaceCommandDisabled: props.isWorkspaceCommandDisabled,
    isWorktreeRemovalInProgress: props.isWorktreeRemovalInProgress,
    hasActiveWorktreeSession: props.hasActiveWorktreeSession,
    getWorktreeSetupPhase: (workspaceLocalId, worktreeLocalId) => {
      const phase = props.getWorktreeSetupPhase?.(
        workspaceLocalId,
        worktreeLocalId,
      );
      return phase === 'git-pending' || phase === 'running-setup'
        ? phase
        : undefined;
    },
    worktreeRetentionDaysFor: props.worktreeRetentionDaysFor,
    dialogTestId: testIds?.worktreeBatchRemovalDialog,
    // The same commands the rows' own Pin to top, Hide, and notification
    // choices run, with the same gates (see the row's callbacks below).
    setWorktreePinned:
      props.capabilities.worktreePinning === true && props.onUpdateWorktree
        ? (workspaceLocalId, worktreeLocalId, pinned): void =>
            props.onUpdateWorktree?.(workspaceLocalId, worktreeLocalId, {
              pinned,
            })
        : undefined,
    hideWorktree: props.onUpdateWorktree
      ? (workspaceLocalId, worktreeLocalId): void =>
          props.onUpdateWorktree?.(workspaceLocalId, worktreeLocalId, {
            hidden: true,
          })
      : undefined,
    hasRunningScripts: (workspaceLocalId, worktreeLocalId) =>
      props.hasRunningScripts?.(worktreeLocalId, workspaceLocalId) === true,
    stopRunningScripts: props.onStopRunningScripts,
    getNotificationState: props.getWorktreeNotificationSettings,
    setNotificationChoice: props.onSetWorktreeNotificationLevel,
    requestNotificationState: props.onWorktreeNotificationSettingsRequested,
  });
  // Work Entry rows (chats) select with the same gestures and confirm.
  let openWorkEntryKey: string | undefined;
  for (const listRows of selectionRows.rows.values()) {
    const open = listRows.find((row) => row.kind === 'work-entry' && row.open);
    if (open !== undefined) {
      openWorkEntryKey = open.key;
      break;
    }
  }
  const workEntryBulk = useSidebarWorkEntryBulk({
    enabled: props.onRemoveWorkEntryInBatch !== undefined,
    remove: props.onRemoveWorkEntryInBatch,
    getFacts: props.getWorkEntryBatchRemovalFacts,
    rows: selectionRows.rows,
    activeKey: openWorkEntryKey,
    isWorkspaceCommandDisabled: props.isWorkspaceCommandDisabled,
    retentionDaysFor: props.workEntryRetentionDaysFor,
    dialogTestId: testIds?.workEntryBatchRemovalDialog,
    onStateChange: props.onWorkEntryBatchRemovalStateChange,
    getEntryState: props.getWorkEntryBulkState,
    setPinned: props.onSetWorkEntryPinned,
    setStatus: props.onSetWorkEntryStatus,
    // A Work Entry keys its notification choice like a worktree does, as the
    // row's own menu does below.
    getNotificationState: props.getWorktreeNotificationSettings,
    setNotificationChoice: props.onSetWorktreeNotificationLevel,
    requestNotificationState: props.onWorktreeNotificationSettingsRequested,
  });
  const bulk = useSidebarBulk({
    enableSelectMode: true,
    chatsListId: chatsOwner?.localId,
    ...selectionRows,
    bindings: [worktreeBulk.binding, workEntryBulk.binding],
  });
  // A row queued for bulk removal is muted and inert like one the host is
  // already removing; the binding itself keeps reading the host's own signal
  // so the queue never skips its own items.
  const hostRemovalInProgress = props.isWorktreeRemovalInProgress;
  const isQueuedForRemoval = bulk.isQueuedForRemoval;
  const isRowRemovalInProgress = useCallback(
    (workspaceLocalId: string, worktreeLocalId: string): boolean =>
      hostRemovalInProgress?.(workspaceLocalId, worktreeLocalId) === true ||
      isQueuedForRemoval(worktreeRowKey(workspaceLocalId, worktreeLocalId)),
    [hostRemovalInProgress, isQueuedForRemoval],
  );
  const queuedRemovalFor = bulk.queuedRemovalFor;
  const queuedWorktreeRemoval = useCallback(
    (
      workspaceLocalId: string,
      worktreeLocalId: string,
    ): 'archive' | 'delete' | undefined =>
      queuedRemovalFor(worktreeRowKey(workspaceLocalId, worktreeLocalId)),
    [queuedRemovalFor],
  );
  // Kept per list binding, so a Work Entry list's binding is as stable as
  // the core's; selectability reads the latest host facts.
  const workEntryIsSelectableRef = useRef(workEntryBulk.isSelectable);
  workEntryIsSelectableRef.current = workEntryBulk.isSelectable;
  const workEntryBindingsRef = useRef(
    new WeakMap<SidebarRowMultiSelect, WorkEntryMultiSelectBinding>(),
  );
  const workEntryMultiSelectFor = (
    workspaceLocalId: string,
  ): WorkEntryMultiSelectBinding | undefined => {
    if (!workEntryBulk.binding.enabled) return undefined;
    const base = bulk.bindingFor(workspaceLocalId);
    const cached = workEntryBindingsRef.current.get(base);
    if (cached !== undefined) return cached;
    const extended = withWorkEntrySelectability(base, workEntryIsSelectableRef);
    workEntryBindingsRef.current.set(base, extended);
    return extended;
  };

  // Mirrors the two escape hatches inside `openSettings` below: a host either
  // handles the request itself, or supplies the loaders the built-in dialog
  // needs. Without one of those the call is a no-op, and any control bound to
  // it would be phantom chrome.
  // A Cowork Work Entry occupies its workspace's worktree slot, so its
  // notification choices use the same host lookups as a worktree row's.
  const getNotificationSettings = props.getWorktreeNotificationSettings;
  const requestNotificationSettings =
    props.onWorktreeNotificationSettingsRequested;
  const setNotificationLevel = props.onSetWorktreeNotificationLevel;
  const workEntryNotifications = useMemo(
    (): WorkEntryNotificationHandlers | undefined =>
      getNotificationSettings && setNotificationLevel
        ? {
            getState: getNotificationSettings,
            onOpen: (workspaceLocalId, workEntryId): void =>
              requestNotificationSettings?.(workspaceLocalId, workEntryId),
            onSelect: setNotificationLevel,
          }
        : undefined,
    [
      getNotificationSettings,
      requestNotificationSettings,
      setNotificationLevel,
    ],
  );
  // A muted space hides its rows' blue dots (CAN-4378). Without a host lookup
  // nothing is muted, so the rows keep every dot.
  const isWorktreeSpaceMuted = useMemo(
    () =>
      getNotificationSettings
        ? (workspaceLocalId: string, worktreeLocalId: string): boolean =>
            isSpaceNotificationMuted(
              getNotificationSettings(workspaceLocalId, worktreeLocalId),
            )
        : undefined,
    [getNotificationSettings],
  );
  // Activity follows the same mute: its builds and dots read this lookup.
  const activityHost = useMemo(
    () => withSidebarActivitySpaceMute(props.activity, isWorktreeSpaceMuted),
    [props.activity, isWorktreeSpaceMuted],
  );
  const canOpenWorkspaceSettings =
    props.onOpenWorkspaceSettingsOverride !== undefined ||
    (props.onLoadClaudeMd !== undefined && props.onLoadScripts !== undefined);

  const openSettings = (workspaceId: string, initialTab?: string): void => {
    if (
      props.onOpenWorkspaceSettingsOverride?.(workspaceId, initialTab) === true
    ) {
      return;
    }
    if (capabilitiesOf(workspaceId).workspaceSettings === 'details') {
      const workspace = snapshot.workspaces.find(
        (item) => item.localId === workspaceId,
      );
      if (workspace)
        setSettingsDialog({
          workspace,
          initialTab,
          content: '',
          scripts: {},
          detailsOnly: true,
        });
      return;
    }
    if (!props.onLoadClaudeMd || !props.onLoadScripts) return;
    const workspace = snapshot.workspaces.find(
      (item) => item.localId === workspaceId,
    );
    if (!workspace) return;
    const token = settingsRequest.current + 1;
    settingsRequest.current = token;
    const generation = ownerGeneration;
    void Promise.all([
      props.onLoadClaudeMd(workspaceId),
      props.onLoadScripts(workspaceId),
    ])
      .then(([content, scripts]) => {
        if (
          token === settingsRequest.current &&
          // A load the previous owner started must not open a dialog the
          // owner change just closed.
          generationRef.current === generation &&
          content !== null &&
          scripts !== null
        ) {
          setSettingsDialog({ workspace, initialTab, content, scripts });
        }
      })
      .catch(() => undefined);
  };

  // Shared creation can finish after this render's destination snapshot.
  const openSettingsRef = useRef({ snapshot, open: openSettings });
  useLayoutEffect(() => {
    openSettingsRef.current = { snapshot, open: openSettings };
  });

  const renderActions = ({
    workspace,
    worktree,
    worktreeRemoval,
    groupingState,
    structuralDescendantIds,
    pinnedSurface,
    itemGroupMenuItems,
  }: WorktreeRowSlotContext): WorktreeActionsSlot => {
    const pipelines =
      props.getPipelineEntries?.(workspace.localId, worktree.localId) ?? [];
    const splitPrInputs = props.getSplitPrEligibilityInputs?.(
      workspace.localId,
      worktree.localId,
    );
    const splitPrBlockers =
      props.getSplitPrBlockers?.(workspace.localId, worktree.localId) ?? [];
    // The row's own client answers: a cloud repository worktree grants it
    // per row while the composite's instance-wide set does not.
    const rowRepositoryAttachment = capabilitiesOf(
      worktree.localId,
    ).worktreeRepositoryAttachment;
    const addRepositoryAvailable =
      rowRepositoryAttachment === true &&
      props.isAddRepositoryAvailable?.(workspace.localId, worktree.localId) ===
        true &&
      props.onAddRepositoryRequested !== undefined;
    const baseWorktreeTestId = worktreeTestIdsFor(
      workspace.localId,
      worktree.localId,
    );
    // A pinned copy's controls carry the surface suffix, like the row itself,
    // so `getByTestId('…-menu-button')` still resolves to the in-flow row
    // alone while a copy is mounted (CAN-3127).
    const worktreeTestId = (
      value: WorktreeTestId | undefined,
      fallback: string,
    ): string =>
      `${baseWorktreeTestId(value, fallback)}${pinnedSurface ? `-${pinnedSurface}` : ''}`;
    let trigger: HTMLButtonElement | null = null;
    // Row-level command gate (REG-2785). A workspace whose host cannot accept
    // commands right now keeps its read-only affordances (branch info) and
    // loses every mutation, instead of offering actions guaranteed to fail.
    // Absent predicate ⇒ nothing is gated, so the desktop path is unchanged.
    const rowCommandsDisabled =
      props.isWorkspaceCommandDisabled?.(workspace.localId) === true;
    const gate = <THandler,>(
      handler: THandler | undefined,
    ): THandler | undefined => (rowCommandsDisabled ? undefined : handler);
    // Removal is offered only where THIS row's client implements it. The host
    // handler addresses every row, so without this a row whose own client
    // reports `worktreeRemoval: false` would still advertise archive.
    const rowRemoval =
      worktreeRemoval === undefined || worktreeRemoval === false
        ? undefined
        : gate(props.onArchiveWorktree);
    const rowRemovalPresentation =
      worktreeRemoval === 'archive' || worktreeRemoval === 'delete'
        ? worktreeRemoval
        : removalPresentation;
    const rowSubject = workspace.type === 'cowork' ? 'session' : 'worktree';
    const rowLabel = sidebarRowLabel(workspace, worktree);
    const menuLabel =
      rowSubject === 'session' ? (worktree.label?.trim() ?? '') : rowLabel;
    // "Branch from" creates a worktree like the project `+` AND forks an
    // existing one, so THIS row's client must report both `worktreeCreation`
    // and `worktreeBranching` (default-deny): a client can create worktrees
    // without being able to branch from one (every cloud target).
    const branchCapabilities = capabilitiesOf(worktree.localId);
    const createBranchWorktree =
      rowSubject === 'worktree' &&
      branchCapabilities.worktreeCreation === true &&
      branchCapabilities.worktreeBranching === true
        ? gate(props.onCreateBranchWorktree)
        : undefined;
    // The host's own dispatch dialog targets a code worktree (its working
    // directory picker lists that checkout's repositories); session rows keep
    // the shared picker, if the host serves one.
    const hostDispatch =
      rowSubject === 'worktree'
        ? gate(props.onDispatchPipelineRequested)
        : undefined;
    const groupingAction = groupingState?.isChild
      ? ({ kind: 'ungroup-from-base' } as const)
      : groupingState?.hasStructuralChildren
        ? ({
            kind:
              groupingState.nestedChildIds.length > 0
                ? 'ungroup-children'
                : 'group-children',
          } as const)
        : groupingState?.hasEligibleParent
          ? ({ kind: 'group-with-base' } as const)
          : undefined;
    const rowBulk = worktreeBulkRowMenu(
      worktreeBulk.binding.enabled
        ? bulk.bindingFor(workspace.localId)
        : undefined,
      worktreeRowKey(workspace.localId, worktree.localId),
    );
    const menu = deriveWorktreeMenuItems(
      {
        ...rowBulk.context,
        subject: rowSubject,
        label: menuLabel,
        branch: worktree.branch,
        hidden: worktree.hidden === true,
        pinned: worktree.pinned === true,
        done: isWorktreeDone(worktree),
        backend: worktree.backend,
        launchAvailable:
          props.isLaunchAvailable?.(worktree.localId, workspace.localId) ===
          true,
        launchRunning:
          props.isLaunchRunning?.(worktree.localId, workspace.localId) === true,
        // Main's snapshot covers every worktree; the host's live read sees a
        // run that started since the snapshot was built.
        scriptsRunning:
          worktree.scriptStatus === 'running' ||
          props.hasRunningScripts?.(worktree.localId, workspace.localId) ===
            true,
        pipelineAvailable: hostDispatch !== undefined || pipelines.length > 0,
        sentenceCaseLabels: props.sentenceCaseMenuLabels === true,
        splitPrEligible:
          splitPrInputs !== undefined && isSplitPrEligible(splitPrInputs),
        splitPrLocked: worktree.splitPrLocked === true,
        splitPrBlockers,
        groupingAction,
        addRepositoryAvailable,
        addRepositoryResumable:
          props.isAddRepositoryResumable?.(
            workspace.localId,
            worktree.localId,
          ) === true,
        hasActiveSession:
          worktree.isStreaming === true ||
          props.hasActiveWorktreeSession?.(
            workspace.localId,
            worktree.localId,
          ) === true,
        setupPhase:
          worktree.setupPhase === 'git-pending' ||
          worktree.setupPhase === 'running-setup'
            ? worktree.setupPhase
            : undefined,
        directRemovalAvailable:
          props.isDirectRemovalAvailable?.(
            workspace.localId,
            worktree.localId,
          ) === true,
        removalLockedBySplitPr: worktree.splitPrLocked === true,
        removalInProgress: isRowRemovalInProgress(
          workspace.localId,
          worktree.localId,
        ),
        retentionDays: props.worktreeRetentionDaysFor?.(workspace.localId),
        notifications: props.getWorktreeNotificationSettings?.(
          workspace.localId,
          worktree.localId,
        ),
        // Early access (compact rows): "Rename" with a pencil.
        renameLabelAction: props.compactWorktreeHoverActions === true,
      },
      {
        pipelines: capabilities.pipelines,
        worktreeSplitPr: capabilities.worktreeSplitPr,
        worktreeBranchGrouping: capabilities.worktreeBranchGrouping,
        worktreeRepositoryAttachment: rowRepositoryAttachment,
        removal: {
          behavior: rowRemoval ? 'archive' : false,
          presentation: rowRemovalPresentation,
          retention: capabilitiesOf(worktree.localId).worktreeRetention,
        },
      },
      {
        onSetLabelRequested: gate(props.onUpdateWorktree)
          ? (): void => {
              if (
                props.onSetLabelRequestedOverride?.(
                  workspace.localId,
                  worktree.localId,
                ) === true
              ) {
                return;
              }
              setWorktreeDialog({
                workspaceId: workspace.localId,
                id: worktree.localId,
                mode: 'label',
                focus: { current: trigger },
              });
            }
          : undefined,
        onBranchInfoRequested:
          rowSubject === 'worktree'
            ? (): void => {
                if (
                  props.onBranchInfoRequestedOverride?.(
                    workspace.localId,
                    worktree.localId,
                  ) === true
                ) {
                  return;
                }
                setWorktreeDialog({
                  workspaceId: workspace.localId,
                  id: worktree.localId,
                  mode: 'info',
                  focus: { current: trigger },
                });
              }
            : undefined,
        onDebugInfoRequested:
          worktree.backend === 'cloud' && props.onShowWorktreeDebugInfo
            ? (): void =>
                props.onShowWorktreeDebugInfo?.(
                  workspace.localId,
                  worktree.localId,
                )
            : undefined,
        onLaunchRequested: gate(props.onLaunchWorktree)
          ? (): void =>
              props.onLaunchWorktree?.(workspace.localId, worktree.localId)
          : undefined,
        onStopRunningScriptsRequested: gate(props.onStopRunningScripts)
          ? (): void =>
              props.onStopRunningScripts?.(workspace.localId, worktree.localId)
          : undefined,
        onDispatchPipelineRequested: hostDispatch
          ? (): void => hostDispatch(workspace.localId, worktree.localId)
          : gate(props.onDispatchPipeline)
            ? (): void =>
                setWorktreeDialog({
                  workspaceId: workspace.localId,
                  id: worktree.localId,
                  mode: 'pipeline',
                  focus: { current: trigger },
                })
            : undefined,
        onSplitPrRequested: gate(props.onSplitPrRequested)
          ? (): void =>
              props.onSplitPrRequested?.(workspace.localId, worktree.localId)
          : undefined,
        onCreateBranchRequested: createBranchWorktree
          ? (): void =>
              createBranchWorktree(workspace.localId, worktree.localId)
          : undefined,
        onGroupingRequested:
          groupingAction && gate(props.onSetBranchGroupingOverride)
            ? (): Promise<void> => {
                const override =
                  groupingAction.kind === 'ungroup-from-base' ||
                  groupingAction.kind === 'ungroup-children'
                    ? 'ungroup'
                    : 'group';
                const isDescendantAction =
                  groupingAction.kind === 'ungroup-children' ||
                  groupingAction.kind === 'group-children';
                const ids = isDescendantAction
                  ? (structuralDescendantIds ?? [])
                  : [worktree.localId];
                return applyBranchGroupingOverrides(
                  ids,
                  override,
                  (id, nextOverride) =>
                    props.onSetBranchGroupingOverride?.(
                      workspace.localId,
                      id,
                      nextOverride,
                    ),
                );
              }
            : undefined,
        onAddRepositoryRequested:
          addRepositoryAvailable && !rowCommandsDisabled
            ? (): void =>
                props.onAddRepositoryRequested?.(
                  workspace.localId,
                  worktree.localId,
                )
            : undefined,
        // The surface only emits the request: the dialog and the move belong
        // to the host, which reports the capability where it has a backend.
        onMoveToOrganizationRequested:
          props.capabilities.workspaceMoveToOrganization === true &&
          props.isWorkspaceMoveToOrganizationAvailable?.(workspace.localId) ===
            true &&
          gate(props.onMoveWorkspaceToOrganizationRequested)
            ? (): void =>
                props.onMoveWorkspaceToOrganizationRequested?.(
                  workspace.localId,
                )
            : undefined,
        onToggleHiddenRequested: gate(props.onUpdateWorktree)
          ? (): void =>
              props.onUpdateWorktree?.(workspace.localId, worktree.localId, {
                hidden: worktree.hidden !== true,
              })
          : undefined,
        // Pinning is a desktop affordance: offered only where the host reports
        // it, so the portal — whose snapshot never carries `pinned` — shows no
        // dead item.
        onTogglePinnedRequested:
          props.capabilities.worktreePinning === true &&
          gate(props.onUpdateWorktree)
            ? (): void =>
                props.onUpdateWorktree?.(workspace.localId, worktree.localId, {
                  pinned: worktree.pinned !== true,
                })
            : undefined,
        // Not behind `gate`: the choice is the viewer's own server-stored
        // preference, not a command against the row's host session.
        onNotificationChoiceRequested: props.onSetWorktreeNotificationLevel
          ? (choice): void =>
              props.onSetWorktreeNotificationLevel?.(
                workspace.localId,
                worktree.localId,
                choice,
              )
          : undefined,
        ...rowBulk.callbacks,
        onRemovalRequested: rowRemoval
          ? (mode): void => {
              if (
                props.onConfirmWorktreeRemovalOverride?.(
                  workspace.localId,
                  worktree.localId,
                  rowLabel,
                  mode,
                ) === true
              ) {
                return;
              }
              const copy = capabilitiesOf(worktree.localId).worktreeRemovalCopy;
              setPendingDelete({
                workspaceId: workspace.localId,
                worktreeId: worktree.localId,
                label: rowLabel,
                subject: rowSubject,
                mode,
                backend: worktree.backend,
                presentation: rowRemovalPresentation,
                ...(copy === undefined ? {} : { copy }),
              });
            }
          : undefined,
        testIds: {
          setLabel: worktreeTestId(
            testIds?.worktreeActionSetLabel,
            'portal-worktree-actions-set-label',
          ),
          debugInfo: worktreeTestId(
            undefined,
            'portal-worktree-actions-debug-info',
          ),
          branchInfo: worktreeTestId(
            testIds?.worktreeActionBranchInfo,
            'portal-worktree-actions-info',
          ),
          launch: worktreeTestId(
            testIds?.worktreeActionLaunch,
            'portal-worktree-actions-launch',
          ),
          stopScripts: worktreeTestId(
            undefined,
            'portal-worktree-actions-stop-scripts',
          ),
          dispatchPipeline: worktreeTestId(
            testIds?.worktreeActionDispatchPipeline,
            'portal-worktree-actions-dispatch-pipeline',
          ),
          splitPr: worktreeTestId(
            testIds?.worktreeActionSplitPr,
            'portal-worktree-actions-split-pr',
          ),
          addRepository: worktreeTestId(
            testIds?.worktreeActionAddRepository,
            'portal-worktree-actions-add-repository',
          ),
          createBranch: worktreeTestId(
            testIds?.worktreeActionCreateBranch,
            'portal-worktree-actions-create-branch',
          ),
          toggleHidden: worktreeTestId(
            testIds?.worktreeActionToggleHidden,
            'portal-worktree-actions-toggle-hidden',
          ),
          togglePin: worktreeTestId(
            testIds?.worktreeActionTogglePin,
            'portal-worktree-actions-toggle-pin',
          ),
          moveToOrganization: worktreeTestId(
            testIds?.worktreeActionMoveToOrganization,
            'portal-worktree-actions-move-to-organization',
          ),
          grouping: worktreeTestId(
            testIds?.worktreeActionGrouping,
            'portal-worktree-actions-grouping',
          ),
          delete: worktreeTestId(
            testIds?.worktreeDeletion,
            'portal-worktree-actions-delete',
          ),
          removal: worktreeTestId(
            testIds?.worktreeRemoval,
            'portal-delete-worktree',
          ),
          ...(testIds?.worktreeDeletion !== undefined
            ? {
                removalDelete: worktreeTestId(
                  testIds.worktreeDeletion,
                  'portal-delete-worktree',
                ),
              }
            : {}),
          directRemoval: worktreeTestId(
            testIds?.worktreeDirectRemoval,
            'portal-worktree-delete-button',
          ),
          directShow: worktreeTestId(
            testIds?.worktreeDirectShow,
            'portal-worktree-show-button',
          ),
          bulkPin: worktreeTestId(
            undefined,
            'portal-worktree-actions-bulk-pin',
          ),
          bulkStopScripts: worktreeTestId(
            undefined,
            'portal-worktree-actions-bulk-stop-scripts',
          ),
          bulkArchive: worktreeTestId(
            undefined,
            'portal-worktree-actions-bulk-archive',
          ),
          bulkDelete: worktreeTestId(
            undefined,
            'portal-worktree-actions-bulk-delete',
          ),
          notifications: worktreeTestId(
            testIds?.worktreeNotifications,
            'portal-worktree-actions',
          ),
        },
      },
    );
    const hostContext: WorktreeRowSlotContext = {
      workspace,
      worktree,
      selected:
        props.selection?.kind === 'worktree' &&
        props.selection.workspaceLocalId === workspace.localId &&
        props.selection.worktreeLocalId === worktree.localId,
      hidden: worktree.hidden === true,
      sortable: false,
      worktreeRemoval,
      groupingState,
      structuralDescendantIds,
      ...(pinnedSurface ? { pinnedSurface } : {}),
    };
    const pinIndex = menu.items.findIndex((item) => item.key === 'toggle-pin');
    // A selection's menu is the selection's actions alone, with its group
    // moves after its Pin row as on the row's menu; host rows address one
    // worktree and stay out of it.
    const bulkMenu =
      rowBulk.context.bulkSelection !== undefined &&
      rowBulk.context.bulkSelection.count >= 2 &&
      rowBulk.callbacks.onBulkRemovalRequested !== undefined;
    const organizingItems =
      itemGroupMenuItems && !rowCommandsDisabled
        ? bulkMenu
          ? withSelectionGroupItems(menu.items, itemGroupMenuItems)
          : [
              ...menu.items.slice(0, pinIndex + 1),
              ...itemGroupMenuItems,
              ...menu.items.slice(pinIndex + 1),
            ]
        : menu.items;
    const autoDeleteItem = autoDelete(
      workspace.localId,
      worktree.localId,
      worktree.label || worktree.branch || worktree.localId,
    );
    const removalIndex = organizingItems.findIndex(
      (item) => item.key === 'archive' || item.key === 'delete',
    );
    const armedItems =
      !bulkMenu && autoDeleteItem
        ? [
            ...organizingItems.slice(
              0,
              removalIndex < 0 ? organizingItems.length : removalIndex,
            ),
            autoDeleteItem,
            ...organizingItems.slice(
              removalIndex < 0 ? organizingItems.length : removalIndex,
            ),
          ]
        : organizingItems;
    const transformedItems = bulkMenu
      ? armedItems
      : (props.transformWorktreeMenuItems?.(hostContext, armedItems) ??
        armedItems);
    // A hover shortcut copies a menu row, so a row the host withholds takes
    // its shortcut with it: Show rides on Hide/Show, and the removal chip on
    // the row it runs (Delete where Archive and Delete both exist, otherwise
    // either). Otherwise the row keeps offering what the host took away.
    const removalSourceKeys: readonly string[] =
      capabilitiesOf(worktree.localId).worktreeRetention === 'archive-or-delete'
        ? ['delete']
        : ['archive', 'delete'];
    const directActions = props.transformWorktreeMenuItems
      ? menu.directActions.filter((action) =>
          action.key === 'show'
            ? transformedItems.some((item) => item.key === 'toggle-hidden')
            : action.key === 'remove'
              ? transformedItems.some((item) =>
                  removalSourceKeys.includes(item.key),
                )
              : true,
        )
      : menu.directActions;
    const allMenuItems = bulkMenu
      ? transformedItems
      : withHostMenuItems(
          transformedItems,
          props.getWorktreeExtraMenuItems?.(
            workspace.localId,
            worktree.localId,
          ),
        );
    // Notifications use one submenu in every sidebar style. Compact rows
    // additionally fold their rarer actions into More.
    const notificationMenuItems =
      foldWorktreeNotificationsIntoSubmenu(allMenuItems);
    const menuItems =
      props.compactWorktreeHoverActions === true
        ? foldWorktreeMenuIntoMore(notificationMenuItems)
        : notificationMenuItems;
    // Compact hover: Pin and Archive, copied from this row's own menu items
    // so a withheld or unavailable action stays out of the hover too.
    const pinItem = menuItems.find(
      (item) => item.key === 'toggle-pin' && !item.disabled && item.onSelect,
    );
    const archiveItem = menuItems.find(
      (item) => item.key === 'archive' && !item.disabled && item.onSelect,
    );
    const pinSelect = pinItem?.onSelect;
    const archiveSelect = archiveItem?.onSelect;
    // An Archive the menu offers but cannot run right now stays in the
    // hover, greyed out, saying why (a withheld one stays out).
    const archiveBlockedReason =
      archiveSelect === undefined &&
      menuItems.some(
        (item) => item.key === 'archive' && item.disabled && item.onSelect,
      )
        ? worktreeArchiveBlockedReason({
            removalLockedBySplitPr: worktree.splitPrLocked === true,
            removalInProgress: isRowRemovalInProgress(
              workspace.localId,
              worktree.localId,
            ),
          })
        : undefined;
    const hoverActions: readonly WorktreeDirectAction[] =
      props.compactWorktreeHoverActions === true
        ? [
            ...directActions.filter((action) => action.key === 'show'),
            ...(pinSelect
              ? [
                  {
                    key: 'pin',
                    icon: worktree.pinned === true ? PinFilledIcon : PinIcon,
                    label: worktree.pinned === true ? 'Unpin' : 'Pin',
                    onSelect: pinSelect,
                    tone: 'neutral' as const,
                    testId: worktreeTestId(
                      undefined,
                      'portal-worktree-pin-button',
                    ),
                    className: 'pointer-coarse:hidden',
                  },
                ]
              : []),
            ...(archiveSelect
              ? [
                  {
                    key: 'archive',
                    icon: ArchiveBoxIcon,
                    label: 'Archive',
                    onSelect: archiveSelect,
                    tone: 'neutral' as const,
                    testId: worktreeTestId(
                      undefined,
                      'portal-worktree-archive-button',
                    ),
                    className: 'pointer-coarse:hidden',
                  },
                ]
              : archiveBlockedReason !== undefined
                ? [
                    {
                      key: 'archive',
                      icon: ArchiveBoxIcon,
                      label: `Archive: ${archiveBlockedReason}`,
                      tooltip: archiveBlockedReason,
                      disabled: true,
                      onSelect: (): void => undefined,
                      tone: 'neutral' as const,
                      testId: worktreeTestId(
                        undefined,
                        'portal-worktree-archive-button',
                      ),
                      className: 'pointer-coarse:hidden',
                    },
                  ]
                : []),
          ]
        : directActions;
    const menuControl = (
      <WorktreeActionsMenu
        ref={(node) => {
          trigger = node;
        }}
        items={menuItems}
        directActions={hoverActions}
        hideTriggerForFinePointer={props.compactWorktreeHoverActions === true}
        // Pin keeps its spot (over the resting pin icon) when the row
        // cannot be archived.
        reserveTrailingSlot={
          props.compactWorktreeHoverActions === true &&
          pinSelect !== undefined &&
          archiveSelect === undefined &&
          archiveBlockedReason === undefined
        }
        accessibleLabel={`Actions for ${rowLabel}`}
        triggerTestId={worktreeTestId(
          testIds?.worktreeActionsMenuButton,
          'portal-worktree-actions-menu-button',
        )}
        menuTestId={worktreeTestId(
          testIds?.worktreeActionsMenu,
          'portal-worktree-actions-menu',
        )}
        triggerDataAttributes={
          rowRemoval ? { 'data-delete-enabled': 'true' } : undefined
        }
        onOpen={
          props.onWorktreeNotificationSettingsRequested
            ? (): void =>
                props.onWorktreeNotificationSettingsRequested?.(
                  workspace.localId,
                  worktree.localId,
                )
            : undefined
        }
      />
    );
    return {
      node: menuControl,
      // Compact hover: the ••• trigger is hidden for fine pointers, so the
      // title reserves room for the hover buttons alone.
      buttonCount:
        props.compactWorktreeHoverActions === true
          ? hoverActions.length +
            Number(
              pinSelect !== undefined &&
                archiveSelect === undefined &&
                archiveBlockedReason === undefined,
            )
          : worktreeActionsMenuButtonCount({
              items: menuItems,
              directActions,
            }),
    };
  };

  const renderDialogs = ({
    workspace,
    worktree,
  }: WorktreeRowSlotContext): ReactNode => {
    if (
      worktreeDialog?.workspaceId !== workspace.localId ||
      worktreeDialog.id !== worktree.localId
    ) {
      return null;
    }
    const close = (): void => setWorktreeDialog(null);
    if (worktreeDialog.mode === 'pipeline') {
      return (
        <PipelinePickerDialog
          entries={(
            props.getPipelineEntries?.(workspace.localId, worktree.localId) ??
            []
          ).map((entry) => ({
            id: entry.id,
            name: entry.name,
            disabled: entry.running,
            statusLabel: entry.running ? 'Running' : undefined,
          }))}
          onRun={(id) =>
            props.onDispatchPipeline?.(workspace.localId, worktree.localId, id)
          }
          onClose={close}
          returnFocusRef={worktreeDialog.focus}
        />
      );
    }
    return (
      <WorktreeInfoDialog
        mode={worktreeDialog.mode}
        branch={workspace.type === 'cowork' ? 'Session' : worktree.branch}
        worktreeId={worktree.localId}
        initialLabel={worktree.label}
        onSaveLabel={
          props.onUpdateWorktree &&
          props.isWorkspaceCommandDisabled?.(workspace.localId) !== true
            ? (label): void =>
                props.onUpdateWorktree?.(workspace.localId, worktree.localId, {
                  label,
                })
            : undefined
        }
        onClose={close}
        returnFocusRef={worktreeDialog.focus}
        renameTitle={props.compactWorktreeHoverActions === true}
      />
    );
  };

  const style: CSSProperties | undefined = fillsParent
    ? undefined
    : // Hosts seed `--worktree-panel-width` (web: SIDEBAR_RAIL_DEFAULT_WIDTH);
      // the fallback mirrors desktop's fixed 280px rail rather than a viewport
      // fraction so an unseeded mount cannot drift back to the old 28% width.
      { width: 'var(--worktree-panel-width, 280px)' };
  // Placement only; the frame paints itself on `--bg-sidebar` like desktop's
  // rail (web chat parity, slice 6) and owns the responsive `split`.
  const className = fillsParent
    ? 'relative min-w-0 flex-1'
    : 'relative min-w-0';
  const visibleWorktrees = props.hiddenWorktreeIds
    ? scopedSnapshot.worktrees.filter(
        (worktree) => !props.hiddenWorktreeIds?.has(worktree.localId),
      )
    : scopedSnapshot.worktrees;
  const hiddenWorkspacesToggleId =
    testIds?.hiddenWorkspacesToggle ?? 'portal-hidden-workspaces-toggle';
  // Archive is judged per chat by its owning project, so a fallback row never
  // borrows another project's capability (CAN-5461).
  const canArchiveStandaloneChat = (chat: {
    readonly projectLocalId: string;
  }): boolean => {
    const owner = scopedSnapshot.workspaces.find(
      (workspace) => workspace.localId === chat.projectLocalId,
    );
    return (
      owner !== undefined &&
      owner.type === 'cowork' &&
      owner.backend !== 'cloud' &&
      owner.sharedFrom !== true &&
      !props.sharedWorkspaceIds?.has(chat.projectLocalId) &&
      !props.isWorkspaceCommandDisabled?.(chat.projectLocalId) &&
      (props.capabilitiesFor?.(chat.projectLocalId) ?? capabilities)
        .standaloneChatArchive === true
    );
  };
  const standaloneChatArchiveProps = (
    readOnly: boolean,
  ): {
    readonly onArchiveChat?: SidebarSurfaceProps['onArchiveStandaloneChat'];
    readonly canArchiveChat?: (chat: {
      readonly projectLocalId: string;
    }) => boolean;
  } =>
    readOnly || props.onArchiveStandaloneChat === undefined
      ? {}
      : {
          onArchiveChat: props.onArchiveStandaloneChat,
          canArchiveChat: canArchiveStandaloneChat,
        };

  const renderWorkspaceList = (
    listWorkspaces: typeof sections,
    listTestIds: {
      readonly root?: string;
      readonly hiddenWorkspacesToggle: string;
    },
    readOnly = false,
    suppressContextEmptyState = false,
    // The rows of a tree-shaped Chats owner, under the Chats header rather
    // than their own project header (CAN-3898).
    headerless = false,
  ): JSX.Element => {
    // Pending projects belong to the viewer's own list, not Shared with me.
    const listPendingProjects = readOnly ? [] : (props.pendingProjects ?? []);
    // An organization's empty Projects list still reaches the host's empty
    // state below its Chats section (CAN-3537); an empty Personal list under
    // Chats renders no row, but still reports that it is empty.
    if (
      suppressContextEmptyState &&
      listWorkspaces.length === 0 &&
      listPendingProjects.length === 0 &&
      props.context?.kind !== 'organization'
    ) {
      return readOnly ? (
        <></>
      ) : (
        <>
          <ProjectsEmptyStateMark onChange={setProjectsListEmpty} />
          {props.emptyProjectsSlot}
        </>
      );
    }
    const renderContextEmptyState = props.renderContextEmptyState;
    // The transient host-state gate is resolved PER ROW inside
    // `WorkspacesSidebarSections`, not here. It used to be list-level — "withhold
    // creation and reorder while ANY member's host cannot accept commands" —
    // which was exact only while sections kept the backends in separate lists.
    // In one mixed list it is lossy in the worst direction: a single
    // disconnected desktop row would withdraw create and reorder from every
    // cloud row, whose backend is reachable and which the host deliberately
    // keeps always-eligible. Handlers are therefore passed unconditionally and
    // each row decides for itself, mirroring `capabilitiesFor`'s per-row split.
    return (
      <SortableWorkspacesSidebar
        // Chats lists its one owner's rows; project pagination has nothing
        // to bound there.
        paginateProjects={!headerless}
        headerless={headerless}
        compactProjectPagination={props.compactListDisclosures}
        hideWorkspaceCounts={props.hideWorkspaceCounts}
        // Early access (compact rows): project menus open by right-click
        // too, so their hover `•••` goes the way of the worktree rows'.
        hideWorkspaceOptionsForFinePointer={
          props.compactWorktreeHoverActions === true
        }
        worktreeRowGap={props.worktreeRowGap}
        worktreeHoverPreview={props.worktreeHoverPreview}
        retainedWorkspaceIds={[
          ...(props.projectListRetainedWorkspaceIds ?? []),
          selection?.kind === 'standalone-chat'
            ? scopedSnapshot.standaloneChats.find(
                (chat) => chat.localId === selection.standaloneChatId,
              )?.projectLocalId
            : undefined,
        ]}
        state={{
          workspaces: listWorkspaces,
          worktrees: visibleWorktrees,
          // A flat project's live content, for the `alwaysShow: false` rule.
          standaloneChats: scopedSnapshot.standaloneChats,
          chatSummaries: scopedSnapshot.chatSummaries,
        }}
        rowPresentation={props.rowPresentation}
        worktreeDiffStatsStyle={props.worktreeDiffStatsStyle}
        capabilities={capabilities}
        capabilitiesFor={props.capabilitiesFor}
        onRemoveWorkspace={
          !readOnly && props.onDeleteWorkspace
            ? (workspaceLocalId): void =>
                setPendingWorkspaceRemoval({
                  workspaceId: workspaceLocalId,
                  name:
                    listWorkspaces.find(
                      (workspace) => workspace.localId === workspaceLocalId,
                    )?.name ?? workspaceLocalId,
                  presentation:
                    workspaceRemovalOf(workspaceLocalId) === 'delete'
                      ? 'delete'
                      : 'archive',
                  busy: false,
                  error: null,
                })
            : undefined
        }
        selected={selection?.kind === 'standalone-chat' ? null : selection}
        onSelectWorkspace={(workspaceLocalId) =>
          onSelect({ kind: 'workspace', workspaceLocalId })
        }
        onSelectWorktree={(workspaceLocalId, worktreeLocalId) =>
          onSelect({
            kind: 'worktree',
            workspaceLocalId,
            worktreeLocalId,
          })
        }
        workEntryMultiSelectFor={readOnly ? undefined : workEntryMultiSelectFor}
        worktreeMultiSelect={
          !worktreeBulk.binding.enabled
            ? undefined
            : {
                ...bulk.bindingFor(listTestIds.hiddenWorkspacesToggle),
                // A queued row is inert until the queue finishes or stops.
                isSelectable: (workspace, worktree) =>
                  worktreeBulk.isSelectable(workspace, worktree) &&
                  !isQueuedForRemoval(
                    worktreeRowKey(workspace.localId, worktree.localId),
                  ),
              }
        }
        touchTargets={touch}
        creationEnabled={!readOnly && props.onCreateWorktree !== undefined}
        isWorkspaceCommandDisabled={
          readOnly ? (): boolean => true : props.isWorkspaceCommandDisabled
        }
        itemGroupCommandsFor={readOnly ? undefined : props.itemGroupCommandsFor}
        onCreationError={props.onGroupError}
        branchGroupingEnabled={props.branchGroupingEnabled}
        getBranchGrouping={props.getBranchGrouping}
        onWorkspaceCollapsedChange={props.onWorkspaceCollapsedChange}
        workspaceNameTogglesCollapse={props.workspaceNameTogglesCollapse}
        visibleWorkspaceIds={props.visibleWorkspaceIds}
        context={props.context}
        emptyListMark={
          readOnly ? undefined : (
            <ProjectsEmptyStateMark onChange={setProjectsListEmpty} />
          )
        }
        renderContextEmptyState={
          renderContextEmptyState === undefined || headerless
            ? undefined
            : (): ReactNode =>
                renderContextEmptyState({
                  chatsListed: suppressContextEmptyState,
                })
        }
        additionalRows={
          readOnly || props.workspacesSectionCollapsible || headerless
            ? undefined
            : props.additionalRows
        }
        pendingProjects={headerless ? undefined : listPendingProjects}
        additionalProjects={headerless ? undefined : props.additionalProjects}
        linkedPersonalWorkspaceIds={props.linkedPersonalWorkspaceIds}
        onWorktreeIntent={props.onWorktreeIntent}
        onWorktreeRowElement={props.onWorktreeRowElement}
        pendingRevealTarget={props.pendingRevealTarget}
        onCreateWorktree={async (id, groupId) =>
          readOnly
            ? { status: 'pending' }
            : ((await props.onCreateWorktree?.(id, groupId)) ?? {
                status: 'pending',
              })
        }
        onReorderWorkspace={readOnly ? undefined : props.onReorderWorkspaces}
        onReorderWorktree={readOnly ? undefined : props.onReorderWorktrees}
        renderWorkspaceDragHandleContent={({
          workspace,
          testIdSuffix,
          collapsed,
        }) => {
          // The glyph is the whole icon, as on cowork rows: a tinted tile
          // behind it would ring the 16px badge and avatar with project color.
          const icon = (
            <ProjectAvatarBadge
              testIdSuffix={testIdSuffix}
              kind={workspaceKind(workspace)}
              temporary={workspace.temporary}
              color={workspaceColor(workspace)}
              avatarUrl={workspace.avatarUrl}
            />
          );
          // The hover chevron is desktop's disclosure; other hosts keep the
          // header's trailing chevron beside the name.
          return props.workspaceNameTogglesCollapse === true ? (
            <WorkspaceIconDisclosureSwap
              collapsed={collapsed}
              testIdSuffix={testIdSuffix ?? ''}
            >
              {icon}
            </WorkspaceIconDisclosureSwap>
          ) : (
            icon
          );
        }}
        renderWorktreeStatus={props.renderWorktreeStatus}
        useWorktreeRowOverrides={props.useWorktreeRowOverrides}
        renderWorktreeIdSlot={props.renderWorktreeIdSlot}
        deriveWorktreeRowLabel={props.deriveWorktreeRowLabel}
        renderWorktreeActions={readOnly ? undefined : renderActions}
        renderWorktreeDialogs={readOnly ? undefined : renderDialogs}
        renderWorkspaceContextMenuItems={props.renderWorkspaceContextMenuItems}
        isWorkspaceContextMenuAvailable={props.isWorkspaceContextMenuAvailable}
        getWorkspaceHeaderEmphasis={props.getWorkspaceHeaderEmphasis}
        isWorkspacePinned={props.isWorkspacePinned}
        getWorktreeSetupPhase={props.getWorktreeSetupPhase}
        isWorktreeRemovalInProgress={isRowRemovalInProgress}
        getWorktreeQueuedRemoval={queuedWorktreeRemoval}
        isWorktreeShared={props.isWorktreeShared}
        isWorktreeSpaceMuted={isWorktreeSpaceMuted}
        isWorktreeListed={props.isWorktreeListed}
        renderPipelinePopover={({
          workspace,
          worktree,
          pipelineStatus,
          anchorRect,
          popoverListId,
          onPopoverMouseEnter,
          onPopoverMouseLeave,
          onPopoverFocus,
          onPopoverBlur,
          onPopoverDismiss,
          onPopoverListReady,
        }) =>
          pipelineStatus && anchorRect ? (
            <SidebarPipelineStatusPopover
              anchorRect={anchorRect}
              worktreeLocalId={worktree.localId}
              workspaceLocalId={workspace.localId}
              getEntries={props.getPipelinePopoverEntries}
              subscribeEntries={props.subscribePipelinePopoverEntries}
              status={pipelineStatus}
              listId={popoverListId}
              onListMouseEnter={onPopoverMouseEnter}
              onListMouseLeave={onPopoverMouseLeave}
              onListFocus={onPopoverFocus}
              onListBlur={onPopoverBlur}
              onListDismiss={onPopoverDismiss}
              onScrollableListReady={onPopoverListReady}
            />
          ) : null
        }
        renderTerminalPopover={({ worktree, anchorRect }) =>
          worktree.terminalStatus && anchorRect ? (
            <SidebarTerminalStatusPopover
              anchorRect={anchorRect}
              worktreeLocalId={worktree.localId}
              status={worktree.terminalStatus}
              getRows={props.getTerminalPopoverRows}
              subscribeRows={props.subscribeTerminalPopoverRows}
            />
          ) : null
        }
        derivePrStatus={({ worktree }) =>
          derivePrBadgeStatus(worktree.lastKnownPrStatus)
        }
        deriveDoneLabel={({ worktree }) =>
          hasAllKnownPrsMerged(worktree.lastKnownPrStatus)
            ? 'PR merged'
            : undefined
        }
        renderCoworkWorkspace={
          props.renderCoworkWorkspace ??
          (({
            workspace,
            onSelect: onSelectWorkspace,
            onCollapsedChange,
            workEntryMultiSelect,
          }): JSX.Element | null =>
            snapshotWorkspaceMatchesContext(
              workspace,
              props.context,
              props.linkedPersonalWorkspaceIds,
            ) ? (
              <StandaloneChatsSidebarSection
                snapshot={scopedSnapshot}
                workspace={workspace}
                workEntryMultiSelect={workEntryMultiSelect}
                {...standaloneChatArchiveProps(readOnly)}
                itemGroupCommands={
                  !readOnly &&
                  !props.isWorkspaceCommandDisabled?.(workspace.localId) &&
                  (props.capabilitiesFor?.(workspace.localId) ?? capabilities)
                    .itemGrouping === true
                    ? props.itemGroupCommandsFor?.(workspace.localId)
                    : undefined
                }
                onCreateInGroup={(groupId) =>
                  props.onCreateStandaloneGroupItem?.(
                    workspace.localId,
                    groupId,
                  )
                }
                onGroupError={(error) =>
                  props.onGroupError?.(workspace.localId, error)
                }
                collapsed={workspace.collapsed === true}
                onCollapsedChange={onCollapsedChange}
                selectedStandaloneChatId={
                  selection?.kind === 'standalone-chat'
                    ? selection.standaloneChatId
                    : null
                }
                touchTargets={touch}
                onSelectChat={(standaloneChatId) =>
                  onSelect({ kind: 'standalone-chat', standaloneChatId })
                }
                onSelectWorkspace={onSelectWorkspace}
                nameTogglesCollapse={props.workspaceNameTogglesCollapse}
                testIds={{
                  root:
                    testIds?.coworkWorkspace?.(workspace.localId) ??
                    `portal-cowork-workspace-${workspace.localId}`,
                  folderToggle: testIds?.workspaceToggle?.(
                    workspace.localId,
                    workspace.type,
                  ),
                  chatRow: testIds?.standaloneChatRow,
                }}
              />
            ) : null)
        }
        renderArchivedSection={props.renderArchivedSection}
        archivedCount={props.archivedCount}
        archivedEntries={props.archivedEntries}
        onLoadArchived={props.onLoadArchived}
        archivedExpanded={props.archivedExpanded}
        onArchivedExpandedChange={props.onArchivedExpandedChange}
        onViewArchived={props.onViewArchived}
        onRestoreArchived={props.onRestoreArchived}
        onDeleteArchived={props.onDeleteArchived}
        renderArchivedActions={props.renderArchivedActions}
        onOpenWorkspaceSettings={
          !readOnly &&
          (props.onOpenWorkspaceSettingsOverride ||
            (props.onLoadClaudeMd && props.onLoadScripts))
            ? openSettings
            : undefined
        }
        // Served only where a host actually owns the settings dialog. The
        // read-only rail (every protected route outside /chat) omits the
        // override, so the item — and with it the whole menu — is dropped
        // rather than rendered dead. Same policy as `isServed` for nav rows.
        onShareWorkspaceTemplate={
          !readOnly && props.onOpenWorkspaceSettingsOverride
            ? (workspaceId: string): void => openSettings(workspaceId, 'share')
            : undefined
        }
        testIds={{
          root: listTestIds.root,
          workspace: testIds?.workspaceSection,
          workspaceHeader: testIds?.workspaceHeader,
          workspaceToggle: testIds?.workspaceToggle,
          workspaceSortableHeader: testIds?.workspaceSortableHeader,
          hiddenWorktreesSection: testIds?.hiddenWorktreesSection,
          workspaceOptionsButton: testIds?.workspaceOptionsButton,
          workspaceContextMenu: testIds?.workspaceContextMenu,
          workspaceEmpty: testIds?.workspaceEmpty,
          worktreeRow: testIds?.worktreeRow,
          hiddenWorkspacesToggle: listTestIds.hiddenWorkspacesToggle,
          hiddenWorktreesToggle: (id) =>
            testIds?.hiddenWorktreesToggle?.(id) ??
            `portal-hidden-worktrees-toggle-${id}`,
        }}
      />
    );
  };

  // Web chat parity, slice 6: desktop renders the catch-all Cowork workspace
  // as a `Chats` section ABOVE the Projects header, not as a folder inside the
  // project list. Elected by its stable id, never by name: workspace names are
  // user-editable and non-unique, so a user project called "Personal" or
  // "Chats" must keep its place in the list. Only the FLAT catch-all
  // qualifies; a cloud workspace (cowork-typed but tree-shaped) never leaves
  // the list (REG-2819). Each context has its own catch-all: Personal's
  // `cowork-default`, or the organization's `cowork-org-<id>` in org scope.
  const cloudChatsWorkspaceId = cloudChatsWorkspace?.localId;
  useEffect(() => {
    if (!pendingCloudChat) return;
    if (pendingCloudChat.workspaceLocalId !== cloudChatsWorkspaceId) {
      setPendingCloudChat(null);
      return;
    }
    // Live /chat returns `pending`: select the row when the authoritative
    // snapshot publishes it, just as the former project-header action did.
    const newIds = pendingCloudChat.worktreeId
      ? [pendingCloudChat.worktreeId]
      : newWorktreeIdsAfterSnapshot(
          pendingCloudChat.baseline,
          pendingCloudChat.workspaceLocalId,
          snapshot.worktrees,
        );
    if (newIds.length === 0) return;
    setPendingCloudChat(null);
    // Multiple additions are ambiguous without a request correlation id.
    if (newIds.length === 1) {
      onSelect({
        kind: 'worktree',
        workspaceLocalId: pendingCloudChat.workspaceLocalId,
        worktreeLocalId: newIds[0],
      });
    }
  }, [cloudChatsWorkspaceId, onSelect, pendingCloudChat, snapshot.worktrees]);
  const showStandaloneChats =
    snapshotWorkspaceMatchesContext({}, props.context) &&
    sections.every(
      (workspace): boolean => workspaceLayout(workspace) !== 'flat',
    );
  const listedSections = chatsOwner
    ? sections.filter((workspace) => workspace !== chatsOwner)
    : sections;
  const sharedSections = props.sharedWorkspaceIds
    ? listedSections.filter(
        (workspace) =>
          props.sharedWorkspaceIds?.has(workspace.localId) &&
          visibleWorktrees.some(
            (worktree) => worktree.workspaceLocalId === workspace.localId,
          ),
      )
    : [];
  const ownedSections = props.sharedWorkspaceIds
    ? listedSections.filter(
        (workspace) => !props.sharedWorkspaceIds?.has(workspace.localId),
      )
    : listedSections;
  // A collapsed body unmounts its empty-state reporter. The canonical
  // partition still proves there is no owned project, so keep creation visible
  // even before the body first mounts; pending project rows make it nonempty.
  const projectsPartitionEmpty =
    contentState === 'ready' &&
    ownedSections.length === 0 &&
    (props.pendingProjects?.length ?? 0) === 0;
  // No headline for nothing: an empty Chats section renders nothing at all
  // (Daniil, 2026-09-16). Emptiness follows the section's own ownership rule
  // (unparented chats count only when the catch-all is the primary flat
  // workspace), so the gate and the list can never disagree.
  const defaultChatsCount = defaultChatsWorkspace
    ? standaloneChatsForWorkspace(scopedSnapshot, defaultChatsWorkspace).length
    : 0;
  // A host that supplies its own rows also owns the emptiness rule, and the
  // header stays while empty whenever its "+" can start a chat: that "+" is
  // the only route to a first chat, on desktop and portal alike (CAN-3537).
  // An elected cloud owner keeps its header while empty, creatable or not:
  // the server elected it as this account's home for chats.
  const hostKeepsChatsSection =
    props.renderChatsSectionRows !== undefined ||
    props.onCreateChatsSectionChat !== undefined;
  const chatsSectionLoading =
    contentState === 'loading' &&
    (props.loadingChatsSection ?? hostKeepsChatsSection);
  const chatsSectionVisible =
    cloudChatsWorkspace !== undefined ||
    (defaultChatsWorkspace !== undefined &&
      (props.renderChatsSectionRows !== undefined ||
        props.onCreateChatsSectionChat !== undefined ||
        defaultChatsCount > 0));
  const cloudChatsRows = cloudChatsWorkspace
    ? visibleWorktrees.filter(
        (worktree) => worktree.workspaceLocalId === cloudChatsWorkspace.localId,
      )
    : [];
  const cloudChatsCapabilities = cloudChatsWorkspace
    ? (props.capabilitiesFor?.(cloudChatsWorkspace.localId) ?? capabilities)
    : capabilities;
  const cloudChatsCommandsDisabled =
    cloudChatsWorkspace !== undefined &&
    props.isWorkspaceCommandDisabled?.(cloudChatsWorkspace.localId) === true;
  const onCreateWorktree = props.onCreateWorktree;
  // The tree owner's "+" creates in THAT workspace, exactly as its project
  // header's did; a host's flat-owner chat callback never applies to it.
  const createCloudChatsChat =
    cloudChatsWorkspace && onCreateWorktree && !cloudChatsCommandsDisabled
      ? (): void => {
          if (pendingCloudChat) return;
          const workspaceLocalId = cloudChatsWorkspace.localId;
          const request = {
            workspaceLocalId,
            baseline: new Set(
              snapshot.worktrees
                .filter(
                  (worktree) => worktree.workspaceLocalId === workspaceLocalId,
                )
                .map((worktree) => worktree.localId),
            ),
          };
          setPendingCloudChat(request);
          void Promise.resolve()
            .then(
              async (): Promise<WorktreeCreateResult | void> =>
                onCreateWorktree(workspaceLocalId),
            )
            .then((result) => {
              if (result?.status === 'completed') {
                setPendingCloudChat((previous) =>
                  previous === request
                    ? { ...request, worktreeId: result.worktreeId }
                    : previous,
                );
              }
            })
            .catch((error: unknown) => {
              setPendingCloudChat((previous) =>
                previous === request ? null : previous,
              );
              props.onGroupError?.(workspaceLocalId, error);
            });
        }
      : undefined;
  const chatsOwnerSettings =
    canOpenWorkspaceSettings &&
    !cloudChatsCommandsDisabled &&
    (cloudChatsWorkspace === undefined ||
      cloudChatsCapabilities.workspaceSettings === 'full');
  const selectionActionsFor = (section: 'projects' | 'chats'): ReactNode =>
    bulk.selectionMode === section ? (
      <SidebarSelectionHeaderActions
        projects={section === 'projects'}
        allSelected={bulk.allInSectionSelected(section)}
        onToggleAll={() => bulk.toggleSection(section)}
        onDone={bulk.exitSelection}
      />
    ) : undefined;
  const startSelection = (section: 'projects' | 'chats'): void => {
    if (section === 'projects') {
      setWorkspacesSectionCollapsed(false);
      props.onWorkspacesSectionCollapsedChange?.(false);
    } else if (chatsOwner) {
      props.onChatsSectionCollapsedChange?.(false);
      props.onWorkspaceCollapsedChange?.(chatsOwner.localId, false);
    }
    bulk.enterSection(section);
  };
  const chatsSection =
    chatsOwner && chatsSectionVisible ? (
      <div
        data-testid={testIds?.chatsSection ?? 'portal-chats-section'}
        data-workspace-id={chatsOwner.localId}
        // The rail advertises the state that changes what the header's click
        // means (stuck: back to the rows), as desktop's section did.
        data-sidebar-chats-stuck={chatsStuck ? 'true' : undefined}
        // `contents`: this wrapper must NOT generate a box. A sticky element
        // cannot leave its containing block, so a wrapper that ends where the
        // section ends would drag the Chats header off screen the moment its
        // own rows scrolled past — and the header's whole job in that state is
        // to still be there, as the way back to them. Desktop renders the
        // header and its rows as flat siblings for exactly this reason.
        //
        // The gap above the header therefore belongs to the spacer below
        // rather than to padding here; a host that owns the scroll viewport
        // also owns the sticky group directly above (desktop's pinned More row
        // and its literal 12px gap), so it needs no gap at all.
        // `contents` on both: a wrapper that ends with this section would
        // bound the sticky header inside it, so the header would scroll away
        // exactly when Projects arrives — and the stack would break.
        className="contents"
      >
        {props.scrollOwner === 'host' ? null : (
          // The 4px the boxless wrapper can no longer carry as padding.
          <div aria-hidden="true" className="h-1" />
        )}
        <StandaloneChatsSidebarSection
          key={chatsOwner.localId}
          // `scopedSnapshot`, not `snapshot`: develop narrowed every other
          // consumer to the scoped view while this branch was open, and the
          // Chats section must not be the one place that still lists chats
          // from outside the active scope.
          snapshot={scopedSnapshot}
          workspace={chatsOwner}
          // A tree owner's rows carry their own item groups (below).
          itemGroupCommands={
            cloudChatsWorkspace === undefined &&
            !props.isWorkspaceCommandDisabled?.(chatsOwner.localId) &&
            (props.capabilitiesFor?.(chatsOwner.localId) ?? capabilities)
              .itemGrouping === true
              ? props.itemGroupCommandsFor?.(chatsOwner.localId)
              : undefined
          }
          onCreateInGroup={(groupId) =>
            props.onCreateStandaloneGroupItem?.(chatsOwner.localId, groupId)
          }
          onGroupError={(error) =>
            props.onGroupError?.(chatsOwner.localId, error)
          }
          headerPresentation="section"
          {...standaloneChatArchiveProps(cloudChatsWorkspace !== undefined)}
          workEntryNotifications={workEntryNotifications}
          selectionActions={selectionActionsFor('chats')}
          onEnterSelection={
            (
              cloudChatsWorkspace
                ? worktreeBulk.binding.enabled
                : workEntryBulk.binding.enabled
            )
              ? (): void => startSelection('chats')
              : undefined
          }
          workEntryMultiSelect={workEntryMultiSelectFor(chatsOwner.localId)}
          // Desktop's Chats header carries a settings control; wiring it
          // here gives both hosts the same one. Passed only when the action
          // can actually run — the host either overrides it or supplies the
          // dialog's own data loaders — so a host that cannot open settings
          // renders no control rather than a dead one.
          onOpenSettings={
            chatsOwnerSettings
              ? (): void => openSettings(chatsOwner.localId)
              : undefined
          }
          // A tree owner persists collapse as its project header did; the
          // host's Chats overrides stay keyed to the flat catch-all. Without a
          // persistence handler it collapses locally.
          collapsed={
            cloudChatsWorkspace
              ? props.onWorkspaceCollapsedChange
                ? cloudChatsWorkspace.collapsed === true
                : undefined
              : (props.chatsSectionCollapsed ?? chatsOwner.collapsed === true)
          }
          onCollapsedChange={(collapsed): void => {
            if (!cloudChatsWorkspace && props.onChatsSectionCollapsedChange) {
              props.onChatsSectionCollapsedChange(collapsed);
              return;
            }
            props.onWorkspaceCollapsedChange?.(chatsOwner.localId, collapsed);
          }}
          onStuckChange={setChatsStuck}
          selectedStandaloneChatId={
            selection?.kind === 'standalone-chat'
              ? selection.standaloneChatId
              : null
          }
          touchTargets={touch}
          showActivityAge={props.showChatActivityAge}
          rowStatusPlacement={props.chatsRowStatusPlacement}
          compactDisclosure={props.compactListDisclosures}
          onSelectChat={(standaloneChatId) =>
            onSelect({ kind: 'standalone-chat', standaloneChatId })
          }
          onSelectWorkspace={(): void =>
            onSelect({
              kind: 'workspace',
              workspaceLocalId: chatsOwner.localId,
            })
          }
          testIds={{
            // Host-rendered rows carry the cowork workspace's own id (desktop's
            // legacy row does); giving the section the same id would double it.
            root:
              props.renderChatsSectionRows || cloudChatsWorkspace
                ? `${
                    testIds?.coworkWorkspace?.(chatsOwner.localId) ??
                    `portal-cowork-workspace-${chatsOwner.localId}`
                  }-section`
                : (testIds?.coworkWorkspace?.(chatsOwner.localId) ??
                  `portal-cowork-workspace-${chatsOwner.localId}`),
            sectionToggle:
              testIds?.chatsSectionToggle ?? 'portal-chats-section-toggle',
            sectionSettings:
              testIds?.chatsSectionSettings ?? 'portal-chats-section-settings',
            sectionMenu:
              testIds?.chatsSectionMenu ?? 'portal-chats-section-menu',
            sectionMenuContent:
              testIds?.chatsSectionMenuContent ??
              'portal-chats-section-menu-content',
            sectionShowAll:
              testIds?.chatsSectionShowAll ?? 'portal-chats-section-show-all',
            sectionCreateChat:
              testIds?.chatsSectionCreateChat ??
              'portal-chats-section-new-chat',
            sectionEmpty:
              testIds?.chatsSectionEmpty ?? 'portal-chats-section-empty',
            sectionContent: testIds?.chatsSectionContent,
            chatRow: testIds?.standaloneChatRow,
          }}
          // A tree owner reuses the project worktree rows, headerless, so its
          // menus, groups, status, and reveal behave as they did in Projects.
          renderRows={
            cloudChatsWorkspace
              ? ({ collapsed }): ReactNode =>
                  renderWorkspaceList(
                    [{ ...cloudChatsWorkspace, collapsed }],
                    {
                      hiddenWorkspacesToggle: `${hiddenWorkspacesToggleId}-chats`,
                    },
                    false,
                    false,
                    true,
                  )
              : props.renderChatsSectionRows
          }
          hasSelectedRow={
            cloudChatsWorkspace
              ? selection?.kind === 'worktree' &&
                selection.workspaceLocalId === cloudChatsWorkspace.localId &&
                cloudChatsRows.some(
                  (worktree) => worktree.localId === selection.worktreeLocalId,
                )
              : props.chatsSectionHasSelectedRow
          }
          rowsEmpty={
            cloudChatsWorkspace
              ? cloudChatsRows.length === 0
              : props.chatsSectionEmpty
          }
          // No overflow actions for a tree owner (CAN-3108 owns those); the
          // host's menu and pending flag belong to the flat catch-all.
          renderHeaderMenuItems={
            cloudChatsWorkspace ? undefined : props.renderChatsSectionMenuItems
          }
          headerActionsDisabled={
            cloudChatsWorkspace
              ? pendingCloudChat !== null
              : props.chatsSectionPending === true
          }
          stickyHeader={props.scrollOwner === 'host'}
          // Desktop's cap. Chats sits above the project list, so an uncapped
          // list pushes every project below the fold.
          maxEntries={CHATS_SECTION_VISIBLE_ENTRIES}
          // An organization's empty Chats reads like its empty Projects list;
          // a host that names its own line lists that instead (CAN-2989).
          listsNoneFoundWhenEmpty={
            props.context?.kind === 'organization' ||
            props.chatsSectionEmptyLabel !== undefined
          }
          emptyLabel={props.chatsSectionEmptyLabel}
          // No fallback to `onCreateWorktree`. Creating a chat in this bucket
          // is NOT creating a worktree: the Chats workspace is cowork, and
          // both the desktop adapter and the portal's relay of it reject a
          // worktree create there outright. A host with no chat-creation
          // action supplies nothing and the control does not render — the rule
          // the settings gear already follows.
          onCreateChat={
            cloudChatsWorkspace
              ? createCloudChatsChat
              : props.onCreateChatsSectionChat
          }
        />
      </div>
    ) : null;

  // Desktop's section header vocabulary (slice 6): 32px, product `text-s`,
  // quaternary at rest and secondary on hover, chevron and add-project "+"
  // revealed on hover, no rules. Sticky inside the scroll region so it stays
  // put while the list scrolls beneath it, as desktop's does.
  const canAddWorkspace =
    props.onCreateWorkspace !== undefined ||
    props.onOpenCreateWorkspaceOverride !== undefined;
  const workspacesHeader = (
    <RailSectionHeader
      kind="projects"
      label={WORKSPACE_LABEL_PLURAL}
      touchTargets={touch}
      expanded={!workspacesSectionCollapsed}
      chevronTestId="portal-workspaces-chevron"
      toggleProps={
        props.workspacesSectionCollapsible
          ? {
              'data-onboarding-anchor': 'sidebar-workspaces',
              'data-testid':
                testIds?.workspacesSectionToggle ??
                'portal-workspaces-section-toggle',
              'aria-label': workspacesSectionCollapsed
                ? 'Expand projects'
                : 'Collapse projects',
              onClick: (event): void => {
                const next = !workspacesSectionCollapsed;
                setWorkspacesSectionCollapsed(next);
                props.onWorkspacesSectionCollapsedChange?.(next);
                if (event.detail > 0) event.currentTarget.blur();
              },
            }
          : undefined
      }
      data-testid="portal-workspaces-header"
      data-sidebar-projects-header=""
      data-sidebar-header-resting={workspacesHeaderRest.resting || undefined}
      onPointerEnter={workspacesHeaderRest.onPointerEnter}
      onPointerMove={workspacesHeaderRest.onPointerMove}
      onFocusCapture={workspacesHeaderRest.onFocusCapture}
      onKeyDownCapture={workspacesHeaderRest.onKeyDownCapture}
      resting={workspacesHeaderRest.resting}
      sticky={!props.renderProjectsBand}
      belowChats={props.scrollOwner !== 'host' && chatsSection !== null}
      style={
        props.scrollOwner === 'host'
          ? { paddingRight: RAIL_SECTION_HEADER_PADDING_RIGHT }
          : undefined
      }
      menuOpen={workspacesMenuOpen}
      onMenuOpenChange={setWorkspacesMenuOpen}
      menuTestId={testIds?.workspacesSectionMenu ?? 'portal-workspaces-menu'}
      menuContentTestId={
        testIds?.workspacesSectionMenuContent ??
        'portal-workspaces-menu-content'
      }
      menuFiltered={props.workspacesSectionFiltered}
      actions={selectionActionsFor('projects')}
      renderMenuItems={
        !worktreeBulk.binding.enabled && !workEntryBulk.binding.enabled
          ? props.renderWorkspacesSectionMenuItems
          : (close): ReactNode => (
              <>
                {props.renderWorkspacesSectionMenuItems?.(close)}
                {props.renderWorkspacesSectionMenuItems && (
                  <DropdownMenuDivider />
                )}
                <DropdownMenuItem
                  onClick={() => {
                    close();
                    startSelection('projects');
                  }}
                >
                  <DropdownMenuItemIcon>
                    <ListChecks />
                  </DropdownMenuItemIcon>
                  Select
                </DropdownMenuItem>
              </>
            )
      }
      onCreate={
        canAddWorkspace
          ? (): void => {
              if (props.onOpenCreateWorkspaceOverride?.() === true) return;
              if (props.onCreateWorkspace) setCreateOpen(true);
            }
          : undefined
      }
      createTestId={testIds?.addWorkspace ?? 'portal-add-workspace'}
      createDataAttrs={props.addWorkspaceButtonDataAttrs}
      createRevealed={
        props.addWorkspaceRevealed === true ||
        projectsListEmpty ||
        projectsPartitionEmpty ||
        contentState === 'empty'
      }
    />
  );

  // Without a context header, Search keeps its navigation row or narrow strip
  // seat. Every placement uses the same disclosure, input and results overlay.
  const searchPresentation = sidebarNavItemPresentation(
    <SearchIcon size={16} />,
    'Search',
    chatSearchRevealed,
    touch,
    navStrip,
  );
  const navItems = (
    <>
      {chatSearchInNav && (
        <NavItemTooltip label="Search" compact={navStrip}>
          <button
            ref={chatSearchToggleRef}
            type="button"
            onClick={toggleChatSearch}
            aria-expanded={chatSearchRevealed}
            aria-controls={chatSearchRevealed ? chatSearchInputId : undefined}
            aria-label={searchPresentation.ariaLabel}
            data-testid="portal-sidebar-chat-search-toggle"
            className={searchPresentation.className}
          >
            {searchPresentation.content}
          </button>
        </NavItemTooltip>
      )}
      {navRegions.mainNav.map((key) => (
        <SidebarNavItemRow
          key={key}
          navKey={key}
          action={navActionFor(navItemActions, key)}
          touch={touch}
          compact={navStrip}
          onNavigateHref={props.onNavigateHref}
        />
      ))}
      {props.currentDestination && (
        <SidebarCurrentDestinationRow
          destination={props.currentDestination}
          touch={touch}
          compact={navStrip}
          onNavigateHref={props.onNavigateHref}
        />
      )}
      {commandChrome && navRegions.more.length > 0 && (
        <MoreMenu
          touch={touch}
          compact={navStrip}
          itemKeys={navRegions.more}
          itemActions={navItemActions}
          onNavigateHref={props.onNavigateHref}
        />
      )}
    </>
  );
  const navStripHasItems =
    chatSearchInNav ||
    navRegions.mainNav.length > 0 ||
    props.currentDestination !== undefined ||
    navRegions.more.length > 0;

  // Everything Activity replaces: the Chats section, shared and owned
  // projects, standalone chats, and host trailing rows. Fixed navigation and
  // the search overlay sit outside it.
  const workspaceTree = (
    <>
      {chatsSectionLoading && (
        // Reserve the section before the snapshot supplies its rows and actions.
        <>
          {props.scrollOwner === 'host' ? null : (
            <div aria-hidden="true" className="h-1" />
          )}
          <SidebarChatsSkeleton
            rowStatusPlacement={props.chatsRowStatusPlacement}
          />
          {!props.renderProjectsBand && (
            <div aria-hidden="true" className="h-3" />
          )}
        </>
      )}
      {contentState === 'ready' && chatsSection}
      {contentState === 'ready' &&
        chatsSection &&
        !props.renderProjectsBand && (
          // Desktop leaves 12px between the Chats section and the
          // Projects header; a spacer rather than header padding, so the
          // sticky header keeps its 32px band. A host band carries its
          // own gap.
          <div aria-hidden="true" className="h-3" />
        )}
      {((contentState === 'ready' && sharedSections.length > 0) ||
        props.sharedWithMeNotices) && (
        <section
          data-testid="portal-shared-with-me-section"
          aria-labelledby="portal-shared-with-me-heading"
          className="pb-3"
        >
          <div
            className={`flex items-center px-2 ${touch ? 'min-h-11' : 'h-8'}`}
          >
            <Heading
              level={2}
              variant="sidebar"
              id="portal-shared-with-me-heading"
            >
              {SHARED_WITH_YOU_SECTION_LABEL}
            </Heading>
          </div>
          {props.sharedWithMeNotices}
          {contentState === 'ready' && sharedSections.length > 0 && (
            <Stack gap="tight">
              {renderWorkspaceList(
                sharedSections,
                {
                  root: 'portal-shared-with-me-list',
                  hiddenWorkspacesToggle: 'portal-shared-with-me-hidden-toggle',
                },
                true,
              )}
            </Stack>
          )}
        </section>
      )}
      {/* A host rail seats the header inside its own sticky band, HERE
          in the flow after the Chats section — the legacy section's
          shape, which the rail's seat geometry (the band's height, the
          workspace-header seat it publishes, the row clip) assumes. A
          header left below the band read as "external" and seated one
          header-height under the line every consumer measures against. */}
      {props.renderProjectsBand
        ? props.renderProjectsBand(workspacesHeader)
        : workspacesHeader}
      {/* The Projects list, addressable apart from the rail (desktop:
            `sidebar-section-code`). `contents`: no box, so the sticky header
            above keeps the scroller as its parent. */}
      <div className="contents" data-testid={testIds?.workspacesSection}>
        {props.workspacesSectionCollapsible &&
        workspacesSectionCollapsed ? null : contentState ===
          'waiting' ? null : contentState === 'loading' ? (
          <SidebarProjectsSkeleton
            testId={testIds?.loading}
            rowStatusPlacement={props.chatsRowStatusPlacement}
          />
        ) : contentState === 'empty' &&
          (props.pendingProjects?.length ?? 0) === 0 ? (
          <div className="px-2">
            <EmptyStateRow testId={testIds?.empty} title="Nothing here yet." />
          </div>
        ) : (
          <div
            // The host rail's sticky band is TRANSPARENT (the macOS
            // translucent sidebar has no opaque surface to hide behind),
            // so rows are occluded by a scroll-driven `clip-path` rather
            // than by paint order. Without this the band's z-index is
            // irrelevant and every row shows straight through it.
            //
            // The mark is how the rail finds this container to write the
            // clip geometry onto; the class is the animation that consumes
            // it. Host-only because both live in the desktop renderer's
            // stylesheet — the portal has an opaque sidebar and needs
            // neither.
            className={
              props.scrollOwner === 'host'
                ? 'sidebar-workspaces-rows-clip flex flex-col gap-1 pb-1'
                : 'flex flex-col gap-1'
            }
            {...(props.scrollOwner === 'host'
              ? { 'data-sidebar-workspaces-rows': '' }
              : {})}
          >
            {renderWorkspaceList(
              ownedSections,
              {
                root: testIds?.workspaceList,
                hiddenWorkspacesToggle: hiddenWorkspacesToggleId,
              },
              false,
              chatsOwner !== undefined,
            )}
            {/* The global standalone block is the fallback for hosts with
              no flat-layout project to own those chats. A cloud
              project is repoless but tree-shaped and owns none of
              them, so it must not suppress this block (REG-2819). */}
            {showStandaloneChats && (
              <StandaloneChatsSidebarSection
                snapshot={scopedSnapshot}
                {...standaloneChatArchiveProps(false)}
                selectedStandaloneChatId={
                  selection?.kind === 'standalone-chat'
                    ? selection.standaloneChatId
                    : null
                }
                touchTargets={touch}
                onSelectChat={(standaloneChatId) =>
                  onSelect({ kind: 'standalone-chat', standaloneChatId })
                }
                testIds={{
                  root:
                    testIds?.standaloneChatList ??
                    'portal-standalone-chat-list',
                  folderToggle:
                    testIds?.standaloneChatFolderToggle ??
                    'portal-default-folder-toggle',
                  chatRow: testIds?.standaloneChatRow,
                }}
              />
            )}
          </div>
        )}
        {props.workspacesSectionCollapsible && props.additionalRows}
      </div>
      {props.trailingSections}
      {props.listFooter}
    </>
  );

  const headerSearchButton = (
    <TitlebarIconButton
      ref={chatSearchToggleRef}
      icon={SearchIcon}
      onClick={toggleChatSearch}
      aria-label="Search chats"
      aria-expanded={chatSearchRevealed}
      aria-controls={chatSearchRevealed ? chatSearchInputId : undefined}
      data-testid="portal-sidebar-chat-search-toggle"
      holdHoverWhenExpanded
    />
  );
  const footerCallout = (
    <div
      data-testid="sidebar-footer-callout"
      className="relative flex shrink-0 flex-col gap-2 px-1.5 pb-1.5 pt-2 empty:hidden"
    >
      <SidebarAutoDeleteNotice />
      {bulk.notice}
      {props.footerCallout}
    </div>
  );

  const selectionToolbar = (
    <div className="pointer-events-none absolute inset-x-2 bottom-2 z-sticky">
      <SidebarSelectionToolbar
        count={chatSearchActive ? 0 : bulk.selectionCount}
        items={bulk.toolbarItems}
        onCancel={bulk.exitSelection}
      />
    </div>
  );
  return (
    <>
      <SidebarChrome
        variant={variant}
        width="full"
        density={touch ? 'touch' : 'default'}
        // Nested in a host rail, this frame must not clip: `overflow: hidden`
        // would become the sticky scrollport for the section headers inside.
        scroll={props.scrollOwner === 'host' ? 'none' : 'host'}
        fullHeight={false}
        surface="sidebar"
        split={!fillsParent}
        className={className}
        style={style}
        data-testid={testIds?.root}
      >
        {(props.headerSlot || activityToggleInHeader) && (
          <div
            data-testid="portal-sidebar-header"
            className="relative flex h-11 shrink-0 items-center gap-2 px-3"
          >
            <div className="flex min-w-0 flex-1 items-center">
              {props.headerSlot}
            </div>
            {chatSearchInHeader && headerSearchButton}
            {activityToggleInHeader && (
              <SidebarActivityModeToggle
                host={activityHost}
                capabilities={capabilities}
              />
            )}
          </div>
        )}
        {props.contextRowSlot &&
          (activityToggleInContextRow || chatSearchInContextRow ? (
            <SidebarContextHeader
              testId="portal-sidebar-context-row"
              action={
                <>
                  {activityToggleInContextRow && (
                    <SidebarActivityModeToggle
                      host={activityHost}
                      capabilities={capabilities}
                    />
                  )}
                  {chatSearchInContextRow && headerSearchButton}
                </>
              }
            >
              {props.contextRowSlot}
            </SidebarContextHeader>
          ) : (
            <div
              data-testid="portal-sidebar-context-row"
              className="relative flex shrink-0 px-2 pt-2"
            >
              {props.contextRowSlot}
            </div>
          ))}
        {/*
          With unserved nav keys dropped from both regions, this wrapper can
          come out completely empty (no rows, no More) under navigation-only
          chrome — `commandChrome` always renders New Task, if only disabled.
          Skip it rather than render bare padding.
        */}
        {(commandChrome ||
          chatSearchInNav ||
          navRegions.mainNav.length > 0 ||
          props.currentDestination) && (
          <div
            ref={navBlockRef}
            data-testid="portal-sidebar-menu-block"
            onFocusCapture={(event): void => {
              if (event.target instanceof HTMLElement) {
                focusedNavRef.current = event.target;
              }
            }}
            // Desktop's fixed nav block: 1px between rows, 8px sides and top.
            className="relative flex shrink-0 flex-col gap-px px-2 pb-1 pt-2"
          >
            {commandChrome && (
              <Tooltip
                label={props.createTaskTooltip}
                disabled={props.createTaskTooltip === undefined}
                className="w-full"
              >
                <SidebarNavRow
                  onClick={props.onCreateTask}
                  disabled={!props.onCreateTask}
                  data-testid="portal-create-task"
                  aria-current={props.createTaskActive ? 'page' : undefined}
                  data-selected={props.createTaskActive || undefined}
                  // Desktop's `SidebarNavRow`: the same row vocabulary as every
                  // nav row beneath it, selected while the Home page shows.
                  selected={props.createTaskActive === true}
                  touchTarget={touch ? 'always' : 'none'}
                  icon={<EditBigIcon size={16} />}
                >
                  New task
                </SidebarNavRow>
              </Tooltip>
            )}
            <div
              data-testid={
                navStrip && navStripHasItems
                  ? 'portal-sidebar-nav-strip'
                  : undefined
              }
              // Below the breakpoint: one row of 44px icon buttons under New
              // task, so the nav block stays two rows tall in a phone drawer.
              // Above it the wrapper draws no box and the rows stack as
              // before. It is always mounted, so crossing the breakpoint keeps
              // More (and its open menu) instead of remounting it.
              className={
                navStrip && navStripHasItems
                  ? 'flex min-w-0 items-center gap-1'
                  : 'contents'
              }
            >
              {navItems}
            </div>
          </div>
        )}
        {props.chatSearch && chatSearchVisible && (
          <Surface variant="section" boundary="bottom" className="shrink-0">
            <div className="relative flex shrink-0 items-center gap-1.5 px-2.5 py-1.5">
              <SearchField
                id={chatSearchInputId}
                className="min-w-0 flex-1"
                clearLabel="Clear chat search"
                clearTestId="portal-sidebar-chat-search-clear"
                // Escape is handled below: clear first, then collapse.
                clearOnEscape={false}
                ref={chatSearchInputRef}
                // Revealing a disclosure that the user cannot then type into is
                // a dead click; focus follows the reveal, never the row default.
                autoFocus={chatSearchDisclosed}
                value={chatSearchQuery}
                onValueChange={setChatSearchQuery}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  // Clear first, collapse second: Escape on a typed query means
                  // "undo the query", and only an already-empty one means
                  // "put the affordance away".
                  if (chatSearchQuery.length > 0) {
                    event.stopPropagation();
                    setChatSearchQuery('');
                    return;
                  }
                  if (chatSearchDisclosed) {
                    event.stopPropagation();
                    collapseChatSearch();
                    chatSearchToggleRef.current?.focus();
                  }
                }}
                placeholder="Search chats"
                aria-label="Search chats"
                data-testid="portal-sidebar-chat-search-input"
              />
            </div>
          </Surface>
        )}
        <div className="relative min-h-0 flex-1">
          {chatSearchActive && props.chatSearch && (
            <div
              data-testid="portal-sidebar-chat-search-results"
              className="absolute inset-0 z-10 overflow-y-auto overflow-x-hidden overscroll-contain bg-sidebar px-2 py-2"
            >
              {props.chatSearch.hydrating === true && (
                <p
                  data-testid="portal-sidebar-chat-search-syncing"
                  role="status"
                  className="px-3 py-1 text-xs fg-secondary"
                >
                  Syncing chats…
                </p>
              )}
              {chatSearchResults.length === 0 ? (
                <p
                  data-testid="portal-sidebar-chat-search-empty"
                  className="px-3 py-2 text-s fg-secondary"
                >
                  No chats match &ldquo;{chatSearchQuery.trim()}&rdquo;.
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {chatSearchResults.map((result) => (
                    <li key={`${result.kind}-${result.chatId}`}>
                      <button
                        type="button"
                        onClick={() => props.chatSearch?.onSelectResult(result)}
                        data-testid={`portal-sidebar-chat-search-result-${result.chatId}`}
                        className={`focus-ring flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-1.5 text-left hover:bg-subtle ${touch ? 'min-h-11 justify-center' : ''}`}
                      >
                        <span
                          className={`${REPLAY_MASK_CLASS} w-full truncate text-s fg-primary`}
                        >
                          {result.title}
                        </span>
                        <span
                          className={`${REPLAY_MASK_CLASS} w-full truncate text-xs fg-secondary`}
                        >
                          {result.kind === 'worktree-chat'
                            ? `${result.workspaceName} · ${result.worktreeName}`
                            : result.workspaceName}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div
            ref={scrollViewportRef}
            data-testid={testIds?.scroll}
            // Marks the scrolling viewport when this surface owns it, so the
            // shared geometry helpers can find it without the desktop rail's
            // test id. Omitted under a host rail, whose own viewport is the
            // real scroller — marking this non-scrolling box would shadow it.
            {...(props.scrollOwner === 'host'
              ? {}
              : { [SIDEBAR_VIEWPORT_ATTR]: '' })}
            // The grouped tree stays mounted under the results overlay so
            // scroll position survives a search, but its visually covered
            // controls must not stay reachable by keyboard or assistive
            // tech while the overlay is up.
            inert={chatSearchActive}
            aria-hidden={chatSearchActive || undefined}
            // `isolate`: the sticky Projects header inside carries `z-10`,
            // and so does the sibling search-results overlay above. Without
            // its own stacking context the header (later in DOM order) would
            // paint over the overlay's first rows.
            className={
              props.scrollOwner === 'host'
                ? // Deliberately bare. `isolate` would make this whole subtree
                  // one stacking context painted in DOM order — after the host
                  // rail's sticky More/Projects band, which is a sibling BEFORE
                  // it — so every scrolling row would paint straight over that
                  // band no matter what z-index the band carried. `relative`
                  // would likewise re-base `offsetTop` for anything measuring
                  // against the viewport.
                  undefined
                : 'relative isolate h-full overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-2'
            }
          >
            {activityAttached ? (
              <SidebarActivityModeSwitch
                host={activityHost}
                capabilities={capabilities}
                touch={touch}
                tree={workspaceTree}
                liveSnapshot={scopedSnapshot ?? undefined}
                onModeChange={resetActivityScroll}
              />
            ) : (
              workspaceTree
            )}
          </div>
          {footerCalloutHost === null
            ? selectionToolbar
            : createPortal(
                <div className="relative">{selectionToolbar}</div>,
                footerCalloutHost,
              )}
        </div>
        {slotContainer !== null &&
          createPortal(
            // One seat per listed workspace, marked with its id. The rail's
            // band creates the container; only the list knows which
            // workspaces exist, so the rows belong here. Empty and hidden
            // until a section portals its header copy in.
            ownedSections.map((workspace) => (
              <div
                key={workspace.localId}
                aria-hidden="true"
                className="pointer-events-auto absolute inset-0"
                data-sidebar-sticky-slot-workspace-id={workspace.localId}
                hidden
              />
            )),
            slotContainer,
          )}
        {ownsScroll && (
          // Projects, pinned to the foot of the rail while the real header is
          // below the fold — which an expanded chat list makes the normal case.
          // Sticky cannot do this: it never lifts an element above its own
          // place in the flow, and Chats is a top-level sibling of Projects.
          //
          // OUTSIDE the scroll viewport on purpose, as the desktop rail does
          // it. Floating it over the viewport means masking the rows passing
          // underneath, and that mask is re-rasterised over a multi-thousand
          // pixel layer every scroll frame. Out here nothing renders behind it.
          <button
            ref={projectsPinRef}
            type="button"
            hidden
            data-sidebar-projects-pin-bottom=""
            data-testid="portal-projects-pin-bottom"
            // The visible word is the section's name, which alone reads as a
            // destination; the accessible name says what activating it does.
            aria-label={`Back to ${WORKSPACE_LABEL_PLURAL}`}
            className="flex shrink-0 items-center gap-1 px-4 py-1.5 text-left text-s font-normal fg-quaternary transition-colors hover:fg-secondary"
            onClick={(): void => {
              const viewport = scrollViewportRef.current;
              const header = viewport?.querySelector<HTMLElement>(
                PROJECTS_HEADER_SELECTOR,
              );
              if (!viewport || !header) return;
              viewport.scrollTo({
                top:
                  viewport.scrollTop +
                  header.getBoundingClientRect().top -
                  viewport.getBoundingClientRect().top,
                behavior: prefersReducedMotion() ? 'auto' : 'smooth',
              });
            }}
          >
            <span className="truncate">{WORKSPACE_LABEL_PLURAL}</span>
            <ChevronDownMediumIcon size="sm" className="shrink-0" aria-hidden />
          </button>
        )}
        {footerCallout !== null &&
          (footerCalloutHost === null
            ? footerCallout
            : createPortal(footerCallout, footerCalloutHost))}
        {props.footer && (
          // The status strip's rule separates it from the SCROLLING list. A
          // callout already stands between the two as its own bounded object,
          // so the rule would be a second divider inside one small block of
          // chrome — three lines in as many rows, which is what the card was
          // supposed to make the sidebar quieter than.
          <div
            data-testid="portal-sidebar-footer"
            // Desktop's `SidebarAccountFooter` framing: 8px sides and bottom,
            // 8px above the row, full-width rule.
            className={`relative flex shrink-0 items-center px-2 pb-2 pt-2${
              props.footerCallout || bulk.notice !== null ? '' : ' border-t'
            }`}
          >
            {props.footer}
          </div>
        )}
      </SidebarChrome>
      {createOpen && props.onCreateWorkspace && (
        <CreateWorkspaceDialog
          mode="remote-clone"
          onCreate={props.onCreateWorkspace}
          onClose={() => setCreateOpen(false)}
          testIds={{
            dialog:
              testIds?.createWorkspaceDialog ??
              'portal-create-workspace-dialog',
            remoteUrl: 'portal-create-workspace-remote-url',
            submit: 'portal-create-workspace-submit',
            error: 'portal-create-workspace-error',
          }}
        />
      )}
      {/* Same guard, same reason as the worktree confirm below: this one
       * awaits `onDeleteWorkspace` optionally and then clears itself, so an
       * absent handler reads as a completed removal. */}
      {pendingWorkspaceRemoval && props.onDeleteWorkspace && (
        <ConfirmDialog
          title={
            <>
              {pendingWorkspaceRemoval.presentation === 'archive'
                ? 'Archive'
                : 'Delete'}{' '}
              project “
              <span className={REPLAY_MASK_CLASS}>
                {pendingWorkspaceRemoval.name}
              </span>
              ”?
            </>
          }
          message={
            pendingWorkspaceRemoval.presentation === 'archive'
              ? 'It stops appearing in the sidebar and its work is kept on the server.'
              : 'Its work is removed. This can’t be undone.'
          }
          errorMessage={pendingWorkspaceRemoval.error}
          busy={pendingWorkspaceRemoval.busy}
          busyLabel={
            pendingWorkspaceRemoval.presentation === 'archive'
              ? 'Archiving…'
              : 'Deleting…'
          }
          confirmLabel={
            pendingWorkspaceRemoval.presentation === 'archive'
              ? 'Archive project'
              : 'Delete project'
          }
          destructive={pendingWorkspaceRemoval.presentation === 'delete'}
          dataTestId={
            testIds?.workspaceRemovalConfirm ??
            'portal-remove-workspace-confirm'
          }
          // A rejected removal keeps the dialog open and shows why, so a
          // failure is distinguishable from a slow success and can be retried.
          onConfirm={() => {
            const pending = pendingWorkspaceRemoval;
            const generation = ownerGeneration;
            setPendingWorkspaceRemoval({
              ...pending,
              busy: true,
              error: null,
            });
            void (async (): Promise<void> => {
              try {
                await props.onDeleteWorkspace?.(pending.workspaceId);
                // The owner that issued this is gone; the dialog went with it
                // and must not be revived from here.
                if (generationRef.current !== generation) return;
                setPendingWorkspaceRemoval(null);
              } catch (error) {
                offerLifecycleJournalQuarantine(error);
                if (generationRef.current !== generation) return;
                const message =
                  error instanceof Error && error.message
                    ? error.message
                    : `Could not ${pending.presentation} this project.`;
                setPendingWorkspaceRemoval({
                  ...pending,
                  busy: false,
                  error: message,
                });
                offerDeletionDiscard(pending, message, generation, () => {
                  if (generationRef.current === generation)
                    setPendingWorkspaceRemoval(null);
                });
              }
            })();
          }}
          onCancel={() => setPendingWorkspaceRemoval(null)}
        />
      )}
      {/* Handler presence is re-checked at render, not only when the owner
       * changes: a confirm that calls an absent `onArchiveWorktree` closes
       * the dialog anyway, so it would report a removal that never ran. The
       * settings dialog below has always been guarded this way. */}
      {pendingDelete && props.onArchiveWorktree && (
        <ConfirmDialog
          {...worktreeRemovalConfirmCopy(
            pendingDelete,
            pendingRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS,
            remoteRetentionWindow,
          )}
          destructive={
            (pendingDelete.mode ?? pendingDelete.presentation) === 'delete'
          }
          dataTestId={worktreeTestIdsFor(
            pendingDelete.workspaceId,
            pendingDelete.worktreeId,
          )(testIds?.worktreeRemovalConfirm, 'portal-delete-worktree-confirm')}
          onConfirm={() => {
            props.onArchiveWorktree?.(
              pendingDelete.workspaceId,
              pendingDelete.worktreeId,
              ...(pendingDelete.mode ? [pendingDelete.mode] : []),
            );
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {bulk.dialog}
      {settingsDialog &&
        settingsWorkspace &&
        (settingsDialog.detailsOnly === true ||
          (props.onSaveClaudeMd && props.onSaveScripts)) &&
        props.onUpdateWorkspace && (
          <DeferredWorkspaceSettingsDialog
            workspaceName={settingsWorkspace.name}
            initialTab={settingsDialog.initialTab}
            initialValues={{
              name: settingsWorkspace.name,
              color: settingsWorkspace.color,
              content: settingsDialog.content,
              scripts: settingsDialog.scripts,
            }}
            tabs={
              settingsDialog.detailsOnly === true
                ? ['details', 'danger']
                : ['details', 'claude-md', 'scripts', 'danger']
            }
            tabLabels={{ 'claude-md': 'Instructions' }}
            {...(props.workspaceDangerCopy === undefined
              ? {}
              : {
                  dangerCopy: props.workspaceDangerCopy(
                    settingsWorkspace.localId,
                  ),
                })}
            extraTabs={
              settingsDialog.detailsOnly !== true &&
              (props.renderWorkspaceRepositoriesAccessory ||
                settingsWorkspace.type === 'multi-repo') &&
              settingsWorkspace.owner?.type === 'organization'
                ? [
                    {
                      id: 'repositories',
                      label: 'Repositories',
                      content:
                        settingsWorkspace.type === 'multi-repo' ? (
                          <Stack aria-label="Repositories" as="ul" gap="inline">
                            {settingsWorkspace.repos?.map((repo) => (
                              <li key={repo.id} className="text-s fg-primary">
                                {repo.name}
                              </li>
                            ))}
                          </Stack>
                        ) : (
                          props.renderWorkspaceRepositoriesAccessory?.(
                            settingsWorkspace.localId,
                            () => setSettingsDialog(null),
                            async (id): Promise<void> => {
                              for (
                                let attempt = 0;
                                attempt < 100;
                                attempt += 1
                              ) {
                                if (generationRef.current !== ownerGeneration)
                                  throw new Error('The settings owner changed');
                                const current = openSettingsRef.current;
                                if (
                                  current.snapshot.workspaces.some(
                                    (item) => item.localId === id,
                                  )
                                ) {
                                  current.open(id, 'repositories');
                                  return;
                                }
                                await new Promise<void>((resolve) =>
                                  setTimeout(resolve, 100),
                                );
                              }
                              throw new Error(
                                'The destination has not reached the sidebar',
                              );
                            },
                          )
                        ),
                    },
                  ]
                : undefined
            }
            scriptsAccessory={props.renderWorkspaceScriptsAccessory?.(
              settingsWorkspace.localId,
            )}
            claudeMdCopy={{
              title: 'Instructions',
              description:
                'Shared instructions for agents working in this project.',
              placeholder:
                'Add instructions for agents working in this project',
            }}
            onDelete={
              props.onDeleteWorkspace &&
              // The danger tab now asks the capability rather than inferring
              // removal from handler presence alone.
              workspaceRemovalOf(settingsWorkspace.localId) !== false &&
              props.isWorkspaceCommandDisabled?.(settingsWorkspace.localId) !==
                true
                ? async (): Promise<void> => {
                    const generation = ownerGeneration;
                    try {
                      await props.onDeleteWorkspace?.(
                        settingsWorkspace.localId,
                      );
                    } catch (error) {
                      offerLifecycleJournalQuarantine(error);
                      offerDeletionDiscard(
                        {
                          workspaceId: settingsWorkspace.localId,
                          name: settingsWorkspace.name,
                          presentation: 'delete',
                        },
                        error instanceof Error && error.message
                          ? error.message
                          : 'Could not delete this project.',
                        generation,
                        () => {
                          if (generationRef.current === generation)
                            setSettingsDialog(null);
                        },
                      );
                      throw error;
                    }
                  }
                : undefined
            }
            onSave={async ({ name, color, content, scripts }) => {
              const workspace = settingsWorkspace;
              // Same generation guard as the removal below: the owner-change
              // reset drops the optimistic metadata, and a save that was
              // already awaiting its command would otherwise write it back
              // under an owner that never issued it.
              const generation = ownerGeneration;
              const patch: { name?: string; color?: string } = {};
              if (name !== workspace.name) patch.name = name;
              if (color !== undefined && color !== workspace.color)
                patch.color = color;
              if (patch.name !== undefined || patch.color !== undefined) {
                const requestSnapshotVersion =
                  currentWorkspaceSnapshot.current.version;
                await props.onUpdateWorkspace?.(workspace.localId, patch);
                if (generationRef.current !== generation) return;
                const authoritativeSnapshot = currentWorkspaceSnapshot.current;
                const liveAfterRequest = authoritativeSnapshot.workspaces.find(
                  (item) => item.localId === workspace.localId,
                );
                setPendingWorkspaceMetadata((current) => {
                  const pending = {
                    ...current[workspace.localId],
                  };
                  if (patch.name !== undefined) {
                    const alreadyReconciled =
                      authoritativeSnapshot.version !==
                        requestSnapshotVersion &&
                      liveAfterRequest !== undefined &&
                      (liveAfterRequest.name === patch.name ||
                        liveAfterRequest.name !== workspace.name);
                    if (alreadyReconciled) delete pending.name;
                    else {
                      pending.name = {
                        value: patch.name,
                        before: workspace.name,
                        // Capture after the command returns. A workspace
                        // snapshot applied while the request was in flight is
                        // already reflected above and must not be mistaken for
                        // a later acknowledgement.
                        afterSnapshotVersion: authoritativeSnapshot.version,
                      };
                    }
                  }
                  if (patch.color !== undefined) {
                    const alreadyReconciled =
                      authoritativeSnapshot.version !==
                        requestSnapshotVersion &&
                      liveAfterRequest !== undefined &&
                      (liveAfterRequest.color === patch.color ||
                        liveAfterRequest.color !== workspace.color);
                    if (alreadyReconciled) delete pending.color;
                    else {
                      pending.color = {
                        value: patch.color,
                        before: workspace.color,
                        afterSnapshotVersion: authoritativeSnapshot.version,
                      };
                    }
                  }
                  const next = { ...current };
                  if (pending.name || pending.color)
                    next[workspace.localId] = pending;
                  else delete next[workspace.localId];
                  return next;
                });
                setSettingsDialog((current) =>
                  current?.workspace.localId === workspace.localId
                    ? {
                        ...current,
                        workspace: { ...workspace, ...patch },
                      }
                    : current,
                );
              }
              if (content !== settingsDialog.content) {
                await props.onSaveClaudeMd?.(workspace.localId, content);
                if (generationRef.current !== generation) return;
                setSettingsDialog((current) =>
                  current?.workspace.localId === workspace.localId
                    ? { ...current, content }
                    : current,
                );
              }
              const normalizedScripts = scriptsForSave(
                settingsDialog.scripts,
                scripts,
              );
              if (normalizedScripts)
                await props.onSaveScripts?.(
                  workspace.localId,
                  normalizedScripts,
                );
            }}
            onClose={() => setSettingsDialog(null)}
            testIds={{
              dialog: 'portal-workspace-settings-dialog',
              nameInput: 'portal-workspace-name-input',
              colorSwatches: 'portal-workspace-color-swatches',
              claudeMdTextarea: 'portal-workspace-claude-md-textarea',
              scriptInput: (key) => `portal-workspace-script-${key}`,
              danger: 'portal-workspace-settings-danger',
              error: 'portal-workspace-settings-error',
              save: 'portal-workspace-settings-save',
            }}
          />
        )}
    </>
  );
}
