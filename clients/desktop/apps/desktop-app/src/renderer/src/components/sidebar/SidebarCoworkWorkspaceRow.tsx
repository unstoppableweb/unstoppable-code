import { useSidebarAutoDelete } from '@canopy/ui-app';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type JSX,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  CoworkSidebarItem,
  CoworkWorkEntryMeta,
  SidebarSortMode,
  StandaloneChatMeta,
} from '@canopy/desktop-shared/types';
import { canDragSidebarRow, orderWorkEntryRows } from '@/lib/sidebar-ordering';
import { SidebarSortMenuItems } from './SidebarSortMenuItems';
import { coworkProjectMenuItems } from './cowork-project-menu-items';
import { CHAT_UNIT_LABEL, CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import { resolveArchiveRetentionDays } from '@canopy/desktop-shared/lib/archive-retention';
import {
  MoreHorizontalIcon,
  PlusMediumIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  Dot,
  RenameDialog,
  ChatPreviewPopover,
  ActionMenuItems,
  ActionMenuRowStyle,
  FloatingMenu,
  FloatingMenuPointAnchor,
  RailIconButton,
  SidebarFadePresence,
  SidebarPinnedBadge,
  SidebarMoreRow,
  SidebarToggleRow,
  WorkEntryRow,
  WorkEntryRowMenuItems,
  workEntryRowTestId,
  WorkspaceIconDisclosureSwap,
  type ChatPreviewRow,
  type WorkEntryRowDragBinding,
  type WorkEntryRowMenuItemsProps,
  type WorkEntryRowMenuRenderProps,
  WorktreeActionMenuItems,
  SidebarItemGroupHeader,
  sidebarItemGroupColor,
  type WorktreeMenuItem,
  LoadingSpinner,
  AgentStateGlyph,
  isSpaceNotificationMuted,
} from '@canopy/ui-shared/components';
import { useBackgroundTaskCounts } from '@/hooks/useBackgroundTaskCounts';
import {
  useSidebarItemGroupsStore,
  sidebarItemGroupScopeKey,
  observeCoworkSidebarEntries,
} from '@/stores/sidebarItemGroupsStore';
import type { SidebarItemGroup as GroupData } from '@canopy/protocol/sidebar';
import { useSpaceNotificationControlsEnabled } from '@/hooks/useSpaceNotificationSidebarProps';
import {
  spaceNotificationMenuStateFor,
  useSpaceNotificationStore,
  type SpaceNotificationStore,
} from '@/stores/spaceNotificationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { ProjectIcon } from '../shared/ProjectIcon';
import {
  getChatTabAgentResponsePreview,
  useChatStore,
} from '@/stores/chatStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import {
  endChatIntent,
  noteChatIntent,
  type ChatPrefetchTarget,
} from '@/stores/chat/chat-prefetch';
import { useSelectedCoworkEntryId } from './useSelectedCoworkEntryId';
import {
  EMPTY_ARCHIVED_CONTAINERS,
  EMPTY_PENDING_ARCHIVED_CONTAINERS,
  useArchivedContainersStore,
} from '@/stores/archivedContainersStore';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import { openNewCoworkTaskFromSidebar } from '@/lib/openNewCoworkTaskFromSidebar';
import { useNavigationStore } from '@/stores/navigationStore';
import { useGitHubStore } from '@/stores/githubStore';
import { InviteTeammateModal } from '@/components/shared/InviteTeammateModal';
import { useSharedContainerEntryPointVisible } from '@/hooks/useSharedContainerEntryPointVisible';
import { subscribeToSharedContainerInviteRequests } from '@/lib/sharedContainerInviteEvents';
import {
  sharedWorktreeKey,
  useSharedContainersStore,
} from '@/stores/sharedContainersStore';
import { withSelectionGroupItems } from '@canopy/ui-app';
import {
  ArchivedContainersNavLink,
  DEFAULT_MENU_ROW_STYLE,
  DropdownMenuRowStyleProvider,
  QUIET_MENU_ROW_STYLE,
  useContextMenuPlacement,
} from '@canopy/ui-shared';
import { openArchivedOverviewSurface } from '@/lib/archivedContainerNavigation';
import {
  ARCHIVE_TOOLTIP,
  deleteRetentionTooltip,
  type WorkEntryRemovalMode,
} from '@canopy/ui-app/sidebar';
import { WorkEntryRemovalConfirmDialog } from '../standalone-chat/WorkEntryRemovalConfirmDialog';
import {
  selectWorktreeHasLiveDelegates,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  removalBlockedReason,
  recheckWorktreeRemovalBlockedReason,
} from '@/stores/chat/close-guard';
import {
  selectWorktreeProviderBlocksClose,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';
import {
  scheduleStickyCollapseScrollAdjust,
  SidebarNoneFoundRow,
  CodeSidebarItemGroups,
  buildSidebarItemGroupBlocks,
  capSidebarItemGroupBlocks,
  WorktreeSortableStateContext,
  workEntryRecencyMs,
  resolveSidebarSortMode,
  type CodeSidebarItemGroupCommands,
  type SidebarItemGroupBlock,
  SidebarSelectionRowsReporter,
  workEntryRowKey,
  workEntryRowMultiSelectProps,
  type SidebarSelectionRow,
  type WorkEntryMultiSelectBinding,
} from '@canopy/ui-app/sidebar';
import { useStickyWorkspaceSlotHost } from '@canopy/ui-app/sidebar';
import {
  findChatsSelectedPinHosts,
  findSelectedPinHosts,
  type ChatsSelectedPinHosts,
  type SelectedPinHosts,
  type SelectedPinSeat,
} from '@canopy/ui-app/sidebar';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { openImportSessionModal } from '@/stores/importSessionModalStore';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

const EMPTY_ITEM_GROUPS: GroupData[] = [];
const EMPTY_WORK_ENTRIES: CoworkWorkEntryMeta[] = [];
const EMPTY_LEGACY_ARCHIVED: StandaloneChatMeta[] = [];
const NO_MUTED_ENTRIES: ReadonlySet<string> = new Set();

/**
 * Whether a Work Entry's acknowledged notification choice is Mute. A muted
 * entry hides its blue unread dot, on its row and in its group's rollup, while
 * its chats keep their unread state (CAN-4378).
 */
function isWorkEntrySpaceMuted(
  state: Pick<SpaceNotificationStore, 'snapshot' | 'progress'>,
  workspaceId: string,
  entryId: string,
): boolean {
  return isSpaceNotificationMuted(
    spaceNotificationMenuStateFor(state, {
      projectId: workspaceId,
      worktreeId: entryId,
    }),
  );
}

/** Collapsed groups retain the live status of every member, including hidden rows. */
function CoworkGroupStatus({
  workspaceId,
  entries,
}: {
  workspaceId: string;
  entries: readonly CoworkWorkEntryMeta[];
}): JSX.Element | null {
  const streaming = useChatStore((state) =>
    entries.some((entry) => {
      const live = state.worktreeChats[`${workspaceId}/${entry.id}`];
      return live
        ? live.tabs.some(
            (tab) => tab.status === 'streaming' && !tab.pendingPlanExit,
          )
        : entry.hasActiveChat === true;
    }),
  );
  const backgroundCounts = useBackgroundTaskCounts(
    workspaceId,
    entries.map((entry) => entry.id),
  );
  const backgroundTasks = entries.reduce(
    (total, entry) => total + (backgroundCounts[entry.id] ?? 0),
    0,
  );
  const notificationControlsEnabled = useSpaceNotificationControlsEnabled();
  // Scalar selector: the muted members' ids, joined, so an unrelated save
  // does not re-render the group.
  const mutedEntryIds = useSpaceNotificationStore((state) =>
    notificationControlsEnabled
      ? entries
          .filter((entry) =>
            isWorkEntrySpaceMuted(state, workspaceId, entry.id),
          )
          .map((entry) => entry.id)
          .join('\n')
      : '',
  );
  const mutedEntries = useMemo(
    () =>
      mutedEntryIds === ''
        ? NO_MUTED_ENTRIES
        : new Set(mutedEntryIds.split('\n')),
    [mutedEntryIds],
  );
  const unread = useChatStore((state) =>
    entries.some((entry) => {
      if (mutedEntries.has(entry.id)) return false;
      const live = state.worktreeChats[`${workspaceId}/${entry.id}`];
      return live?.tabs.length
        ? live.tabs.some((tab) => tab.unread === true)
        : (entry.unreadChats?.length ?? 0) > 0;
    }),
  );
  if (streaming)
    return (
      <span aria-label="Active work in group">
        <LoadingSpinner sizePx={14} decorative />
      </span>
    );
  // Unread outranks background work: a long-running server would hide it.
  if (unread) return <Dot tone="unread" label="Unread work in group" />;
  return backgroundTasks > 0 ? (
    <AgentStateGlyph state="background" backgroundTasks={backgroundTasks} />
  ) : null;
}

/**
 * Snapshot the unread chats behind a work entry's blue badge into popover
 * preview rows. Read non-reactively on hover: live tab state when the entry's
 * chats are hydrated in the chat store, else the list-derived
 * `entry.unreadChats` refs (which carry title/provider/preview main-side).
 */
export function buildWorkEntryUnreadRows(
  entryKey: string,
  entry: CoworkWorkEntryMeta,
): ChatPreviewRow[] {
  const worktreeChat = useChatStore.getState().worktreeChats[entryKey];
  if (worktreeChat && worktreeChat.tabs.length > 0) {
    return worktreeChat.tabs
      .filter((tab) => tab.unread === true)
      .map((tab) => {
        const trimmedTitle = tab.title?.trim();
        return {
          chatId: tab.id,
          title:
            trimmedTitle && trimmedTitle.length > 0
              ? trimmedTitle
              : `New ${CHAT_UNIT_LABEL}`,
          providerType: tab.providerType,
          preview: getChatTabAgentResponsePreview(tab),
          ...(tab.unreadMarkedManually === true ? { markedUnread: true } : {}),
        };
      });
  }
  return (entry.unreadChats ?? []).map((ref) => {
    const trimmedTitle = ref.title?.trim();
    return {
      chatId: ref.chatId,
      title:
        trimmedTitle && trimmedTitle.length > 0
          ? trimmedTitle
          : `New ${CHAT_UNIT_LABEL}`,
      providerType: ref.providerType,
      preview: ref.preview,
      ...(ref.markedUnread === true ? { markedUnread: true } : {}),
    };
  });
}

interface SidebarWorkEntryRowProps {
  groupMenu?: readonly WorktreeMenuItem[];
  membershipDragEnabled?: boolean;
  /** Owning cowork workspace id — keys the entry's chats in the chat store. */
  workspaceId: string;
  entry: CoworkWorkEntryMeta;
  onSelect: (entryId: string) => void;
  onRename: (entryId: string, title: string | null) => void;
  /**
   * Remove the entry into the workspace's retained containers: `delete`
   * keeps it for the retention window, `archive` keeps it until deleted.
   */
  /** Settles once the removal finished or failed (failures are swallowed). */
  onDelete: (
    entryId: string,
    options: { mode: WorkEntryRemovalMode },
  ) => Promise<void>;
  /**
   * Toggles the entry's user-driven completion flag. Cowork has no PR-merge
   * signal, so this is the only "finished" marker an entry carries.
   */
  onSetStatus: (entryId: string, status: 'active' | 'done') => void;
  /** Pins/unpins the entry to the top of its workspace section (CAN-1074). */
  onSetPinned?: (entryId: string, pinned: boolean) => void;
  /**
   * Owning workspace's ordering mode. Drives whether an unpinned row may be
   * dragged; pinned rows stay draggable in either mode.
   */
  sortMode?: SidebarSortMode;
  deleting: boolean;
  /**
   * Effective deletion-retention window (via `resolveArchiveRetentionDays`):
   * how long a deleted entry is kept before it is removed. Drives the Delete
   * tooltip and confirmation copy.
   */
  effectiveRetentionDays: number;
  /**
   * Renders this row as a pinned selected-item copy (sticky band / bottom
   * pin surface). The copy never registers with a sortable context, suffixes
   * its automation ids, and never carries the selected-item measurement mark.
   */
  pinnedSurface?: 'pin-top' | 'pin-bottom';
  /** Disable sticky copies for the grouped top-level Chats surface. */
  disableSelectedPin?: boolean;
  /**
   * Where the sticky selected-item pin seats this row's copy. Omitted for a
   * project row (below the Projects band, under its workspace header); the
   * header-less Chats row seats under the sticky Chats header instead, since
   * the Projects band sits below that header (see sticky-selected-item.ts).
   */
  selectedPinSeat?: SelectedPinSeat;
  /**
   * The rail's bulk selection (CAN-3975); absent where the host wired no
   * Work Entry removal. A pinned copy never takes it.
   */
  workEntryMultiSelect?: WorkEntryMultiSelectBinding;
}

interface SidebarWorkEntryUnreadPreviewProps {
  anchorRect: DOMRect;
  /** Reads the rows once, when the preview opens. */
  readRows: () => ChatPreviewRow[];
}

/**
 * The unread-chats popover behind a Work Entry's blue dot. It mounts when the
 * dot is hovered or focused and unmounts when the pointer leaves the row, so
 * its rows are a snapshot taken on activation (never a subscription) and the
 * row does not re-render on streaming chat updates.
 */
function SidebarWorkEntryUnreadPreview({
  anchorRect,
  readRows,
}: SidebarWorkEntryUnreadPreviewProps): JSX.Element {
  // Read once on mount: a background list refresh that replaces the entry
  // must not rewrite the preview under the pointer.
  const [rows] = useState(readRows);
  return (
    <ChatPreviewPopover
      anchorRect={anchorRect}
      rows={rows}
      heading={`Unread ${CHAT_UNIT_LABEL_PLURAL}`}
    />
  );
}

/**
 * A Work Entry's menu surface: the shared `FloatingMenu` under the ••• button
 * or, for a right-click, at the pointer. Opening leaves focus on the trigger,
 * as every desktop row menu does; the arrow keys move into the rows.
 */
function SidebarWorkEntryMenuSurface({
  menu,
  children,
}: {
  menu: WorkEntryRowMenuRenderProps;
  children: ReactNode;
}): JSX.Element {
  const pointAnchorRef = useRef<HTMLSpanElement>(null);
  // Early access: quieter rows (small text, tertiary icons).
  const contextMenuPlacement = useContextMenuPlacement();
  const point = menu.anchorPoint;
  return (
    <>
      {menu.open && point !== null ? (
        <FloatingMenuPointAnchor
          ref={pointAnchorRef}
          x={point.x}
          y={point.y}
          ownerDocument={menu.anchorRef.current?.ownerDocument ?? document}
        />
      ) : null}
      <FloatingMenu
        open={menu.open}
        onOpenChange={(open): void => {
          if (!open) menu.close();
        }}
        anchorRef={point !== null ? pointAnchorRef : menu.anchorRef}
        {...(point !== null
          ? { anchorPoint: point, closeOnWindowChange: true }
          : {})}
        returnFocusRef={menu.anchorRef}
        placement="bottom-left"
        interaction="menu"
        focusOnOpen={false}
        motion="none"
        // Sized to the widest label instead of a fixed w-40, which wrapped
        // longer actions such as "Invite a teammate" onto a second line
        // inside the fixed-height rows. w-40 stays as the floor.
        className="sidebar-instant-interactions w-45"
        data-testid={menu.popoverTestId}
      >
        <DropdownMenuRowStyleProvider
          value={
            contextMenuPlacement === 'cursor'
              ? QUIET_MENU_ROW_STYLE
              : DEFAULT_MENU_ROW_STYLE
          }
        >
          {children}
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}

/**
 * The Work Entry menu rows plus this entry's notification choices
 * (CAN-3615). Mounted only while the menu is open, so the store subscription
 * and the refresh on open cost nothing for closed rows.
 */
function SidebarWorkEntryMenuItems({
  workspaceId,
  entryId,
  ...props
}: WorkEntryRowMenuItemsProps & {
  workspaceId: string;
  entryId: string;
}): JSX.Element {
  const controlsEnabled = useSpaceNotificationControlsEnabled();
  const snapshot = useSpaceNotificationStore((s) => s.snapshot);
  const progress = useSpaceNotificationStore((s) => s.progress);
  // Signed-out and guest sessions have no saved choices to show or change.
  const enabled = controlsEnabled && snapshot.accountKey !== null;
  const scope = useMemo(
    () => ({ projectId: workspaceId, worktreeId: entryId }),
    [workspaceId, entryId],
  );
  useEffect(() => {
    if (enabled) void useSpaceNotificationStore.getState().refresh(scope);
  }, [enabled, scope]);
  const notifications = useMemo(
    () =>
      enabled
        ? spaceNotificationMenuStateFor({ snapshot, progress }, scope)
        : undefined,
    [enabled, snapshot, progress, scope],
  );
  return (
    <WorkEntryRowMenuItems
      {...props}
      notifications={notifications}
      onNotificationChoice={
        enabled
          ? (choice): void => {
              void useSpaceNotificationStore
                .getState()
                .setChoice(scope, choice);
            }
          : undefined
      }
    />
  );
}

/**
 * One Work Entry row, rendered by the shared `WorkEntryRow` (CAN-3053). This
 * host owns everything the shared row cannot: the store-derived status, the
 * sortable binding, the menu commands and the rename, removal and invite
 * dialogs. The menu surface (`SidebarWorkEntryMenuSurface`) leaves focus on
 * the ••• trigger like every other desktop row menu.
 */
function SidebarWorkEntryRowContent({
  workspaceId,
  entry,
  onSelect,
  onRename,
  onDelete,
  onSetStatus,
  onSetPinned,
  deleting,
  effectiveRetentionDays,
  pinnedSurface,
  disableSelectedPin,
  selectedPinSeat,
  groupMenu,
  sortMode,
  membershipDragEnabled,
  workEntryMultiSelect,
}: SidebarWorkEntryRowProps): JSX.Element {
  const autoDelete = useSidebarAutoDelete({
    workspaceId,
    targetId: entry.id,
    name: entry.title,
  });
  const selectedWorkEntry = useStandaloneChatStore(
    (s) =>
      s.activeChatProjectId === workspaceId && s.activeWorkEntryId === entry.id,
  );
  const selected = useNavigationStore((s) => s.activePage === 'chat')
    ? selectedWorkEntry
    : false;
  const isPinnedCopy = pinnedSurface !== undefined;
  const rowTestId = `sidebar-work-entry-${entry.id}`;
  const selectionBinding = isPinnedCopy ? undefined : workEntryMultiSelect;
  const selectionKey = workEntryRowKey(workspaceId, entry.id);
  const batchRemoving = selectionBinding?.isRemoving(selectionKey) === true;
  const multiSelect = useMemo(
    () =>
      selectionBinding === undefined
        ? undefined
        : workEntryRowMultiSelectProps(
            selectionBinding,
            workspaceId,
            selectionKey,
            selectionBinding.isSelectable(workspaceId) && !deleting,
          ),
    [selectionBinding, workspaceId, selectionKey, deleting],
  );
  // Early access moves the row's status to a leading dot and shows its
  // last-activity age on the right: the watermark the Last updated sort uses.
  const earlyAccess = useLabsExperimentEnabled('sidebar');
  const deleteTitle = deleteRetentionTooltip(effectiveRetentionDays);
  const [renaming, setRenaming] = useState(false);
  const [invitingTeammate, setInvitingTeammate] = useState(false);
  const sharedContainerInviteVisible = useSharedContainerEntryPointVisible();
  // Cowork chats key as `(workspaceId, workEntryId)`, the same pair code
  // worktrees use, so the shared-container lookup reuses the same key helper.
  // Scalar selector: never returns a fresh object into a long sidebar list.
  const isSharedWithTeammates = useSharedContainersStore((s) =>
    Boolean(s.sharedWorktrees[sharedWorktreeKey(workspaceId, entry.id)]),
  );
  const showSharedBadge = sharedContainerInviteVisible && isSharedWithTeammates;
  useEffect(() => {
    if (isPinnedCopy || !sharedContainerInviteVisible) return;
    const matchesThisRow = (request: {
      projectId: string;
      worktreeId: string;
      containerType: string;
    }): boolean =>
      request.projectId === workspaceId &&
      request.worktreeId === entry.id &&
      request.containerType === 'COWORK_WORK_ENTRY';
    return subscribeToSharedContainerInviteRequests(
      (request) => {
        if (!matchesThisRow(request)) return false;
        setInvitingTeammate(true);
        return true;
      },
      (request) => {
        if (!matchesThisRow(request)) setInvitingTeammate(false);
      },
    );
  }, [entry.id, isPinnedCopy, sharedContainerInviteVisible, workspaceId]);
  const [confirmingRemoval, setConfirmingRemoval] =
    useState<WorkEntryRemovalMode | null>(null);
  // The confirmation stays open, busy, until the removal settles: a removed
  // entry unmounts with its row, and a failed one closes the dialog.
  const [removalRequested, setRemovalRequested] = useState(false);
  const [isRecheckingRemoval, setIsRecheckingRemoval] = useState(false);
  const [removalCheckReason, setRemovalCheckReason] = useState<string>();
  // Bumped whenever a pending confirmation stops being current (cancel,
  // dismiss, a new confirmation, unmount), so a slow re-check cannot remove.
  const removalAttemptRef = useRef(0);
  useEffect(
    () => (): void => {
      removalAttemptRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (confirmingRemoval === null) return;
    void useLiveBackgroundTaskStore
      .getState()
      .ensureWorktreesHydrated([
        { projectId: workspaceId, worktreeId: entry.id },
      ]);
  }, [confirmingRemoval, entry.id, workspaceId]);

  const entryKey = `${workspaceId}/${entry.id}`;
  // Live tab state wins for entries hydrated in the chat store (visited this
  // session): streaming flips instantly and unread clears the moment the
  // chat is viewed. Unhydrated entries fall back to the list-derived meta,
  // refreshed by the main-side write nudge.
  const liveStreaming = useChatSidebarStore((s) => {
    const worktreeChat = s.worktrees[entryKey];
    if (!worktreeChat) return undefined;
    return worktreeChat.tabs.some(
      (tab) => tab.status === 'streaming' && !tab.pendingPlanExit,
    );
  });
  const liveUnread = useChatSidebarStore((s) => {
    const worktreeChat = s.worktrees[entryKey];
    if (!worktreeChat || worktreeChat.tabs.length === 0) return undefined;
    return worktreeChat.tabs.some((tab) => tab.unread === true);
  });
  // An unanswered interactive agent question (ask-user prompt) is
  // user-actionable, so it outranks the unread dot with the same orange dot
  // code worktree rows use. Cowork chats key as `(workspaceId, workEntryId)`,
  // so the question's worktreeId slot holds the entry id.
  const hasPendingQuestion = useChatSidebarStore((s) =>
    Object.values(s.pendingQuestions).some(
      (q) =>
        q.answeredAt === undefined &&
        q.projectId === workspaceId &&
        q.worktreeId === entry.id,
    ),
  );
  // A chat in this entry with live managed delegates keeps the entry working
  // (and unremovable) even after its own turn ended. Cowork chats key as
  // `(workspaceId, workEntryId)`.
  const hasLiveDelegates = useDelegationActivityStore((state) =>
    selectWorktreeHasLiveDelegates(state, workspaceId, entry.id),
  );
  const hasLiveProviderWork = useLiveBackgroundTaskStore((state) =>
    selectWorktreeProviderBlocksClose(state, workspaceId, entry.id),
  );
  // A running turn draws the Working spinner; delegates and provider tasks
  // alone draw the background one (turn-state D15).
  const isThinking = liveStreaming ?? entry.hasActiveChat ?? false;
  const backgroundTasks =
    useBackgroundTaskCounts(workspaceId, [entry.id])[entry.id] ?? 0;
  const removalDisabledReason = removalBlockedReason(
    hasLiveDelegates ? 'delegates' : hasLiveProviderWork ? 'background' : null,
  );
  useEffect(() => {
    if (removalDisabledReason === undefined) setRemovalCheckReason(undefined);
  }, [removalDisabledReason]);
  const notificationControlsEnabled = useSpaceNotificationControlsEnabled();
  const spaceMuted = useSpaceNotificationStore(
    (state) =>
      notificationControlsEnabled &&
      isWorkEntrySpaceMuted(state, workspaceId, entry.id),
  );
  const hasUnread =
    !spaceMuted && (liveUnread ?? (entry.unreadChats?.length ?? 0) > 0);
  const isDone = entry.status === 'done';

  const groupedDrag = useContext(WorktreeSortableStateContext);
  const drag = useMemo((): WorkEntryRowDragBinding | undefined => {
    if (
      !groupedDrag ||
      isPinnedCopy ||
      !(
        membershipDragEnabled ||
        canDragSidebarRow(sortMode, entry.pinned === true)
      )
    )
      return undefined;
    return {
      attributes: groupedDrag.attributes,
      onPointerDown: (event): void => {
        groupedDrag.listeners?.onPointerDown?.(event);
      },
      isDragging: groupedDrag.isDragging,
    };
  }, [
    groupedDrag,
    isPinnedCopy,
    sortMode,
    entry.pinned,
    membershipDragEnabled,
  ]);

  const handleOpen = useCallback((): void => {
    onSelect(entry.id);
  }, [onSelect, entry.id]);
  const handleIntent = useCallback(
    (phase: 'start' | 'end', source: 'pointer' | 'focus'): void => {
      const target: ChatPrefetchTarget = {
        kind: 'worktree',
        projectId: workspaceId,
        worktreeId: entry.id,
        attentionLanding: true,
      };
      if (phase === 'start') noteChatIntent(target, source);
      else endChatIntent(target);
    },
    [workspaceId, entry.id],
  );
  const beginRemovalConfirmation = useCallback(
    (mode: WorkEntryRemovalMode): void => {
      removalAttemptRef.current += 1;
      setRemovalCheckReason(undefined);
      setRemovalRequested(false);
      setConfirmingRemoval(mode);
    },
    [],
  );
  const cancelRemovalConfirmation = useCallback((): void => {
    removalAttemptRef.current += 1;
    setConfirmingRemoval(null);
  }, []);
  const handleDeleteButton = useCallback(
    (): void => beginRemovalConfirmation('delete'),
    [beginRemovalConfirmation],
  );
  const handleArchiveButton = useCallback(
    (): void => beginRemovalConfirmation('archive'),
    [beginRemovalConfirmation],
  );
  const handleConfirmRemoval = useCallback(async (): Promise<void> => {
    if (confirmingRemoval === null || removalRequested || deleting) return;
    removalAttemptRef.current += 1;
    const attempt = removalAttemptRef.current;
    setIsRecheckingRemoval(true);
    setRemovalCheckReason(undefined);
    try {
      const reason = await recheckWorktreeRemovalBlockedReason([
        { projectId: workspaceId, worktreeId: entry.id },
      ]);
      if (attempt !== removalAttemptRef.current) return;
      if (reason !== undefined) {
        setRemovalCheckReason(reason);
        return;
      }
      setRemovalRequested(true);
      setIsRecheckingRemoval(false);
      await onDelete(entry.id, { mode: confirmingRemoval });
      // A removed entry has unmounted with its row by now; a failed one
      // closes the dialog unless the user already started another attempt.
      if (attempt !== removalAttemptRef.current) return;
      setRemovalRequested(false);
      setConfirmingRemoval(null);
    } finally {
      setIsRecheckingRemoval(false);
    }
  }, [
    confirmingRemoval,
    deleting,
    entry.id,
    onDelete,
    removalRequested,
    workspaceId,
  ]);
  const handleTogglePinButton = useMemo(
    () =>
      onSetPinned === undefined
        ? undefined
        : (pinned: boolean): void => onSetPinned(entry.id, pinned),
    [onSetPinned, entry.id],
  );

  const entryPinned = entry.pinned === true;
  const renderMenu = useCallback(
    (menu: WorkEntryRowMenuRenderProps): JSX.Element => {
      // Built only while open: a closed menu reads no selection state.
      const selectionMenu =
        menu.open && selectionBinding !== undefined
          ? selectionBinding.menuItemsFor(selectionKey, {
              bulkPin: `${rowTestId}-bulk-pin`,
              bulkArchive: `${rowTestId}-bulk-archive`,
              bulkDelete: `${rowTestId}-bulk-delete`,
            })
          : undefined;
      const selectionItems = selectionMenu?.items ?? [];
      const runSelectionItem = (action: WorktreeMenuItem): void => {
        if (action.role !== 'menuitemradio') menu.close();
        action.onSelect?.();
      };
      return (
        <SidebarWorkEntryMenuSurface menu={menu}>
          {selectionMenu?.replacesMenu === true ? (
            <ActionMenuRowStyle>
              <WorktreeActionMenuItems
                // The selection's group moves sit after its Pin row, as the
                // row's own group items do.
                items={withSelectionGroupItems(
                  selectionItems,
                  groupMenu && !isPinnedCopy ? groupMenu : [],
                )}
                onSelect={runSelectionItem}
              />
            </ActionMenuRowStyle>
          ) : (
            <SidebarWorkEntryMenuItems
              autoDelete={autoDelete.autoDelete}
              onAutoDeleteDisarm={autoDelete.onAutoDeleteDisarm}
              workspaceId={workspaceId}
              entryId={entry.id}
              menu={menu}
              afterPin={
                groupMenu && !isPinnedCopy ? (
                  <WorktreeActionMenuItems
                    items={groupMenu}
                    onSelect={(action): void => {
                      menu.close();
                      action.onSelect?.();
                    }}
                  />
                ) : undefined
              }
              pinned={entryPinned}
              onTogglePin={
                onSetPinned === undefined
                  ? undefined
                  : (pinned): void => onSetPinned(entry.id, pinned)
              }
              onRename={(): void => {
                setRenaming(true);
              }}
              done={isDone}
              onToggleDone={(status): void => onSetStatus(entry.id, status)}
              onShare={
                sharedContainerInviteVisible
                  ? (): void => setInvitingTeammate(true)
                  : undefined
              }
              onArchive={handleArchiveButton}
              archiveTitle={ARCHIVE_TOOLTIP}
              onDelete={handleDeleteButton}
              deleteTitle={deleteTitle}
              removalDisabledReason={removalDisabledReason}
              beforeRemoval={
                selectionItems.length > 0 ? (
                  <WorktreeActionMenuItems
                    items={selectionItems}
                    onSelect={runSelectionItem}
                  />
                ) : undefined
              }
            />
          )}
        </SidebarWorkEntryMenuSurface>
      );
    },
    [
      autoDelete.autoDelete,
      autoDelete.onAutoDeleteDisarm,
      groupMenu,
      isPinnedCopy,
      workspaceId,
      entryPinned,
      onSetPinned,
      entry.id,
      isDone,
      onSetStatus,
      sharedContainerInviteVisible,
      deleteTitle,
      removalDisabledReason,
      selectionBinding,
      selectionKey,
      rowTestId,
      handleArchiveButton,
      handleDeleteButton,
    ],
  );
  // The preview reads the latest entry once, when it opens, so the row's
  // slot does not change identity (and re-render the memoized row) every
  // time a list refresh hands this host a new entry object.
  const latestEntryRef = useRef(entry);
  useEffect(() => {
    latestEntryRef.current = entry;
  }, [entry]);
  const readUnreadRows = useCallback(
    (): ChatPreviewRow[] =>
      buildWorkEntryUnreadRows(entryKey, latestEntryRef.current),
    [entryKey],
  );
  const renderUnreadPreview = useCallback(
    (anchorRect: DOMRect): JSX.Element => (
      <SidebarWorkEntryUnreadPreview
        anchorRect={anchorRect}
        readRows={readUnreadRows}
      />
    ),
    [readUnreadRows],
  );

  const commitRename = useCallback(
    (value: string): void => {
      const trimmed = value.trim();
      setRenaming(false);
      if (trimmed === entry.title) {
        return;
      }
      // An emptied title clears the rename override (falls back to the
      // chat-derived title).
      onRename(entry.id, trimmed.length > 0 ? trimmed : null);
    },
    [entry.id, entry.title, onRename],
  );

  return (
    <>
      <WorkEntryRow
        {...autoDelete}
        title={entry.title}
        testId={rowTestId}
        entryId={entry.id}
        status={isDone ? 'done' : 'active'}
        statusPlacement={earlyAccess ? 'leading' : 'trailing'}
        selected={selected}
        working={isThinking}
        backgroundTasks={backgroundTasks}
        hasPendingQuestion={hasPendingQuestion}
        hasUnread={hasUnread}
        sharedWithTeammates={showSharedBadge}
        pinnedToTop={entryPinned}
        lastActivityAt={earlyAccess ? workEntryRecencyMs(entry) : undefined}
        pinnedSurface={pinnedSurface}
        selectedPinSeat={selectedPinSeat}
        disableSelectedPin={disableSelectedPin === true}
        removing={deleting || batchRemoving}
        multiSelect={multiSelect}
        drag={drag}
        onOpen={handleOpen}
        onIntent={deleting ? undefined : handleIntent}
        onDelete={handleDeleteButton}
        deleteDisabledReason={removalDisabledReason}
        // Early access: hover offers Pin and Archive (as focused worktree
        // rows do); Delete and the rest stay in the right-click menu.
        hoverActions={earlyAccess ? 'compact' : 'classic'}
        onTogglePin={handleTogglePinButton}
        onArchive={handleArchiveButton}
        archiveDisabledReason={removalDisabledReason}
        renderMenu={renderMenu}
        renderUnreadPreview={renderUnreadPreview}
      />
      {invitingTeammate && (
        <InviteTeammateModal
          projectId={workspaceId}
          worktreeId={entry.id}
          containerType="COWORK_WORK_ENTRY"
          containerName={entry.title}
          onClose={() => {
            setInvitingTeammate(false);
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          title={`Rename ${CHAT_UNIT_LABEL.toLowerCase()}`}
          label="Name"
          initialValue={entry.title}
          submitLabel="Rename"
          onSubmit={commitRename}
          onClose={() => setRenaming(false)}
          titleId={`rename-work-entry-${entry.id}-title`}
          inputId={`rename-work-entry-${entry.id}`}
          dataTestId={`sidebar-work-entry-${entry.id}-rename-dialog`}
          inputTestId={workEntryRowTestId(
            rowTestId,
            '-rename-input',
            pinnedSurface,
          )}
        />
      )}
      {confirmingRemoval !== null && (
        <WorkEntryRemovalConfirmDialog
          mode={confirmingRemoval}
          entryTitle={entry.title}
          retentionDays={effectiveRetentionDays}
          rowTestId={rowTestId}
          pinnedSurface={pinnedSurface}
          busy={removalRequested || deleting}
          blockedReason={removalDisabledReason ?? removalCheckReason}
          // The re-check disables the action but keeps Cancel live, so the
          // user can still back out while it runs.
          confirmDisabled={isRecheckingRemoval}
          onCancel={cancelRemovalConfirmation}
          onConfirm={() => void handleConfirmRemoval()}
        />
      )}
    </>
  );
}

// Only the shared group renderer registers entry drags. Sticky copies are inert.
const SidebarWorkEntryRow = memo(SidebarWorkEntryRowContent);

export interface SidebarCoworkWorkspaceRowProps {
  /** Cowork workspace to render as a work-entry-list row in the unified sidebar. */
  item: CoworkSidebarItem;
  /** Adds the expanded-row separation only when another workspace follows. */
  hasFollowingWorkspace?: boolean;
  /** Omits the redundant group row when this is the only workspace. */
  hideWorkspaceHeader?: boolean;
  /**
   * Collapse owned by a section header outside this row, for a row rendered
   * with `hideWorkspaceHeader` (the Chats section). Collapsed, the row keeps
   * only its selected entry, as it does under its own collapsed header.
   */
  sectionCollapsed?: boolean;
  /**
   * Disables the drag handle, matching `ProjectSection`'s usage for the
   * "Hidden Projects" group (those rows are not reorderable there).
   */
  disableDrag?: boolean;
  /** Uses the parent workspace DnD state to dim the authoritative header. */
  workspaceDragActive?: boolean;
  /** Static insertion marker owned by the parent workspace DnD context. */
  workspaceDropIndicatorPosition?: 'before' | 'after' | null;
  /**
   * Marks this row as the onboarding sidebar tour's "Chat" stop. The
   * `sidebar-chat` anchor lived on the retired `SidebarCoworkSection`
   * header; in the blended list exactly one cowork row (the first visible
   * one) must carry it so the tour popover and its Electron coverage
   * (`onboarding-tour-anchors.spec.mjs`) can resolve a unique element.
   */
  isTourAnchor?: boolean;
  /**
   * Caps the entry list, revealing the rest behind a "Show all" toggle. The
   * Chats section sits above the project list, so it shows only the most
   * recent few by default (CAN-2363).
   */
  maxEntries?: number;
  /**
   * Renders the row outside the sidebar's workspace list, so it advertises
   * neither `data-workspace-expanded` nor `data-sidebar-workspace-id`. The
   * Chats section sits above the Projects list and is not a project, so it
   * must stay out of the workspace counts, sticky slots, and pin measurement
   * that key off those marks (CAN-2363).
   */
  excludeFromWorkspaceList?: boolean;
  /**
   * Seats this workspace's selected-row pin somewhere other than the Projects
   * band. The Chats section passes `'chats'`: its rows have no workspace
   * header, and the sticky Chats header they belong to sits ABOVE the band,
   * so the copy seats under that header instead.
   */
  selectedPinSeat?: SelectedPinSeat;
  /**
   * Lists one `None found` row while the workspace has nothing to show, the
   * row an empty Projects list shows. The Chats section sets it in an
   * organization, where both sections read the same when empty (CAN-3550).
   */
  listsNoneFoundWhenEmpty?: boolean;
  /**
   * Opens the Move to organization dialog for this project. The host passes
   * it only for a Personal Cowork project that can move, and keeps the
   * reference stable so the memoized row does not re-render.
   */
  onMoveToOrganizationRequested?: (workspaceId: string) => void;
  /**
   * The rail's bulk selection for this workspace's Work Entry rows
   * (CAN-3975); absent where the host wired no Work Entry removal.
   */
  workEntryMultiSelect?: WorkEntryMultiSelectBinding;
}

/**
 * Work Entry list row for a single Cowork workspace, rendered inline in the
 * unified `SidebarWorkspacesSection` list alongside git `ProjectSection`
 * rows. Lists the workspace's Work Entries flat in recency order (the list
 * IPC orders by `lastMessageAt ?? createdAt` desc — no date group headers),
 * with a legacy read-only "Archived" subgroup, a new-work-entry button, and
 * settings popovers. Each cowork workspace participates in the same
 * drag-reorder `SortableContext` as git workspaces (mixed-type ordering
 * lives in a single `order` domain in `workspaces/index.json`).
 */
function SidebarCoworkWorkspaceRowImpl({
  item,
  hasFollowingWorkspace,
  hideWorkspaceHeader,
  sectionCollapsed,
  disableDrag,
  workspaceDragActive,
  workspaceDropIndicatorPosition,
  isTourAnchor,
  selectedPinSeat,
  maxEntries,
  excludeFromWorkspaceList,
  listsNoneFoundWhenEmpty = false,
  onMoveToOrganizationRequested,
  workEntryMultiSelect,
}: SidebarCoworkWorkspaceRowProps): JSX.Element {
  const [showAllEntries, setShowAllEntries] = useState(false);
  // Early access: the list disclosure reads More / Less, with no count, and
  // rows inside a group keep 1px between them like every other row.
  const compactDisclosure = useLabsExperimentEnabled('sidebar');
  const activePage = useNavigationStore((s) => s.activePage);
  const navigate = useNavigationStore((s) => s.navigate);
  const openWorkspaceSettingsModal = useNavigationStore(
    (s) => s.openWorkspaceSettingsModal,
  );

  const activeChatProjectId = useStandaloneChatStore(
    (s) => s.activeChatProjectId,
  );
  const isActive = item.id === activeChatProjectId;
  const activeWorkEntryId = useStandaloneChatStore((s) => s.activeWorkEntryId);
  const archiveOverlayChatId = useStandaloneChatStore(
    (s) => s.archiveOverlayChatId,
  );
  // Cowork rows share the same persisted workspace-index `collapsed` field
  // and save path as code workspaces. Keeping this on the sidebar item means
  // the state is restored by projectsStore after a renderer reload/restart.
  // Without its own header the row follows the section that heads it.
  const expanded =
    hideWorkspaceHeader === true ? sectionCollapsed !== true : !item.collapsed;
  const toggleCollapsed = useProjectsStore((s) => s.toggleCollapsed);
  const loadSidebarProjectEntries = useStandaloneChatStore(
    (s) => s.loadSidebarProjectEntries,
  );
  const renameWorkEntry = useStandaloneChatStore((s) => s.renameWorkEntry);
  const setWorkEntryPinned = useStandaloneChatStore(
    (s) => s.setWorkEntryPinned,
  );
  const setWorkspacePinned = useProjectsStore(
    (state) => state.setWorkspacePinned,
  );
  const setWorkspaceItemSortMode = useProjectsStore(
    (state) => state.setWorkspaceItemSortMode,
  );
  const setWorkEntryStatus = useStandaloneChatStore(
    (s) => s.setWorkEntryStatus,
  );
  const reorderWorkEntries = useStandaloneChatStore(
    (s) => s.reorderWorkEntries,
  );
  const deleteWorkEntry = useStandaloneChatStore((s) => s.deleteWorkEntry);
  const loadLegacyArchivedChats = useStandaloneChatStore(
    (s) => s.loadLegacyArchivedChats,
  );

  // The active project's live Work Entry list when this row IS the active
  // project, otherwise its lazily loaded sidebar snapshot. Returns a stable
  // reference when unrelated projects change, so inactive rows don't
  // re-render on every store update. Absent-key fallbacks MUST be the
  // module-level EMPTY constants (a fresh [] per snapshot infinite-loops
  // React's useSyncExternalStore).
  const storedWorkEntries = useStandaloneChatStore((s) =>
    isActive
      ? s.workEntries
      : (s.sidebarEntriesByProject[item.id] ?? EMPTY_WORK_ENTRIES),
  );
  const storedSidebarEntriesLoaded = useStandaloneChatStore(
    (s) => s.sidebarEntriesByProject[item.id] !== undefined,
  );
  // Empty tasks stay out of the list, except the one open on the chat page: a
  // task made with "+" shows right away, like a new code task does. That also
  // covers an empty task a project switch opened, and the row drops out again
  // once the user leaves the chat page or opens a sibling task.
  const isActiveOnChatPage = isActive && activePage === 'chat';
  const openEmptyEntryId = isActiveOnChatPage ? activeWorkEntryId : null;
  // CAN-1074: pinned entries lead, then the tail follows the workspace's sort
  // mode. Ordering happens before capping so a capped section (the Chats
  // section's top rows) shows the head of the chosen order. New entries are
  // prepended to the persisted manual order, so they stay visible under the
  // cap in the default manual mode too.
  const entrySortMode = resolveSidebarSortMode(item.itemSortMode);
  const scope = useMemo(() => ({ workspaceLocalId: item.id }), [item.id]);
  const scopeKey = sidebarItemGroupScopeKey(scope);
  const itemGroups = useSidebarItemGroupsStore(
    (state) => state.byScope[scopeKey] ?? EMPTY_ITEM_GROUPS,
  );
  useEffect(() => {
    void useSidebarItemGroupsStore
      .getState()
      .hydrate(scope)
      .catch(() => undefined);
  }, [scope]);
  useEffect(() => {
    observeCoworkSidebarEntries(item.id, storedWorkEntries);
  }, [item.id, storedWorkEntries]);
  const placementOrder = useSidebarItemGroupsStore(
    (state) => state.orderByScope[scopeKey],
  );
  const placedWorkEntries = useMemo(() => {
    if (!placementOrder || entrySortMode !== 'manual') return storedWorkEntries;
    const entries = new Map(
      storedWorkEntries.map((entry) => [entry.id, entry]),
    );
    return [
      ...placementOrder.flatMap((id) => {
        const entry = entries.get(id);
        entries.delete(id);
        return entry ? [entry] : [];
      }),
      ...Array.from(entries.values()),
    ];
  }, [storedWorkEntries, placementOrder, entrySortMode]);
  const visibleWorkEntries = useMemo(
    () =>
      orderWorkEntryRows(
        placedWorkEntries.filter(
          (entry) =>
            entry.hasUserChanges === true ||
            entry.pinned === true ||
            entry.lastMessageAt !== undefined ||
            entry.id === openEmptyEntryId,
        ),
        entrySortMode,
      ),
    [placedWorkEntries, openEmptyEntryId, entrySortMode],
  );
  const itemBlocks = useMemo(
    () =>
      buildSidebarItemGroupBlocks(
        visibleWorkEntries.map((entry) => ({
          rootId: entry.id,
          itemIds: [entry.id],
          pinned: entry.pinned,
          recencyMs: workEntryRecencyMs(entry),
        })),
        itemGroups,
        entrySortMode,
        openEmptyEntryId ?? undefined,
      ),
    [visibleWorkEntries, itemGroups, entrySortMode, openEmptyEntryId],
  );
  const cappedBlocks = useMemo(
    () =>
      maxEntries === undefined || showAllEntries
        ? { visible: itemBlocks, hidden: [] }
        : capSidebarItemGroupBlocks(
            itemBlocks,
            maxEntries,
            openEmptyEntryId ?? undefined,
          ),
    [itemBlocks, maxEntries, showAllEntries, openEmptyEntryId],
  );
  const hiddenEntryCount = cappedBlocks.hidden.length;

  // Persisted rows may mount already expanded after a renderer reload. Load
  // inactive-project entries in that case instead of relying on an in-memory
  // toggle event to trigger the lazy fetch.
  useEffect(() => {
    if (expanded && !isActive && !storedSidebarEntriesLoaded) {
      void loadSidebarProjectEntries(item.id).catch(() => {
        // Entry-list loads are best-effort; the active page can retry later.
      });
    }
  }, [
    expanded,
    isActive,
    item.id,
    loadSidebarProjectEntries,
    storedSidebarEntriesLoaded,
  ]);

  // Legacy (read-only) archived chats, counted into the "Archived and
  // deleted" link; loaded lazily once the row expands.
  const storedLegacyArchivedLoaded = useStandaloneChatStore(
    (s) => s.legacyArchivedByProject[item.id] !== undefined,
  );
  const storedArchivedChats = useStandaloneChatStore(
    (s) => s.legacyArchivedByProject[item.id] ?? EMPTY_LEGACY_ARCHIVED,
  );
  const archivedChats = storedArchivedChats;
  const showsExpandedContent =
    expanded && (visibleWorkEntries.length > 0 || archivedChats.length > 0);
  useEffect(() => {
    if (expanded && !storedLegacyArchivedLoaded) {
      void loadLegacyArchivedChats(item.id).catch(() => {
        // Legacy archive loads are best-effort; the subgroup stays hidden.
      });
    }
  }, [expanded, storedLegacyArchivedLoaded, loadLegacyArchivedChats, item.id]);

  // Retained ("Archived" / "Deleted") work-entry containers, counted into the
  // same link; loaded lazily once the row expands.
  const archivedEntries = useArchivedContainersStore(
    (s) => s.byWorkspace[item.id] ?? EMPTY_ARCHIVED_CONTAINERS,
  );
  // Removals still being captured count immediately so the link reacts the
  // moment the entry leaves the list, not when main finishes cleanup.
  const pendingArchivedEntries = useArchivedContainersStore(
    (s) => s.pendingByWorkspace[item.id] ?? EMPTY_PENDING_ARCHIVED_CONTAINERS,
  );
  const archivedContainersLoaded = useArchivedContainersStore(
    (s) => s.loadedWorkspaces[item.id] === true,
  );
  const archivedContainersLoading = useArchivedContainersStore(
    (s) => s.loadingWorkspaces[item.id] === true,
  );
  useEffect(() => {
    if (expanded && !archivedContainersLoaded) {
      // loadForWorkspace is best-effort (errors swallowed in the store).
      void useArchivedContainersStore.getState().loadForWorkspace(item.id);
    }
  }, [expanded, archivedContainersLoaded, item.id]);

  const listsContent =
    visibleWorkEntries.length > 0 ||
    itemBlocks.length > 0 ||
    archivedChats.length > 0 ||
    archivedEntries.length > 0 ||
    pendingArchivedEntries.length > 0 ||
    archivedContainersLoading;
  // Main's count says whether the workspace has live entries before their
  // list arrives, so the row never flashes over chats that are still loading.
  const workEntriesSettled =
    (item.workEntryCount ?? 0) === 0 || storedWorkEntries.length > 0;
  const showsNoneFound =
    listsNoneFoundWhenEmpty && expanded && !listsContent && workEntriesSettled;

  // The archived container currently open in the viewer for THIS workspace
  // (primitive selector so unrelated viewer changes don't re-render the row).
  const openContainerId = useArchivedContainersStore((s) =>
    s.viewer !== null && s.viewer.workspaceId === item.id
      ? s.viewer.containerId
      : null,
  );
  const archivedOverviewOpen = useArchivedContainersStore(
    (s) => s.overview?.workspaceId === item.id,
  );

  // Effective deletion-retention window for this workspace's work entries:
  // drives the Delete tooltip / confirmation copy on entry rows.
  const effectiveRetentionDays = resolveArchiveRetentionDays(
    'cowork',
    item.archiveRetentionDays,
  );

  const [removingEntryIds, setRemovingEntryIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const contextMenuAnchorRef = useRef<HTMLSpanElement | null>(null);
  const contextMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const openContextMenu = useCallback(
    (target: HTMLElement, x: number, y: number): void => {
      contextMenuReturnFocusRef.current = target;
      target.focus({ preventScroll: true });
      const rect = target.getBoundingClientRect();
      setContextMenu(
        x === 0 && y === 0 ? { x: rect.left, y: rect.bottom } : { x, y },
      );
    },
    [],
  );
  const workspaceRootRef = useRef<HTMLDivElement | null>(null);
  // The root as state, so the seat lookup re-runs once the rail has seated
  // its slot rows (a commit after this row mounts on the shared rail).
  const [workspaceRoot, setWorkspaceRoot] = useState<HTMLDivElement | null>(
    null,
  );
  const stickySlotHost = useStickyWorkspaceSlotHost(workspaceRoot, item.id);

  const {
    setNodeRef,
    transform,
    transition,
    isDragging,
    attributes,
    listeners,
  } = useSortable({ id: item.id, disabled: disableDrag });

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
  // otherwise collapse the row whose drag the user just cancelled.
  useEffect(() => {
    if (workspaceHeaderDragging) {
      suppressHeaderClickRef.current = true;
    }
  }, [workspaceHeaderDragging]);

  const sortableWorkspacePointerDown = listeners?.onPointerDown as
    | ((event: PointerEvent<HTMLDivElement>) => void)
    | undefined;
  const isWorkspaceHeaderDragActivator = (
    target: EventTarget | null,
  ): boolean =>
    target instanceof HTMLElement &&
    target.closest('[data-workspace-drag-activator]') !== null;
  const selectWorkspaceHeaderDragNode = (
    event: PointerEvent<HTMLDivElement>,
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
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      suppressHeaderClickRef.current = false;
    }
  };
  const handleWorkspaceHeaderPointerDown = (
    event: PointerEvent<HTMLDivElement>,
  ): void => {
    if (
      disableDrag ||
      !sortableWorkspacePointerDown ||
      !isWorkspaceHeaderDragActivator(event.target)
    ) {
      return;
    }
    const activator = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-workspace-drag-activator]',
    );
    if (activator?.dataset.workspaceDragActivator === 'label') {
      sortableWorkspacePointerDown(event);
    }
  };
  const handleWorkspaceHeaderClickCapture = (
    event: MouseEvent<HTMLDivElement>,
  ): void => {
    if (!suppressHeaderClickRef.current) return;
    suppressHeaderClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // Selected-item pinning: when this cowork workspace owns the active work
  // entry (chat page) and that entry's row is rendered in flow, portal
  // pinned copies of the workspace header + entry row into the dedicated pin
  // hosts. AppSidebar's scroll sync reveals them while the selection would
  // otherwise scroll out of view (see sticky-selected-item.ts).
  const selectedEntryId = useSelectedCoworkEntryId(item.id);
  const selectedEntry =
    selectedEntryId !== null
      ? visibleWorkEntries.find((entry) => entry.id === selectedEntryId)
      : undefined;
  // A collapsed cowork workspace keeps exactly its active entry row
  // rendered, stuck directly under the header — the selection never
  // disappears behind a collapse, in flow or in the pinned bands.
  const showsCollapsedSelectedEntry = !expanded && selectedEntry !== undefined;
  const selectedBlock = itemBlocks.find((block) =>
    block.units.some((unit) => unit.rootId === selectedEntry?.id),
  );
  const unitLabel = excludeFromWorkspaceList
    ? {
        singular: CHAT_UNIT_LABEL.toLowerCase(),
        plural: CHAT_UNIT_LABEL_PLURAL.toLowerCase(),
      }
    : { singular: 'task', plural: 'tasks' };
  const selectedEntryRendered = selectedEntry !== undefined;
  const [selectedPinHosts, setSelectedPinHosts] =
    useState<SelectedPinHosts | null>(null);
  const [chatsPinHosts, setChatsPinHosts] =
    useState<ChatsSelectedPinHosts | null>(null);
  const chatsSeat = selectedPinSeat === 'chats';
  const disableSelectedPin = chatsSeat && itemGroups.length > 0;
  useLayoutEffect(() => {
    const origin = workspaceRootRef.current;
    setSelectedPinHosts(
      selectedEntryRendered && !disableSelectedPin && !chatsSeat
        ? findSelectedPinHosts(origin)
        : null,
    );
    setChatsPinHosts(
      selectedEntryRendered && !disableSelectedPin && chatsSeat
        ? findChatsSelectedPinHosts(origin)
        : null,
    );
  }, [selectedEntryRendered, chatsSeat, disableSelectedPin]);

  const renderPinnedSelectedEntryRow = (
    surface: 'pin-top' | 'pin-bottom',
  ): JSX.Element | null => {
    if (!selectedEntry) return null;
    return (
      <div className="relative">
        {selectedBlock?.group && (
          <span
            aria-hidden="true"
            className="absolute -left-1.5 inset-y-0 w-0.5 rounded-full"
            style={{
              backgroundColor: sidebarItemGroupColor(selectedBlock.group.color),
            }}
          />
        )}
        <SidebarWorkEntryRow
          workspaceId={item.id}
          entry={selectedEntry}
          onSelect={handleOpenEntry}
          onRename={handleRenameEntry}
          onDelete={handleDeleteEntry}
          onSetStatus={handleSetEntryStatus}
          onSetPinned={handleSetEntryPinned}
          deleting={removingEntryIds.has(selectedEntry.id)}
          effectiveRetentionDays={effectiveRetentionDays}
          pinnedSurface={surface}
        />
      </div>
    );
  };

  const handleToggleExpanded = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      if (expanded) {
        scheduleStickyCollapseScrollAdjust(
          workspaceRootRef.current ??
            event.currentTarget.closest<HTMLElement>(
              '[data-workspace-expanded]',
            ),
        );
      }
      // Pointer-activated toggles retain DOM focus, which keeps the
      // focus-within hover reveal (icon→chevron swap, trailing actions) lit
      // after the pointer leaves the row. Clear only non-focus-visible focus
      // so keyboard activation keeps its focus location, matching
      // ProjectHeader's clearPointerFocus behavior on code workspace rows.
      if (!event.currentTarget.matches(':focus-visible')) {
        event.currentTarget.blur();
      }
      void toggleCollapsed(item.id);
    },
    [expanded, toggleCollapsed, item.id],
  );

  // The row's hover highlight spans the whole header, so the disclosure
  // hitbox matches it: clicks on the row background (padding, gaps, the
  // strips around the controls) toggle, while buttons keep their own actions
  // and the trailing hover-action region stays inert so a near-miss on
  // preferences/new-task cannot collapse the row.
  const handleHeaderBackgroundClick = useCallback(
    (event: MouseEvent<HTMLDivElement>): void => {
      if (event.target instanceof Element) {
        if (event.target.closest('[data-workspace-header-actions]')) {
          return;
        }
        const button = event.target.closest('button');
        // Buttons own their actions — except the icon drag handle: for
        // keyboard/AT it is a pure reorder control (Enter/Space pick up
        // dnd-kit's sortable, matching its "Reorder" name), while a plain
        // POINTER click that never became a drag falls through to this row
        // toggle so the hover-revealed chevron still responds to clicks.
        // Keyboard activation synthesizes detail-0 clicks and must not fall
        // through — a "Reorder" control collapsing the row would contradict
        // its announced semantics when dragging is disabled.
        if (
          button &&
          (button.dataset.workspaceDragActivator !== 'icon' ||
            event.detail === 0)
        ) {
          return;
        }
      }
      if (expanded) {
        scheduleStickyCollapseScrollAdjust(
          workspaceRootRef.current ??
            event.currentTarget.closest<HTMLElement>(
              '[data-workspace-expanded]',
            ),
        );
      }
      // The header itself is click-focusable (tabIndex={-1}) and
      // :focus-within matches the focused element too, so pointer-acquired
      // focus would keep the hover reveal lit after the pointer leaves.
      // Clear it like handleToggleExpanded does; keyboard focus stays.
      const active = event.currentTarget.ownerDocument.activeElement;
      if (
        active instanceof HTMLElement &&
        event.currentTarget.contains(active) &&
        !active.matches(':focus-visible')
      ) {
        active.blur();
      }
      void toggleCollapsed(item.id);
    },
    [expanded, toggleCollapsed, item.id],
  );

  const handleOpenEntry = useCallback(
    (entryId: string): void => {
      // Explicit navigation to a live entry dismisses the page-like archived
      // viewer (programmatic activations must not, so this lives on the click
      // handler rather than the selectWorktree funnel).
      dismissPageLikeViewers();
      openCoworkWorkEntryFromSidebar(item.id, entryId);
      // Navigating unconditionally is deliberate here, and is *not* the same
      // call as `openForkedContainer`, which skips navigation when the
      // selection fails (see `open-forked-container.test.ts`). There, the user
      // is elsewhere in the app and landing on the chat page would read as "the
      // copy opened". Here the user clicked a row in the chat sidebar, so the
      // chat page plus the failure toast is the recovery surface — the sidebar
      // they need to retry from is only visible on it.
      if (activePage !== 'chat') {
        navigate('chat');
      }
    },
    [item.id, activePage, navigate],
  );

  const handleOpenArchivedOverview = useCallback((): void => {
    openArchivedOverviewSurface(item.id);
  }, [item.id]);

  const handleNewWorkEntry = useCallback((): void => {
    openNewCoworkTaskFromSidebar(item.id);
  }, [item.id]);

  const handleRenameEntry = useCallback(
    (entryId: string, title: string | null): void => {
      void renameWorkEntry(entryId, title, item.id).catch(() => {
        // Rename failures should not break the sidebar.
      });
    },
    [renameWorkEntry, item.id],
  );

  const handleSetEntryStatus = useCallback(
    (entryId: string, status: 'active' | 'done'): void => {
      void setWorkEntryStatus(entryId, status, item.id).catch(() => {
        // Status failures should not break the sidebar.
      });
    },
    [setWorkEntryStatus, item.id],
  );

  const handleSetEntryPinned = useCallback(
    (entryId: string, pinned: boolean): void => {
      void setWorkEntryPinned(entryId, pinned, item.id).catch(() => {
        useGitHubStore
          .getState()
          .addToast(pinned ? 'Failed to pin' : 'Failed to unpin', 'error');
      });
    },
    [setWorkEntryPinned, item.id],
  );

  const handleDeleteEntry = useCallback(
    (
      entryId: string,
      options: { mode: WorkEntryRemovalMode },
    ): Promise<void> => {
      setRemovingEntryIds((current) => new Set(current).add(entryId));
      return deleteWorkEntry(entryId, item.id, {
        lockAfterArchive: options.mode === 'archive',
      })
        .catch(() => {
          // Delete failures should not break the sidebar.
        })
        .finally(() => {
          setRemovingEntryIds((current) => {
            const next = new Set(current);
            next.delete(entryId);
            return next;
          });
        });
    },
    [deleteWorkEntry, item.id],
  );

  const reportGroupError = (error: unknown): void =>
    useGitHubStore
      .getState()
      .addToast(
        error instanceof Error
          ? error.message
          : 'Group changes could not be saved. Try again.',
        'error',
      );
  const groupStore = useSidebarItemGroupsStore.getState();
  const groupCommands: CodeSidebarItemGroupCommands = {
    create: (itemId) => groupStore.create({ scope, itemId }),
    update: (groupId, patch): Promise<void> =>
      groupStore.update({ scope, groupId, ...patch }).catch(reportGroupError),
    ungroup: (groupId): void => {
      void groupStore.ungroup({ scope, groupId }).catch(reportGroupError);
    },
    moveItem: (itemId, drop): void => {
      const pins = visibleWorkEntries.filter((entry) => entry.pinned);
      if (pins.some((entry) => entry.id === itemId)) {
        const remaining = pins.filter((entry) => entry.id !== itemId);
        const index = drop.before
          ? remaining.findIndex((entry) => entry.id === drop.before)
          : drop.after
            ? remaining.findIndex((entry) => entry.id === drop.after) + 1
            : -1;
        const target = index >= 0 ? pins[index]?.id : undefined;
        if (target)
          void reorderWorkEntries(item.id, itemId, target).catch(
            reportGroupError,
          );
        return;
      }
      void groupStore
        .moveItem(
          {
            scope,
            itemId,
            groupId: drop.groupId,
            ...(drop.before
              ? { before: drop.before }
              : drop.after
                ? { after: drop.after }
                : {}),
          },
          drop.membershipOnly,
        )
        .catch(reportGroupError);
    },
    moveGroup: (groupId, drop): void => {
      void groupStore
        .moveGroup({
          scope,
          groupId,
          ...(drop.before
            ? { before: drop.before }
            : drop.after
              ? { after: drop.after }
              : {}),
        })
        .catch(reportGroupError);
    },
  };
  const createInGroup = (groupId: string): void =>
    openNewCoworkTaskFromSidebar(item.id, { sidebarItemGroupId: groupId });
  const renderEntry = (
    id: string,
    menu?: readonly WorktreeMenuItem[],
  ): ReactNode => {
    const entry = visibleWorkEntries.find((entry) => entry.id === id);
    return entry ? (
      <SidebarWorkEntryRow
        workspaceId={item.id}
        entry={entry}
        onSelect={handleOpenEntry}
        onRename={handleRenameEntry}
        onDelete={handleDeleteEntry}
        onSetStatus={handleSetEntryStatus}
        onSetPinned={handleSetEntryPinned}
        deleting={removingEntryIds.has(entry.id)}
        effectiveRetentionDays={effectiveRetentionDays}
        disableSelectedPin={disableSelectedPin}
        workEntryMultiSelect={workEntryMultiSelect}
        selectedPinSeat={selectedPinSeat}
        groupMenu={menu}
        sortMode={entrySortMode}
        membershipDragEnabled={itemGroups.length > 0}
      />
    ) : null;
  };
  const renderBlocks = (
    blocks: readonly SidebarItemGroupBlock[],
    dragEnabled = true,
  ): ReactNode => (
    <CodeSidebarItemGroups
      blocks={blocks}
      dragEnabled={dragEnabled}
      groups={itemGroups}
      mode={entrySortMode}
      commands={groupCommands}
      unitLabel={unitLabel}
      rowGap="hairline"
      itemGap={compactDisclosure ? 'hairline' : undefined}
      // A drag of a selected entry carries the whole selection.
      selectionCount={workEntryMultiSelect?.selection.count}
      isItemSelected={
        workEntryMultiSelect?.selection.active === true
          ? (id): boolean =>
              workEntryMultiSelect.selection.isSelected(
                workEntryRowKey(item.id, id),
              )
          : undefined
      }
      renderRow={(id, menu): ReactNode => renderEntry(id, menu)}
      renderPreview={(id): ReactNode => (
        <div className="flex h-7 items-center px-1.5 text-s fg-primary">
          <span className={POSTHOG_REPLAY_MASK_CLASS}>
            {visibleWorkEntries.find((entry) => entry.id === id)?.title}
          </span>
        </div>
      )}
      onCreate={createInGroup}
      onError={reportGroupError}
      canDragRow={(id): boolean =>
        itemGroups.length > 0 ||
        canDragSidebarRow(
          entrySortMode,
          visibleWorkEntries.find((entry) => entry.id === id)?.pinned === true,
        )
      }
      renderStatus={(block): ReactNode => (
        <CoworkGroupStatus
          workspaceId={item.id}
          entries={visibleWorkEntries.filter((entry) =>
            block.units.some((unit) => unit.rootId === entry.id),
          )}
        />
      )}
    />
  );
  const renderPinnedGroupHeader = (
    surface: 'pin-top' | 'pin-bottom',
  ): ReactNode => {
    const group = selectedBlock?.group;
    if (!group || (group.labelHidden && !group.collapsed)) return null;
    return (
      <div
        className="relative pointer-events-none"
        inert
        data-testid={`sidebar-item-group-header-frame-${surface}`}
      >
        <span
          aria-hidden="true"
          className="absolute -left-1.5 inset-y-0 w-0.5 rounded-full"
          style={{ backgroundColor: sidebarItemGroupColor(group.color) }}
        />
        <SidebarItemGroupHeader
          group={group}
          status={
            <CoworkGroupStatus
              workspaceId={item.id}
              entries={visibleWorkEntries.filter((entry) =>
                selectedBlock.units.some((unit) => unit.rootId === entry.id),
              )}
            />
          }
          count={selectedBlock.units.length}
          unitLabel={unitLabel}
          testIdSuffix={`-${surface}`}
          contentId={`${item.id}-${group.id}-${surface}`}
          onToggle={(): void => undefined}
          onCreate={(): void => undefined}
          onMenu={(): void => undefined}
        />
      </div>
    );
  };
  const renderWorkspaceHeader = (
    surface: 'flow' | 'sticky-slot' | 'pin-top' | 'pin-bottom',
  ): JSX.Element => {
    const isFlow = surface === 'flow';
    const isPinCopy = surface === 'pin-top' || surface === 'pin-bottom';
    // Non-flow copies (slot or selected-item pin) suffix their automation ids.
    const testIdSuffix = isFlow ? '' : `-${surface}`;
    return (
      <div
        ref={isFlow ? setNodeRef : undefined}
        style={workspaceHeaderStyle}
        className={`group/header group/sidebar-item relative flex h-8 items-center gap-1.5 rounded-row pl-1.5 pr-1 fg-primary transition-colors duration-150 hover:bg-subtle ${
          workspaceHeaderDragging ? 'opacity-60' : ''
        }`}
        data-sidebar-workspace-sortable-header={isPinCopy ? undefined : item.id}
        data-sidebar-workspace-source-dragging={
          !isPinCopy && workspaceHeaderDragging ? 'true' : undefined
        }
        data-testid={`sidebar-cowork-project-${item.id}-header${testIdSuffix}`}
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
        onClick={handleHeaderBackgroundClick}
        onContextMenu={(event): void => {
          event.preventDefault();
          openContextMenu(event.currentTarget, event.clientX, event.clientY);
        }}
        tabIndex={-1}
      >
        {/* The icon doubles as the disclosure affordance: at rest only the
            icon is visible (no chevron in the default state), and hovering or
            focusing the row swaps it for the collapse chevron in place. A
            plain click on the handle toggles; dragging (≥6px) still reorders,
            and a post-drag click is suppressed by the header click-capture. */}
        {disableDrag || isPinCopy ? (
          <span
            className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
            aria-hidden="true"
          >
            <WorkspaceIconDisclosureSwap
              collapsed={!expanded}
              testIdSuffix={testIdSuffix}
            >
              <ProjectIcon
                kind="cowork"
                color={item.color}
                testIdSuffix={testIdSuffix}
              />
            </WorkspaceIconDisclosureSwap>
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Reorder ${item.name}`}
            data-workspace-drag-activator="icon"
            data-testid={`sidebar-cowork-project-${item.id}-drag-handle${testIdSuffix}`}
            className="focus-ring relative inline-flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded-full"
            {...attributes}
            {...listeners}
          >
            <WorkspaceIconDisclosureSwap
              collapsed={!expanded}
              testIdSuffix={testIdSuffix}
            >
              <ProjectIcon
                kind="cowork"
                color={item.color}
                testIdSuffix={testIdSuffix}
              />
            </WorkspaceIconDisclosureSwap>
          </button>
        )}

        <button
          type="button"
          onClick={handleToggleExpanded}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.name}${item.pinned === true ? ', Pinned' : ''}`}
          data-workspace-drag-activator="label"
          data-testid={`sidebar-cowork-project-${item.id}-toggle${testIdSuffix}`}
          className="focus-ring flex min-w-0 flex-1 items-center gap-1 text-left group-hover/sidebar-item:pr-19 group-focus-within/sidebar-item:pr-19"
        >
          <span
            className={`${POSTHOG_REPLAY_MASK_CLASS} min-w-0 truncate text-s font-normal leading-snug`}
            title={item.name}
          >
            {item.name}
          </span>
        </button>

        {item.pinned === true && (
          // Hidden while the hover actions overlay its pixels, like the
          // code project header's pin.
          <SidebarPinnedBadge
            testId={`sidebar-cowork-project-${item.id}-pinned${testIdSuffix}`}
            className="mr-1.5"
            hideOnCoarsePointer
          />
        )}

        {/* Inert at rest so the whole row still reads as one hover target,
            then pointer-interactive once revealed so presses that land in
            the gaps around the controls cannot fall through to the toggle
            button beneath. `right-0 pr-1` keeps the icons where `right-1`
            put them while extending the hit area to the row edge. */}
        <div
          data-workspace-header-actions="true"
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 pr-1 group-hover/sidebar-item:pointer-events-auto group-focus-within/sidebar-item:pointer-events-auto"
        >
          <RailIconButton
            icon={SettingsIcon}
            onClick={() => openWorkspaceSettingsModal({ workspaceId: item.id })}
            aria-label="Settings"
            data-testid={`sidebar-cowork-project-${item.id}-settings${testIdSuffix}`}
            tooltipLabel="Settings"
            hoverSurface
            revealOnItemHover
          />
          <RailIconButton
            icon={MoreHorizontalIcon}
            onClick={(event): void => {
              const rect = event.currentTarget.getBoundingClientRect();
              openContextMenu(event.currentTarget, rect.left, rect.bottom);
            }}
            aria-label={`More actions for ${item.name}`}
            aria-haspopup="menu"
            tooltipLabel="More actions"
            data-testid={`sidebar-cowork-project-${item.id}-options${testIdSuffix}`}
            hoverSurface
            revealOnItemHover
          />
          <RailIconButton
            icon={PlusMediumIcon}
            onClick={handleNewWorkEntry}
            aria-label={`New task in ${item.name}`}
            title="New task"
            data-testid={`sidebar-cowork-project-${item.id}-new-chat${testIdSuffix}`}
            hoverSurface
            revealOnItemHover
          />
        </div>
      </div>
    );
  };

  // The rows on screen, in order, for the bulk selection: rows past the cap
  // or inside a collapsed group are not rendered, so ranges and select-all
  // never reach them.
  const renderedEntryIds: readonly string[] =
    workEntryMultiSelect === undefined
      ? []
      : expanded && listsContent
        ? cappedBlocks.visible.flatMap((block) => block.visibleItemIds)
        : showsCollapsedSelectedEntry
          ? [selectedEntry.id]
          : [];
  const selectionRows: SidebarSelectionRow[] = renderedEntryIds.flatMap(
    (id): SidebarSelectionRow[] => {
      const entry = visibleWorkEntries.find((candidate) => candidate.id === id);
      return entry === undefined || workEntryMultiSelect === undefined
        ? []
        : [
            {
              key: workEntryRowKey(item.id, id),
              kind: 'work-entry',
              selectable:
                workEntryMultiSelect.isSelectable(item.id) &&
                !removingEntryIds.has(id),
              label: entry.title,
              projectName: item.name,
              open: id === selectedEntryId,
            },
          ];
    },
  );

  return (
    <div
      ref={(node): void => {
        workspaceRootRef.current = node;
        setWorkspaceRoot(node);
      }}
      className={`group/row relative rounded-row transition-colors ${
        hasFollowingWorkspace
          ? showsExpandedContent || showsCollapsedSelectedEntry
            ? 'mb-2'
            : 'mb-px'
          : ''
      }`}
      data-workspace-expanded={
        excludeFromWorkspaceList === true
          ? undefined
          : expanded
            ? 'true'
            : 'false'
      }
      data-sidebar-workspace-id={
        excludeFromWorkspaceList === true ? undefined : item.id
      }
      data-testid={`sidebar-cowork-project-${item.id}`}
      data-onboarding-anchor={isTourAnchor ? 'sidebar-chat' : undefined}
    >
      {workEntryMultiSelect !== undefined && (
        <SidebarSelectionRowsReporter
          listId={item.id}
          rows={selectionRows}
          onRowsChange={workEntryMultiSelect.onRowsChange}
        />
      )}
      {workspaceDropIndicatorPosition && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-1.5 z-20 h-0.5 rounded-full bg-accent ${
            workspaceDropIndicatorPosition === 'before'
              ? '-top-px'
              : '-bottom-px'
          }`}
          data-drop-position={workspaceDropIndicatorPosition}
          data-testid="workspace-drop-indicator"
        />
      )}
      {/* Matches the code-workspace `SidebarSection` header treatment
          (`sidebar-workspace-sticky-header z-30 bg-sidebar`): each header
          pins below the sticky controls group while its own list scrolls —
          cowork rows must not behave differently from git projects in the
          unified list. */}
      {!hideWorkspaceHeader && (
        <div className="sidebar-workspace-sticky-header z-30 bg-sidebar">
          {renderWorkspaceHeader('flow')}
        </div>
      )}

      {/* Collapse exception: the active work entry row stays rendered, stuck
          directly under the collapsed header. The wrapper carries
          `data-sidebar-folder-content` so AppSidebar's rail-layout cache
          still resolves it as this header's rows surface. */}
      {showsCollapsedSelectedEntry && selectedEntry !== undefined && (
        <div
          className="mt-px"
          data-sidebar-folder-content="cowork-workspace-collapsed-selected"
          data-testid={`sidebar-cowork-project-${item.id}-collapsed-selected`}
        >
          {selectedBlock?.group
            ? renderBlocks(
                [{ ...selectedBlock, visibleItemIds: [selectedEntry.id] }],
                false,
              )
            : renderEntry(selectedEntry.id)}
        </div>
      )}

      {showsNoneFound && (
        <div className="mt-px">
          <SidebarNoneFoundRow
            data-testid={`sidebar-cowork-project-${item.id}-empty`}
            labelTestId={`sidebar-cowork-project-${item.id}-empty-label`}
          />
        </div>
      )}

      {listsContent && (
        <SidebarFadePresence
          open={expanded}
          className="mt-px"
          data-sidebar-folder-content="cowork-workspace"
        >
          <div className="flex flex-col gap-px">
            {renderBlocks(cappedBlocks.visible)}
          </div>
          {maxEntries !== undefined &&
            (hiddenEntryCount > 0 || showAllEntries) &&
            (compactDisclosure ? (
              // Early access: one more list row, 1px under the last entry
              // like the gap between entries.
              <div className="mt-px">
                <SidebarMoreRow
                  expanded={showAllEntries}
                  onToggle={(): void => setShowAllEntries((shown) => !shown)}
                  ariaLabel={
                    showAllEntries
                      ? `Show fewer ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`
                      : `Show all ${visibleWorkEntries.length} ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`
                  }
                  testId={`sidebar-cowork-project-${item.id}-show-all`}
                />
              </div>
            ) : (
              <SidebarToggleRow
                label={showAllEntries ? 'Show fewer' : 'Show all'}
                expanded={showAllEntries}
                onToggle={(): void => setShowAllEntries((shown) => !shown)}
                ariaLabel={
                  showAllEntries
                    ? `Show fewer ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`
                    : `Show all ${visibleWorkEntries.length} ${CHAT_UNIT_LABEL_PLURAL.toLowerCase()}`
                }
                count={visibleWorkEntries.length}
                testId={`sidebar-cowork-project-${item.id}-show-all`}
                chevronTestId={`sidebar-cowork-project-${item.id}-show-all-chevron`}
                countTestId={`sidebar-cowork-project-${item.id}-show-all-count`}
              />
            ))}

          <ArchivedContainersNavLink
            size={compactDisclosure ? 'row' : 'compact'}
            count={
              archivedChats.length +
              archivedEntries.length +
              pendingArchivedEntries.length
            }
            selected={
              isActiveOnChatPage &&
              (archivedOverviewOpen ||
                openContainerId !== null ||
                archiveOverlayChatId !== null)
            }
            onOpen={handleOpenArchivedOverview}
            testId={`sidebar-cowork-project-${item.id}-archived-link`}
          />
        </SidebarFadePresence>
      )}

      {contextMenu && workspaceRootRef.current?.ownerDocument.body && (
        <>
          <FloatingMenuPointAnchor
            ref={contextMenuAnchorRef}
            x={contextMenu.x}
            y={contextMenu.y}
            ownerDocument={workspaceRootRef.current.ownerDocument}
            data-testid="workspace-session-context-menu-anchor"
          />
          <FloatingMenu
            open
            onOpenChange={(open): void => {
              if (!open) setContextMenu(null);
            }}
            anchorRef={contextMenuAnchorRef}
            returnFocusRef={contextMenuReturnFocusRef}
            placement="bottom-left"
            className="w-45"
            aria-label="Project actions"
            data-testid="workspace-session-context-menu"
            onContextMenu={(event): void => event.preventDefault()}
          >
            <ActionMenuRowStyle>
              <ActionMenuItems
                items={coworkProjectMenuItems({
                  pinned: item.pinned === true,
                  onTogglePin: (pinned): void => {
                    void setWorkspacePinned(item.id, pinned);
                  },
                  onOpenSettings: (): void => {
                    openWorkspaceSettingsModal({ workspaceId: item.id });
                  },
                  onShareTemplate: (): void => {
                    openWorkspaceSettingsModal({
                      workspaceId: item.id,
                      initialTab: 'share',
                    });
                  },
                  onImportSession: (): void => {
                    useCloudConnectGateStore
                      .getState()
                      .requestConnect({}, () => {
                        openImportSessionModal(item.id);
                      });
                  },
                  onMoveToOrganization: onMoveToOrganizationRequested
                    ? (): void => onMoveToOrganizationRequested(item.id)
                    : undefined,
                })}
                onSelect={(action): void => {
                  if (action.disabled || !action.onSelect) return;
                  setContextMenu(null);
                  // Hand focus back to the row, as a FloatingMenu pick does.
                  contextMenuReturnFocusRef.current?.focus({
                    preventScroll: true,
                  });
                  action.onSelect();
                }}
              />
              {/* Sorting is a pick of one mode, not a command: it stays a
                    labelled group of checked choices below the actions. */}
              <SidebarSortMenuItems
                mode={entrySortMode}
                testIdPrefix="workspace-item-sort"
                label="Sort tasks by"
                onSelect={(mode): void => {
                  setContextMenu(null);
                  void setWorkspaceItemSortMode(item.id, mode);
                }}
              />
            </ActionMenuRowStyle>
          </FloatingMenu>
        </>
      )}
      {!hideWorkspaceHeader &&
        stickySlotHost &&
        createPortal(renderWorkspaceHeader('sticky-slot'), stickySlotHost)}
      {selectedEntryRendered && chatsPinHosts && (
        <>
          {createPortal(
            renderPinnedSelectedEntryRow('pin-top'),
            chatsPinHosts.top,
          )}
          {createPortal(
            renderPinnedSelectedEntryRow('pin-bottom'),
            chatsPinHosts.bottomRow,
          )}
        </>
      )}
      {selectedEntryRendered && selectedPinHosts && (
        <>
          {!hideWorkspaceHeader &&
            createPortal(
              renderWorkspaceHeader('pin-top'),
              selectedPinHosts.topHeader,
            )}
          {selectedPinHosts.topGroupHeader &&
            createPortal(
              renderPinnedGroupHeader('pin-top'),
              selectedPinHosts.topGroupHeader,
            )}
          {createPortal(
            renderPinnedSelectedEntryRow('pin-top'),
            selectedPinHosts.topRow,
          )}
          {!hideWorkspaceHeader &&
            createPortal(
              renderWorkspaceHeader('pin-bottom'),
              selectedPinHosts.bottomHeader,
            )}
          {selectedPinHosts.bottomGroupHeader &&
            createPortal(
              renderPinnedGroupHeader('pin-bottom'),
              selectedPinHosts.bottomGroupHeader,
            )}
          {createPortal(
            renderPinnedSelectedEntryRow('pin-bottom'),
            selectedPinHosts.bottomRow,
          )}
        </>
      )}
    </div>
  );
}

export const SidebarCoworkWorkspaceRow = memo(SidebarCoworkWorkspaceRowImpl);
