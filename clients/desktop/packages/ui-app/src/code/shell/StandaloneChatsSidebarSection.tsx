'use client';

import { useSidebarAutoDelete } from './SidebarAutoDelete';

import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  CHAT_UNIT_LABEL_PLURAL,
  CLOUD_FIRST_WORKSPACE_NAME,
  isDefaultCoworkWorkspaceName,
} from '@canopy/protocol/ui-labels';
import type { PortalStandaloneWorkEntryFields } from '@canopy/protocol';
import {
  Dot,
  RailSectionHeader,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuDivider,
  SidebarMoreRow,
  SidebarToggleRow,
  StandaloneChatRow,
  WorkEntryRow,
  WorktreeActionMenuItems,
  ThinkingSpinner,
  type WorktreeMenuItem,
  WorkEntryRowMenuItems,
  WorkspaceSectionHeader,
  isSpaceNotificationMuted,
  type SpaceNotificationMenuChoice,
  type SpaceNotificationMenuState,
  type WorkEntryRowMenuContext,
} from '@canopy/ui-shared/components';
import { ListChecks } from '@canopy/ui-shared/icons/AppIcons';
import {
  CHATS_HEADER_SELECTOR,
  CHATS_HEADER_STUCK_ATTR,
  CHATS_ROW_ATTR,
  ChatsSelectedPinSeat,
  groupStandaloneChatsIntoWorkEntries,
  RAIL_SECTION_HEADER_PADDING_RIGHT,
  revealOccludedChats,
  SidebarList,
  SidebarNoneFoundRow,
  SidebarRowFrame,
  type SidebarSortMode,
  type StandaloneWorkEntryRow,
} from './sidebar';
import type { AgentExecutionHarness } from '@canopy/protocol/models';
import type {
  PortalRowBackend,
  PortalWorkspaceLayout,
} from '@canopy/protocol/portal';
import { withSelectionGroupItems } from './sidebar-selection-menu-items';
import { compareWorkspaces } from './workspace-sections-model';
import { workspaceLayout } from './worktree-status';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import { WorktreeSortableStateContext } from './sortable-state-context';
import {
  CodeSidebarItemGroups,
  type CodeSidebarItemGroupCommands,
} from './sidebar/CodeSidebarItemGroups';
import {
  buildSidebarItemGroupBlocks,
  capSidebarItemGroupBlocks,
} from './sidebar/sidebar-item-groups-model';
import { workEntryRecencyMs } from './sidebar/sidebar-ordering';
import { useSidebarHeaderRest } from '@canopy/ui-shared/lib';
import {
  SidebarSelectionRowsReporter,
  workEntryRowKey,
  workEntryRowMultiSelectProps,
  type WorkEntryMultiSelectBinding,
} from './sidebar/use-sidebar-work-entry-bulk';
import type { SidebarSelectionRow } from './sidebar/sidebar-row-selection';

export interface StandaloneChatsSidebarWorkspace {
  readonly localId?: string;
  readonly name: string;
  readonly order?: number;
  /**
   * Optional because older browser projections predate the required protocol
   * discriminator.
   */
  readonly type?: 'single-repo' | 'multi-repo' | 'cowork';
  /** Placement axis — only a flat workspace can own unparented chats. */
  readonly layout?: PortalWorkspaceLayout;
  /** Execution owner, used to resolve older snapshots without a sort mode. */
  readonly backend?: PortalRowBackend;
  /** Explicit ordering mode for the workspace's Work Entry rows. */
  readonly itemSortMode?: SidebarSortMode;
  readonly itemGroups?: readonly SidebarItemGroup[];
  /** The automatic default cloud workspace; see the protocol's `chatsHome`. */
  readonly chatsHome?: true;
}

/**
 * One flat chat as the sidebar reads it. The Work Entry fields
 * ({@link PortalStandaloneWorkEntryFields}) let the Chats section group chats
 * into the Work Entries desktop lists; all are optional, so a projection from
 * an older desktop still renders each chat as its own entry.
 */
export interface StandaloneChatsSidebarChat extends PortalStandaloneWorkEntryFields {
  readonly localId: string;
  /**
   * The owning cowork workspace. Places the chat in its workspace's section,
   * and keys its Work Entry in the Chats section's grouping.
   */
  readonly projectLocalId?: string;
  readonly title: string;
  /**
   * The owning Work Entry's title, which desktop's Chats row shows: the
   * rename, else the primary chat's generated description, else its title
   * (`New Chat` while empty). Preferred over {@link title} so the same chat
   * reads the same on both platforms (CAN-3108).
   */
  readonly workEntryTitle?: string;
  /**
   * Projected model display string. Deliberately NOT rendered on the cowork
   * sidebar row: the desktop work-entry row shows a title plus an agent-response
   * preview, never the model (CAN-2515). Kept on the type because the projection
   * supplies it and other cowork surfaces (the composer chip) read it.
   */
  readonly modelLabel?: string;
  readonly providerType?: AgentExecutionHarness;
  readonly archived?: boolean;
  /**
   * The chat has a turn in flight. Drives the Chats section's working
   * spinner; the folder rows do not show it yet.
   */
  readonly hasActiveChat?: boolean;
  /**
   * The chat's background tasks (D11). Drives the Chats section's background
   * spinner while no turn runs (turn-state phase 41b).
   */
  readonly backgroundTasks?: number;
  /**
   * The chat has output the user has not viewed. Drives the Chats section's
   * unread dot; the folder rows do not show it yet.
   */
  readonly hasUnread?: boolean;
  /** ISO-8601 time of the chat's latest message: its row's recency. */
  readonly lastMessageAt?: string;
  /** ISO-8601 chat creation time: the recency floor for a chat without one. */
  readonly createdAt?: string;
}

export interface StandaloneChatsSidebarSnapshot {
  readonly workspaces: readonly StandaloneChatsSidebarWorkspace[];
  readonly standaloneChats: readonly StandaloneChatsSidebarChat[];
}

export interface StandaloneChatsSidebarSectionTestIds {
  readonly root?: string;
  readonly folderToggle?: string;
  /** The `'section'` header's toggle; falls back to {@link folderToggle}. */
  readonly sectionToggle?: string;
  readonly sectionSettings?: string;
  readonly sectionMenu?: string;
  readonly sectionMenuContent?: string;
  readonly sectionShowAll?: string;
  readonly sectionCreateChat?: string;
  /** The `None found` row an empty section lists; its label adds `-label`. */
  readonly sectionEmpty?: string;
  /** The rows container; hosts whose automation measures it map an id. */
  readonly sectionContent?: string;
  readonly chatRow?: (chatLocalId: string) => string;
  /**
   * Base id of a Chats-section Work Entry row; the row suffixes its parts
   * (`-thinking`, `-unread`, `-done`). Defaults to
   * `portal-chats-work-entry-${entryId}`.
   */
  readonly workEntryRow?: (entryId: string) => string;
}

/** What host-rendered Chats rows are asked to draw. */
export interface StandaloneChatsSidebarRowsState {
  /**
   * The section is collapsed: draw only the selected chat's row, as a
   * collapsed project keeps only its selected row.
   */
  readonly collapsed: boolean;
  /**
   * The bulk selection for Work Entry rows (CAN-3975); absent where the host
   * wired no Work Entry removal, so its rows select nothing.
   */
  readonly workEntryMultiSelect?: WorkEntryMultiSelectBinding;
}

/**
 * Per-space notification choices for Work Entry rows (CAN-3615). A Work
 * Entry occupies the worktree slot of its Cowork workspace, so the host
 * answers with the same lookups it uses for worktree rows.
 */
export interface WorkEntryNotificationHandlers {
  /** `undefined` when the host cannot identify the entry's space. */
  readonly getState: (
    workspaceLocalId: string,
    workEntryId: string,
  ) => SpaceNotificationMenuState | undefined;
  /** The entry's menu opened: the host refreshes the saved choice. */
  readonly onOpen: (workspaceLocalId: string, workEntryId: string) => void;
  readonly onSelect: (
    workspaceLocalId: string,
    workEntryId: string,
    choice: SpaceNotificationMenuChoice,
  ) => void;
}

/**
 * A muted Work Entry hides its unread dot, on its row and in its group's
 * rollup (CAN-4378). The chats keep their unread state.
 */
function isWorkEntrySpaceMuted(
  notifications: WorkEntryNotificationHandlers | undefined,
  row: {
    readonly workEntryId: string;
    readonly targetChat: { readonly projectLocalId: string };
  },
): boolean {
  return isSpaceNotificationMuted(
    notifications?.getState(row.targetChat.projectLocalId, row.workEntryId),
  );
}

export interface StandaloneChatsSidebarSectionProps {
  readonly itemGroupCommands?: CodeSidebarItemGroupCommands;
  /**
   * The bulk selection for Work Entry rows (CAN-3975). The section reports
   * the rows it renders and forwards this to host rows through `renderRows`.
   */
  readonly workEntryMultiSelect?: WorkEntryMultiSelectBinding;
  readonly onCreateInGroup?: (groupId: string) => void;
  readonly onGroupError?: (error: unknown) => void;
  readonly snapshot: StandaloneChatsSidebarSnapshot;
  /** Adds a notification-only menu to Work Entry rows when supplied. */
  readonly workEntryNotifications?: WorkEntryNotificationHandlers;
  readonly selectedStandaloneChatId: string | null;
  readonly onSelectChat: (localId: string) => void;
  /**
   * Shows each Chats-section row's last-activity age (`5m`, `3h`, `2d`) on
   * the right of an idle row. Desktop turns it on under early access.
   */
  readonly showActivityAge?: boolean;
  /** Where Chats-section rows show their status (`WorkEntryRow`). */
  readonly rowStatusPlacement?: 'trailing' | 'leading';
  /** The list disclosure reads `More` / `Less`, with no count. */
  readonly compactDisclosure?: boolean;
  /**
   * Activates this section's workspace from the header (badge/name), the
   * same affordance code workspace headers expose. Without it a chatless
   * cowork workspace section renders but cannot be selected (CAN-1986).
   */
  readonly onSelectWorkspace?: () => void;
  /**
   * Folder presentation only: the name toggles collapse instead of selecting
   * the workspace (desktop's cowork row toggled on its name and opened chats
   * from its entries).
   */
  readonly nameTogglesCollapse?: boolean;
  readonly touchTargets?: boolean;
  /**
   * Host-owned collapse state for the folder. Omitted ⇒ the section keeps a
   * local toggle (today's behavior); supplied, the section renders that state
   * and reports toggles through {@link onCollapsedChange} so the host can
   * persist them — desktop in its sidebar index, web in local storage.
   */
  readonly collapsed?: boolean;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  /**
   * How the section is headed.
   *
   * - `'folder'` (default) — a cowork folder row (`WorkspaceSectionHeader`),
   *   for a cowork workspace listed among the projects.
   * - `'section'` — desktop's Chats section header: a text-only row in the
   *   section vocabulary, for the catch-all workspace the shared sidebar hoists
   *   above Projects (web chat parity, slice 6). An app-assigned name renders
   *   as the `Chats` label, exactly as the desktop header does.
   */
  readonly headerPresentation?: 'folder' | 'section';
  readonly testIds?: StandaloneChatsSidebarSectionTestIds;
  readonly workspace?: StandaloneChatsSidebarWorkspace;
  /**
   * Trailing cluster on the section header, mirroring desktop's. Rendered
   * here rather than injected as a slot so both hosts get the same chrome and
   * can only differ in which handlers they supply — a slot would let the two
   * platforms draw different controls again, which is the drift this section
   * is being converged to remove.
   *
   * Each control appears only when its handler does, so a host that cannot
   * perform the action shows nothing rather than a dead button.
   */
  readonly onOpenSettings?: () => void;
  readonly onCreateChat?: () => void;
  /**
   * Entries for the header's overflow menu.
   *
   * The CONTROL is shared — its placement in the cluster, its reveal-on-hover
   * behaviour, its `aria-haspopup` wiring and the menu shell it opens — so the
   * two platforms cannot draw a different affordance. Only the entries are
   * host-supplied, because the actions genuinely differ: desktop offers
   * template sharing, session import and a sort mode the portal has no
   * equivalent for.
   *
   * Omit it and no overflow control renders, rather than an empty menu.
   */
  readonly renderHeaderMenuItems?: () => ReactNode;
  readonly selectionActions?: ReactNode;
  readonly onEnterSelection?: () => void;
  /** Keep header action geometry while first-use provisioning is pending. */
  readonly headerActionsDisabled?: boolean;
  /**
   * Replaces the section's own chat rows with the host's, leaving the header
   * and the occludable block that wraps them shared.
   *
   * Desktop supplies it because its Chats bucket reads Work Entries from its
   * own stores, while the portal's rows are grouped here from the flat chats
   * its wire carries. Both draw the shared `WorkEntryRow` once desktop moves
   * to it (CAN-3053 slice 2c); what they must never draw differently is the
   * header, the sticky block, or the marks, which is where drift shows.
   *
   * Deliberately narrower than a whole-section slot: the wrapper keeps
   * `data-sidebar-chats-mask` and the scroll mask, so the rail's sticky
   * machinery measures the host's rows exactly as it measures the shared ones.
   *
   * While the section is collapsed it is asked for its collapsed form, and
   * only when {@link hasSelectedRow} says it holds the selection.
   */
  readonly renderRows?: (state: StandaloneChatsSidebarRowsState) => ReactNode;
  /**
   * Whether {@link renderRows}' rows hold the selected chat. The section's own
   * rows answer this from `selectedStandaloneChatId`; a host's rows read their
   * own stores, so the host says. Collapsed, the rows block stays only then.
   */
  readonly hasSelectedRow?: boolean;
  /**
   * Whether {@link renderRows}' rows are empty. The section counts its own
   * rows; a host's rows read their own stores, so the host says. An empty
   * section keeps its "+" on screen, since it is then the only way in.
   */
  readonly rowsEmpty?: boolean;
  /** Fires as the Chats header sticks over its own rows (and un-sticks). */
  readonly onStuckChange?: (stuck: boolean) => void;
  /**
   * Whether a host rail owns this header's pinning.
   *
   * The header is sticky either way — it is a section header over a scrolling
   * list on both platforms. What differs is who positions it:
   *
   * - `true`: the rail's sync seats its real `top` beneath the pinned controls
   *   above it and publishes the stuck mark it reads, and it carries the
   *   rail's `z-40` so it outranks everything scrolling past.
   * - `false`: pinned to the top of the host's own scroll box, with the
   *   Projects header seated directly beneath it so the two STACK rather than
   *   trade one seat. It sits above Projects in depth because it is the outer
   *   header; the original bug was not the ordering but that both claimed
   *   `top: 0`, so whichever won covered the other outright.
   */
  readonly stickyHeader?: boolean;
  /**
   * How many chats the section lists before the rest go behind "Show all".
   *
   * Chats sits ABOVE the project list, so an uncapped list pushes every
   * project below the fold — which is why desktop caps it. Omit for no cap.
   */
  readonly maxEntries?: number;
  /**
   * Lists one `None found` row while the section presentation has no chats,
   * the row an empty Projects list shows (CAN-3550). A host that supplies
   * `renderRows` owns the emptiness rule and draws the row itself.
   */
  readonly listsNoneFoundWhenEmpty?: boolean;
  /**
   * The line the empty row reads when {@link listsNoneFoundWhenEmpty} lists
   * it. Unset keeps `None found`. Has no effect on whether the row lists.
   */
  readonly emptyLabel?: string;
}

/**
 * The chats a flat workspace's section lists: its own, plus — only for the
 * PRIMARY flat workspace (first by `compareWorkspaces`) — the unparented
 * legacy chats. Exported so the surface that decides whether to render the
 * section at all (the hoisted Chats section hides when empty) applies the
 * same ownership rule as the section itself, rather than a looser copy.
 */
export function standaloneChatsForWorkspace(
  snapshot: StandaloneChatsSidebarSnapshot,
  workspace: StandaloneChatsSidebarWorkspace | undefined,
): StandaloneChatsSidebarChat[] {
  const primaryCoworkWorkspace = primaryFlatWorkspace(snapshot);
  const isPrimaryCowork =
    workspace?.localId !== undefined &&
    workspace.localId === primaryCoworkWorkspace?.localId;
  return snapshot.standaloneChats.filter((chat) => {
    if (chat.archived === true) return false;
    if (!workspace?.localId) return true;
    return (
      chat.projectLocalId === workspace.localId ||
      (isPrimaryCowork && chat.projectLocalId === undefined)
    );
  });
}

/** A Chats row's label: its Work Entry title when projected, as desktop's. */
function standaloneChatRowLabel(chat: StandaloneChatsSidebarChat): string {
  return chat.workEntryTitle?.trim() ? chat.workEntryTitle : chat.title;
}

/**
 * The Chats section's Work Entry rows, ordered as desktop orders them.
 *
 * Older desktop snapshots retain manual order; cloud rows retain recency.
 * Chats without an owning project belong to the section's workspace, which
 * is the only one that lists unparented chats.
 */
function chatsSectionWorkEntryRows(
  chats: readonly StandaloneChatsSidebarChat[],
  workspace: StandaloneChatsSidebarWorkspace | undefined,
  openChatId: string | null,
  hideEmpty = true,
): StandaloneWorkEntryRow<
  StandaloneChatsSidebarChat & { projectLocalId: string }
>[] {
  return groupStandaloneChatsIntoWorkEntries(
    chats.map((chat) => ({
      ...chat,
      projectLocalId: chat.projectLocalId ?? workspace?.localId ?? '',
    })),
    {
      mode:
        workspace?.itemSortMode ??
        (workspace?.backend === 'cloud' ? 'last-updated' : 'manual'),
      // Desktop's Chats section lists an empty entry only while it is open.
      ...(hideEmpty ? { hideEmptyWorkEntries: { openChatId } } : {}),
    },
  );
}

/**
 * The flat workspace that owns unparented standalone chats: the first by
 * `compareWorkspaces`. Only a FLAT workspace can own them — that ownership is
 * about where the chats render, not what the workspace is. A cloud workspace
 * classifies as `cowork` but keeps its chats under itself in `worktrees`, so
 * it is excluded from this election (REG-2819).
 */
function primaryFlatWorkspace(
  snapshot: StandaloneChatsSidebarSnapshot,
): StandaloneChatsSidebarWorkspace | undefined {
  return snapshot.workspaces
    .filter((item) => workspaceLayout(item) === 'flat')
    .slice()
    .sort((first, second) =>
      compareWorkspaces(
        {
          localId: first.localId ?? '',
          name: first.name,
          order: first.order,
        },
        {
          localId: second.localId ?? '',
          name: second.name,
          order: second.order,
        },
      ),
    )[0];
}

/**
 * Standalone/Cowork chat section shared by sidebar hosts.
 *
 * The Chats section (`headerPresentation="section"`) groups the portal's flat
 * chats into the Work Entries desktop lists and draws each with the shared
 * `WorkEntryRow` (CAN-3053). A cowork folder still lists its chats flat.
 */
export function StandaloneChatsSidebarSection({
  snapshot,
  selectedStandaloneChatId,
  onSelectChat,
  onSelectWorkspace,
  nameTogglesCollapse = false,
  touchTargets = false,
  showActivityAge = false,
  rowStatusPlacement = 'trailing',
  compactDisclosure = false,
  testIds,
  workspace,
  onOpenSettings,
  onCreateChat,
  renderHeaderMenuItems,
  selectionActions,
  onEnterSelection,
  headerActionsDisabled = false,
  renderRows,
  hasSelectedRow = false,
  rowsEmpty = false,
  onStuckChange,
  stickyHeader = false,
  maxEntries,
  listsNoneFoundWhenEmpty = false,
  emptyLabel,
  collapsed,
  onCollapsedChange,
  headerPresentation = 'folder',
  itemGroupCommands,
  onCreateInGroup,
  onGroupError,
  workEntryNotifications,
  workEntryMultiSelect,
}: StandaloneChatsSidebarSectionProps): JSX.Element | null {
  const [localExpanded, setLocalExpanded] = useState(true);
  const expanded = collapsed === undefined ? localExpanded : !collapsed;
  const toggle = (): void => {
    const next = !expanded;
    setLocalExpanded(next);
    onCollapsedChange?.(!next);
  };
  // Mirrors the mark the rail's scroll sync publishes on this header. The sync
  // owns the measurement — this only reflects it, so the label assistive
  // technology announces and the chevron the eye reads come from one source
  // rather than a second implementation of the same geometry. A host without
  // that sync (the portal) never sets the mark, and the header stays an
  // ordinary disclosure.
  const [stuck, setStuck] = useState(false);
  const onStuckChangeRef = useRef(onStuckChange);
  onStuckChangeRef.current = onStuckChange;
  useEffect(() => {
    onStuckChangeRef.current?.(stuck);
  }, [stuck]);
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRest = useSidebarHeaderRest(!expanded, menuOpen);
  const [showAllChats, setShowAllChats] = useState(false);
  const stuckObserverRef = useRef<MutationObserver | null>(null);
  // A callback ref, not an effect: this section can mount before the header
  // exists and the header can be replaced without the section unmounting, and
  // because the click path measures live the only symptom of a detached
  // observer would be assistive technology hearing a stale disclosure promise.
  const attachHeader = useCallback((header: HTMLDivElement | null): void => {
    stuckObserverRef.current?.disconnect();
    stuckObserverRef.current = null;
    if (!header) {
      setStuck(false);
      return;
    }
    const read = (): void => {
      setStuck(header.getAttribute(CHATS_HEADER_STUCK_ATTR) === 'true');
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(header, {
      attributes: true,
      attributeFilter: [CHATS_HEADER_STUCK_ATTR],
    });
    stuckObserverRef.current = observer;
  }, []);
  const primaryCoworkWorkspace = primaryFlatWorkspace(snapshot);
  const activeChats = standaloneChatsForWorkspace(snapshot, workspace);
  // A per-workspace section renders its header even with zero chats so a
  // fresh cowork workspace stays visible in the sidebar (CAN-1986); only the
  // flat legacy section (no owning workspace) collapses to nothing when empty.
  if (activeChats.length === 0 && workspace === undefined && !renderRows) {
    return null;
  }

  const folderName =
    workspace?.name ?? primaryCoworkWorkspace?.name ?? 'Default';

  // The catch-all is an ordinary cowork project and may be renamed, so the
  // header is named by the workspace unless that name is still the default.
  // The automatic default cloud workspace's default is its provisioned name;
  // that name alone never qualifies another workspace (CAN-3898).
  const defaultName =
    workspace?.chatsHome === true
      ? folderName.trim() === CLOUD_FIRST_WORKSPACE_NAME
      : isDefaultCoworkWorkspaceName(folderName);
  const sectionLabel = defaultName ? CHAT_UNIT_LABEL_PLURAL : folderName;
  // Only the section presentation is the rail's unique Chats block; the
  // default `folder` presentation renders ordinary cowork workspaces, which
  // must not claim the marks that identify it.
  const isChatsSection = headerPresentation === 'section';
  // The Chats section lists Work Entries, as desktop's rail does (CAN-3053);
  // a cowork folder still lists its chats flat.
  const groupPresentation =
    itemGroupCommands !== undefined || (workspace?.itemGroups?.length ?? 0) > 0;
  const workEntryRows =
    (isChatsSection || groupPresentation) && !renderRows
      ? chatsSectionWorkEntryRows(
          activeChats,
          workspace,
          selectedStandaloneChatId,
          isChatsSection,
        )
      : [];
  const listedCount =
    isChatsSection || groupPresentation
      ? workEntryRows.length
      : activeChats.length;
  // Capped unless the reader asked for the rest. The cap only applies to the
  // section's own rows; a host supplying `renderRows` caps them itself.
  const capped = maxEntries !== undefined && !showAllChats;
  const cappedChats = capped ? activeChats.slice(0, maxEntries) : activeChats;
  const cappedWorkEntryRows = capped
    ? workEntryRows.slice(0, maxEntries)
    : workEntryRows;
  const flatHiddenChatCount =
    listedCount -
    (isChatsSection || groupPresentation
      ? cappedWorkEntryRows.length
      : cappedChats.length);
  const groupMode =
    workspace?.itemSortMode ??
    (workspace?.backend === 'cloud' ? 'last-updated' : 'manual');
  const selectedEntryId = workEntryRows.find((row) =>
    row.chats.some((chat) => chat.localId === selectedStandaloneChatId),
  )?.workEntryId;
  const blocks = buildSidebarItemGroupBlocks(
    workEntryRows.map((row) => ({
      rootId: row.workEntryId,
      itemIds: [row.workEntryId],
      pinned: row.pinned,
      recencyMs: workEntryRecencyMs(row),
    })),
    workspace?.itemGroups ?? [],
    groupMode,
    selectedEntryId,
  );
  const cappedBlocks = capped
    ? capSidebarItemGroupBlocks(
        blocks,
        maxEntries ?? Number.MAX_SAFE_INTEGER,
        selectedEntryId,
      )
    : { visible: blocks, hidden: [] };
  const hiddenChatCount = groupPresentation
    ? cappedBlocks.hidden.reduce(
        (count, block) => count + block.units.length,
        0,
      )
    : flatHiddenChatCount;
  // The bulk selection's list for this section's Work Entry rows.
  const selectionListId = workspace?.localId;
  const renderGroupRow = (
    id: string,
    menu: WorktreeMenuItem[] = [],
  ): ReactNode => {
    const row = workEntryRows.find((row) => row.workEntryId === id);
    return row ? (
      <ChatsSectionWorkEntryRow
        row={row}
        menu={menu}
        multiSelect={workEntryMultiSelect}
        selectionListId={selectionListId}
        notifications={workEntryNotifications}
        selectedStandaloneChatId={selectedStandaloneChatId}
        onSelectChat={onSelectChat}
        touchTargets={touchTargets}
        testIds={testIds}
        showActivityAge={showActivityAge}
        statusPlacement={rowStatusPlacement}
      />
    ) : null;
  };
  // A collapsed Chats section keeps exactly its selected row, wherever the
  // cap put it, as a collapsed project keeps its selected row; with nothing
  // selected it hides every row. A cowork folder still collapses to its
  // header. Host rows (`renderRows`) draw their own collapsed form, so the
  // host says whether they hold the selection.
  const collapsedSelectedRow =
    isChatsSection && !expanded && !renderRows
      ? workEntryRows.find((row) =>
          row.chats.some((chat) => chat.localId === selectedStandaloneChatId),
        )
      : undefined;
  const listedWorkEntryRows = expanded
    ? cappedWorkEntryRows
    : collapsedSelectedRow
      ? [collapsedSelectedRow]
      : [];
  const showsCollapsedSelection =
    isChatsSection &&
    !expanded &&
    (renderRows ? hasSelectedRow : collapsedSelectedRow !== undefined);
  // Nothing to list: the "+" is then the only way into the section.
  const sectionEmpty = renderRows ? rowsEmpty : listedCount === 0;
  const listsNoneFound =
    expanded &&
    isChatsSection &&
    !renderRows &&
    listsNoneFoundWhenEmpty &&
    listedCount === 0 &&
    blocks.length === 0;

  // The Work Entry rows this section renders, in order, for the bulk
  // selection: rows hidden by the cap or inside a collapsed group are not
  // rendered, so ranges and select-all never reach them.
  const renderedWorkEntryRows =
    workEntryMultiSelect === undefined ||
    selectionListId === undefined ||
    renderRows
      ? []
      : groupPresentation
        ? expanded
          ? cappedBlocks.visible.flatMap((block) =>
              block.visibleItemIds.flatMap((id) => {
                const row = workEntryRows.find(
                  (candidate) => candidate.workEntryId === id,
                );
                return row ? [row] : [];
              }),
            )
          : // Collapsed, the section still renders its selected row.
            listedWorkEntryRows
        : isChatsSection
          ? listedWorkEntryRows
          : [];
  const selectionRows: SidebarSelectionRow[] =
    selectionListId === undefined || workEntryMultiSelect === undefined
      ? []
      : renderedWorkEntryRows.map((row) => ({
          key: workEntryRowKey(selectionListId, row.workEntryId),
          kind: 'work-entry',
          selectable:
            row.hasWorkEntry &&
            workEntryMultiSelect.isSelectable(selectionListId),
          label: row.title.trim() ? row.title : row.targetChat.title,
          projectName: workspace?.name ?? folderName,
          open: row.chats.some(
            (chat) => chat.localId === selectedStandaloneChatId,
          ),
        }));

  return (
    <div
      // `contents` for the Chats section: the sticky header inside must not
      // be trapped in a containing block that ends with its own rows, or it
      // leaves the viewport exactly when it is needed. See the matching note
      // on `portal-chats-section`. Spacing moves onto the rows themselves,
      // since a boxless wrapper cannot carry `space-y`.
      // `contents` only where the header is sticky: a wrapper that ends with
      // the section would otherwise drag that header off screen with its own
      // rows. A non-sticky header needs no such escape, so the ordinary box
      // stays.
      // Boxless for the Chats section on BOTH platforms. Its header is sticky
      // either way, and a wrapper that ends with the section bounds that
      // header inside it — so it scrolls away the moment the section does,
      // while the Projects header below stays seated one header-height down
      // and leaves a hole with rows showing through. The 1px gap this wrapper
      // used to carry moves onto the row list (`mt-px`).
      className={isChatsSection ? 'contents' : 'flex flex-col gap-1'}
      data-testid={testIds?.root}
      // A folder is a workspace root for the rail's sticky-seat sync (the
      // desktop cowork row marks its own root the same way); the Chats
      // section is boxless and is found by its own header mark instead.
      {...(!isChatsSection && workspace
        ? { 'data-sidebar-workspace-id': workspace.localId }
        : {})}
    >
      {isChatsSection ? (
        <RailSectionHeader
          ref={attachHeader}
          kind="chats"
          label={sectionLabel}
          touchTargets={touchTargets}
          labelSetsHeight={stickyHeader}
          expanded={expanded}
          returnToRows={stuck}
          chevronTestId="sidebar-chats-chevron"
          toggleProps={{
            'data-testid': testIds?.sectionToggle ?? testIds?.folderToggle,
            'aria-label': stuck ? `Back to ${sectionLabel}` : undefined,
            onClick: (event): void => {
              const header = event.currentTarget.closest<HTMLElement>(
                CHATS_HEADER_SELECTOR,
              );
              if (header !== null && revealOccludedChats(header)) return;
              toggle();
              if (event.detail > 0) event.currentTarget.blur();
            },
          }}
          data-sidebar-chats-header=""
          style={
            stickyHeader
              ? { top: '1px', paddingRight: RAIL_SECTION_HEADER_PADDING_RIGHT }
              : undefined
          }
          data-sidebar-header-resting={headerRest.resting || undefined}
          onPointerEnter={headerRest.onPointerEnter}
          onPointerMove={headerRest.onPointerMove}
          onFocusCapture={headerRest.onFocusCapture}
          onKeyDownCapture={headerRest.onKeyDownCapture}
          resting={headerRest.resting}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          menuTestId={testIds?.sectionMenu}
          menuContentTestId={testIds?.sectionMenuContent}
          actions={selectionActions}
          renderMenuItems={
            renderHeaderMenuItems || onEnterSelection
              ? (close) => (
                  <>
                    {renderHeaderMenuItems?.()}
                    {renderHeaderMenuItems && onEnterSelection && (
                      <DropdownMenuDivider />
                    )}
                    {onEnterSelection && (
                      <DropdownMenuItem
                        onClick={() => {
                          close();
                          onEnterSelection();
                        }}
                      >
                        <DropdownMenuItemIcon>
                          <ListChecks />
                        </DropdownMenuItemIcon>
                        Select
                      </DropdownMenuItem>
                    )}
                  </>
                )
              : undefined
          }
          actionsDisabled={headerActionsDisabled}
          onCreate={onCreateChat}
          createRevealed={sectionEmpty}
          createTestId={testIds?.sectionCreateChat}
          onSettings={onOpenSettings}
          settingsTestId={testIds?.sectionSettings}
        />
      ) : (
        // The rail's sticky-seat sync collects `.sidebar-workspace-sticky-header`
        // boxes (the desktop cowork row marks its header the same way) and
        // pairs each with the content block that follows it.
        <div className="sidebar-workspace-sticky-header flex min-w-0 flex-1">
          <WorkspaceSectionHeader
            name={folderName}
            workspaceType="cowork"
            // Same scale as tree workspace headers (WorkspacesSidebarSections),
            // so a cowork folder does not render larger than its neighbours.
            textScale="sidebar"
            worktreeCount={0}
            collapsed={!expanded}
            canToggleCollapse
            disableDrag
            deferHoverActions
            touchTarget={touchTargets}
            primaryButtonDataAttrs={
              testIds?.folderToggle
                ? { 'data-testid': testIds.folderToggle }
                : undefined
            }
            onToggleCollapse={toggle}
            onSelectBadge={nameTogglesCollapse ? undefined : onSelectWorkspace}
            onSelectName={nameTogglesCollapse ? undefined : onSelectWorkspace}
          />
        </div>
      )}
      {workEntryMultiSelect !== undefined &&
        selectionListId !== undefined &&
        // Host rows report themselves under the same list.
        !renderRows && (
          <SidebarSelectionRowsReporter
            listId={selectionListId}
            rows={selectionRows}
            onRowsChange={workEntryMultiSelect.onRowsChange}
          />
        )}
      {isChatsSection && stickyHeader && (
        // The selected chat's pinned copy seats here, as the header's next
        // sibling, while the rail scrolls it away. Only a host rail pins, so
        // only a host rail gets one.
        <ChatsSelectedPinSeat />
      )}
      {(expanded || showsCollapsedSelection) && (
        // Marked as the occludable block the header is measured against —
        // but ONLY in the section presentation, which is the unique Chats
        // block. The mark must be paired with the header mark above: the
        // rail's sync takes the FIRST `[data-sidebar-chats-mask]` it finds
        // and pairs it with the first header, so an ordinary cowork folder
        // carrying this mark without a header would be mistaken for the
        // Chats section and fed into its sticky-threshold and clip
        // synchronization. `sidebar-chats-scroll-mask` is likewise scoped:
        // it is not inert, it has an active mask rule in the desktop
        // renderer's globals.css.
        <SidebarList
          rowGap="thin"
          // The hairline desktop leaves between the Chats header and its
          // first row. Carried here because the section wrapper is boxless,
          // and inside the list's box so the rail's threshold (this block's
          // offsetHeight) includes it; a margin left the clip a pixel short.
          leadingHairline={isChatsSection}
          className={isChatsSection ? 'sidebar-chats-scroll-mask' : ''}
          // The host's rows bring their own semantics (desktop's are
          // multi-chat containers, not list items), so the shared wrapper
          // stops claiming to be the list when it is only holding them. The
          // `None found` row is not a list item either.
          role={renderRows || listsNoneFound ? 'presentation' : undefined}
          data-testid={testIds?.sectionContent}
          {...(isChatsSection
            ? { 'data-sidebar-chats-mask': '' }
            : { 'data-sidebar-folder-content': 'cowork' })}
        >
          {listsNoneFound && (
            <SidebarNoneFoundRow
              data-testid={testIds?.sectionEmpty}
              labelTestId={
                testIds?.sectionEmpty === undefined
                  ? undefined
                  : `${testIds.sectionEmpty}-label`
              }
              label={emptyLabel}
            />
          )}
          {renderRows ? (
            renderRows({ collapsed: !expanded, workEntryMultiSelect })
          ) : groupPresentation && expanded ? (
            <div className="-ml-2 pl-2">
              <CodeSidebarItemGroups
                blocks={cappedBlocks.visible}
                selectedItemId={selectedEntryId}
                groups={workspace?.itemGroups ?? []}
                mode={groupMode}
                commands={itemGroupCommands}
                unitLabel={{ singular: 'work entry', plural: 'work entries' }}
                rowGap="thin"
                selectionCount={workEntryMultiSelect?.selection.count}
                isItemSelected={
                  workEntryMultiSelect?.selection.active === true &&
                  selectionListId !== undefined
                    ? (id): boolean =>
                        workEntryMultiSelect.selection.isSelected(
                          workEntryRowKey(selectionListId, id),
                        )
                    : undefined
                }
                renderRow={renderGroupRow}
                renderPreview={(id) => renderGroupRow(id)}
                onCreate={(groupId) => onCreateInGroup?.(groupId)}
                onError={(error) => onGroupError?.(error)}
                canDragRow={(id) =>
                  workEntryRows.some(
                    (row) =>
                      row.workEntryId === id && row.hasWorkEntry && !row.pinned,
                  )
                }
                renderStatus={(block) =>
                  block.units.some(
                    (unit) =>
                      workEntryRows.find(
                        (row) => row.workEntryId === unit.rootId,
                      )?.hasActiveChat,
                  ) ? (
                    <ThinkingSpinner tone="accent" />
                  ) : block.units.some((unit) => {
                      const row = workEntryRows.find(
                        (row) => row.workEntryId === unit.rootId,
                      );
                      return (
                        row?.hasUnread === true &&
                        !isWorkEntrySpaceMuted(workEntryNotifications, row)
                      );
                    }) ? (
                    <Dot tone="unread" label="Unread work in group" />
                  ) : null
                }
              />
            </div>
          ) : isChatsSection ? (
            listedWorkEntryRows.map((row) => (
              <ChatsSectionWorkEntryRow
                key={row.key}
                row={row}
                multiSelect={workEntryMultiSelect}
                selectionListId={selectionListId}
                selectedStandaloneChatId={selectedStandaloneChatId}
                onSelectChat={onSelectChat}
                touchTargets={touchTargets}
                testIds={testIds}
                notifications={workEntryNotifications}
                showActivityAge={showActivityAge}
                statusPlacement={rowStatusPlacement}
              />
            ))
          ) : (
            cappedChats.map((chat) => {
              const selected = selectedStandaloneChatId === chat.localId;
              return (
                <SidebarRowFrame
                  key={chat.localId}
                  data-testid={testIds?.chatRow?.(chat.localId)}
                  // Marks this as a chat row for the header's reveal, which
                  // must not key off a host's test id (desktop's Work Entry
                  // rows carry a different one).
                  {...{ [CHATS_ROW_ATTR]: '' }}
                  variant="bare"
                  selected={selected}
                  density={touchTargets ? 'touch' : 'default'}
                >
                  <StandaloneChatRow
                    title={standaloneChatRowLabel(chat)}
                    providerType={chat.providerType}
                    selected={selected}
                    onSelect={() => onSelectChat(chat.localId)}
                    dataChatId={chat.localId}
                    touchTarget={touchTargets}
                  />
                </SidebarRowFrame>
              );
            })
          )}
          {expanded &&
            !renderRows &&
            (showAllChats ||
              hiddenChatCount > 0 ||
              cappedBlocks.hidden.length > 0) &&
            (compactDisclosure ? (
              // One more list row, 1px under the last like the rows' gap.
              <div className="mt-px">
                <SidebarMoreRow
                  expanded={showAllChats}
                  onToggle={(): void => setShowAllChats((shown) => !shown)}
                  ariaLabel={
                    showAllChats
                      ? `Show fewer ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`
                      : `Show all ${listedCount} ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`
                  }
                  testId={testIds?.sectionShowAll}
                  touchTarget={touchTargets}
                />
              </div>
            ) : (
              <SidebarToggleRow
                label={showAllChats ? 'Show fewer' : 'Show all'}
                expanded={showAllChats}
                onToggle={(): void => setShowAllChats((shown) => !shown)}
                ariaLabel={
                  showAllChats
                    ? `Show fewer ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`
                    : `Show all ${listedCount} ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`
                }
                count={listedCount}
                testId={testIds?.sectionShowAll}
                countTestId={
                  testIds?.sectionShowAll
                    ? `${testIds.sectionShowAll}-count`
                    : undefined
                }
              />
            ))}
        </SidebarList>
      )}
    </div>
  );
}

interface ChatsSectionWorkEntryRowProps {
  readonly row: StandaloneWorkEntryRow<
    StandaloneChatsSidebarChat & { projectLocalId: string }
  >;
  readonly selectedStandaloneChatId: string | null;
  readonly onSelectChat: (localId: string) => void;
  readonly touchTargets: boolean;
  readonly testIds: StandaloneChatsSidebarSectionTestIds | undefined;
  readonly menu?: readonly WorktreeMenuItem[];
  /** The bulk selection; absent where the host wired no Work Entry removal. */
  readonly multiSelect?: WorkEntryMultiSelectBinding;
  /** The list the section reports this row under: its workspace. */
  readonly selectionListId?: string;
  readonly notifications: WorkEntryNotificationHandlers | undefined;
  readonly showActivityAge: boolean;
  readonly statusPlacement: 'trailing' | 'leading';
}

/**
 * The Work Entry menu's notification choices. Mounted only while the menu is
 * open, so the refresh runs on open and closed rows hold nothing.
 */
function WorkEntryNotificationMenuItems({
  menu,
  workspaceLocalId,
  workEntryId,
  notifications,
}: {
  readonly menu: WorkEntryRowMenuContext;
  readonly workspaceLocalId: string;
  readonly workEntryId: string;
  readonly notifications: WorkEntryNotificationHandlers;
}): JSX.Element | null {
  // Hosts rebuild their handlers whenever their store changes, and the
  // refresh changes the store, so the refresh keys off the row alone and
  // reaches the latest handler through a ref.
  const onOpenRef = useRef(notifications.onOpen);
  onOpenRef.current = notifications.onOpen;
  useEffect(() => {
    onOpenRef.current(workspaceLocalId, workEntryId);
  }, [workspaceLocalId, workEntryId]);
  const state = notifications.getState(workspaceLocalId, workEntryId);
  if (!state) return null;
  return (
    <WorkEntryRowMenuItems
      menu={menu}
      notifications={state}
      onNotificationChoice={(choice): void =>
        notifications.onSelect(workspaceLocalId, workEntryId, choice)
      }
    />
  );
}

/**
 * One Chats-section row: a Work Entry drawn by the shared `WorkEntryRow`, so
 * the portal shows desktop's title, done check, working spinner and unread
 * dot (CAN-3053).
 *
 * The row offers no hover actions. The portal has no command to rename,
 * pin, mark done, archive or delete a Work Entry, and a control it cannot run
 * is left out rather than drawn dead. Its menu carries only the viewer's own
 * notification choices, which are a server setting rather than a command.
 */
function ChatsSectionWorkEntryRow({
  row,
  selectedStandaloneChatId,
  onSelectChat,
  touchTargets,
  testIds,
  menu = [],
  multiSelect: multiSelectProp,
  selectionListId,
  notifications,
  showActivityAge,
  statusPlacement,
}: ChatsSectionWorkEntryRowProps): JSX.Element {
  const drag = useContext(WorktreeSortableStateContext);
  const selectedChat =
    selectedStandaloneChatId === null
      ? undefined
      : row.chats.find((chat) => chat.localId === selectedStandaloneChatId);
  const selected = selectedChat !== undefined;
  // The chat on screen is being read, so it does not count as unread even
  // before the desktop's projection catches up. A muted entry shows no dot.
  const hasUnread =
    !isWorkEntrySpaceMuted(notifications, row) &&
    row.unreadChats.some((chat) => chat.localId !== selectedStandaloneChatId);
  const title = row.title.trim() ? row.title : row.targetChat.title;
  const workspaceLocalId = row.targetChat.projectLocalId;
  const offersNotifications =
    notifications?.getState(workspaceLocalId, row.workEntryId) !== undefined;
  const rowTestId =
    testIds?.workEntryRow?.(row.workEntryId) ??
    `portal-chats-work-entry-${row.workEntryId}`;
  const multiSelect =
    selectionListId === undefined ? undefined : multiSelectProp;
  const selectionKey = workEntryRowKey(
    selectionListId ?? workspaceLocalId,
    row.workEntryId,
  );
  const selectable =
    multiSelect !== undefined &&
    selectionListId !== undefined &&
    row.hasWorkEntry &&
    multiSelect.isSelectable(selectionListId);
  const selectionMenu =
    multiSelect === undefined
      ? undefined
      : multiSelect.menuItemsFor(selectionKey, {
          bulkPin: `${rowTestId}-bulk-pin`,
          bulkArchive: `${rowTestId}-bulk-archive`,
          bulkDelete: `${rowTestId}-bulk-delete`,
        });
  // A row in a selection of 2 or more shows the selection's menu alone,
  // with the group moves the list built for it.
  const replaces = selectionMenu?.replacesMenu === true;
  const autoDelete = useSidebarAutoDelete({
    workspaceId: workspaceLocalId,
    targetId: row.workEntryId,
    name: title,
  });
  const disarmItem: WorktreeMenuItem | undefined =
    autoDelete.autoDelete && autoDelete.onAutoDeleteDisarm
      ? {
          key: 'auto-delete-disarm',
          icon: null,
          label:
            autoDelete.autoDelete.mode === 'archive'
              ? 'Turn off auto-archive'
              : 'Turn off auto-delete',
          onSelect: autoDelete.onAutoDeleteDisarm,
        }
      : undefined;
  const removalIndex = menu.findIndex(
    (item) => item.key === 'archive' || item.key === 'delete',
  );
  const insertionIndex = removalIndex < 0 ? menu.length : removalIndex;
  const rowMenu = replaces
    ? []
    : disarmItem
      ? [
          ...menu.slice(0, insertionIndex),
          disarmItem,
          ...menu.slice(insertionIndex),
        ]
      : menu;
  const showsNotifications =
    !replaces && notifications !== undefined && offersNotifications;
  const selectionSource = replaces
    ? withSelectionGroupItems(selectionMenu?.items ?? [], menu)
    : (selectionMenu?.items ?? []);
  // Select leads its own group, unless nothing precedes it.
  const selectionItems = selectionSource.map((item, index) =>
    index === 0 && rowMenu.length === 0 && !showsNotifications
      ? { ...item, separatorBefore: false }
      : item,
  );
  const offersSelectItem =
    !replaces && selectable && multiSelect?.onSelectItem !== undefined;
  const hasMenu =
    rowMenu.length > 0 ||
    showsNotifications ||
    offersSelectItem ||
    selectionItems.length > 0;

  return (
    <SidebarRowFrame
      data-testid={testIds?.chatRow?.(row.targetChat.localId)}
      // Marks this as a chat row for the header's reveal, which must not key
      // off a host's test id.
      {...{ [CHATS_ROW_ATTR]: '' }}
      variant="bare"
      selected={selected}
      density={touchTargets ? 'touch' : 'default'}
    >
      <WorkEntryRow
        {...autoDelete}
        drag={
          drag
            ? { attributes: drag.attributes, isDragging: drag.isDragging }
            : undefined
        }
        title={title}
        testId={rowTestId}
        entryId={row.workEntryId}
        multiSelect={
          multiSelect === undefined
            ? undefined
            : workEntryRowMultiSelectProps(
                multiSelect,
                selectionListId ?? workspaceLocalId,
                selectionKey,
                selectable,
              )
        }
        removing={multiSelect?.isRemoving(selectionKey) === true}
        status={row.status}
        statusPlacement={statusPlacement}
        selected={selected}
        working={row.hasActiveChat}
        backgroundTasks={row.backgroundTasks}
        hasUnread={hasUnread}
        pinnedToTop={row.pinned}
        // Desktop's Chats rows opt out of the selected-item pin: the header
        // above them is not a workspace header (CAN-2363).
        disableSelectedPin
        touchTarget={touchTargets}
        // The entry's newest chat is its latest activity.
        lastActivityAt={
          showActivityAge
            ? (row.targetChat.lastMessageAt ?? row.targetChat.createdAt)
            : undefined
        }
        // Reopening the entry keeps the chat already open in it; otherwise
        // it opens the chat with the newest activity.
        onOpen={(): void =>
          onSelectChat((selectedChat ?? row.targetChat).localId)
        }
        renderMenuItems={
          hasMenu
            ? (menuContext): ReactNode => (
                <>
                  {rowMenu.length > 0 && (
                    <WorktreeActionMenuItems
                      items={rowMenu}
                      onSelect={(item) => {
                        if (item.role !== 'menuitemradio') menuContext.close();
                        item.onSelect?.();
                      }}
                    />
                  )}
                  {showsNotifications && notifications !== undefined && (
                    <WorkEntryNotificationMenuItems
                      menu={menuContext}
                      workspaceLocalId={workspaceLocalId}
                      workEntryId={row.workEntryId}
                      notifications={notifications}
                    />
                  )}
                  {/* The notification renderer already includes Select item.
                      Without notifications, reuse those same standard rows. */}
                  {offersSelectItem && !showsNotifications && (
                    <WorkEntryRowMenuItems menu={menuContext} />
                  )}
                  {selectionItems.length > 0 && (
                    <WorktreeActionMenuItems
                      items={selectionItems}
                      onSelect={(item) => {
                        if (item.role !== 'menuitemradio') menuContext.close();
                        item.onSelect?.();
                      }}
                    />
                  )}
                </>
              )
            : undefined
        }
        menuLabel={hasMenu ? title : undefined}
      />
    </SidebarRowFrame>
  );
}
