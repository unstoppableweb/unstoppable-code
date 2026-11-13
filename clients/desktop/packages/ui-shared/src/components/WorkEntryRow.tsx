'use client';

import type { WorkEntryAutoDeleteRowState } from '@canopy/protocol';
import { SidebarAutoDeleteBadge } from './SidebarAutoDeleteBadge';

import { Dot } from './Badge';
import {
  memo,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type HTMLAttributes,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import {
  DropdownMenuDivider,
  DEFAULT_MENU_ROW_STYLE,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuRowStyleProvider,
  QUIET_MENU_ROW_STYLE,
} from './DropdownMenu';
import {
  SpaceNotificationMenuItems,
  spaceNotificationMenuUnavailable,
  type SpaceNotificationMenuChoice,
  type SpaceNotificationMenuState,
} from './SpaceNotificationMenu';
import { ActionMenuRowStyle } from './ActionMenuItems';
import { FloatingMenu, FloatingMenuPointAnchor } from './FloatingMenu';
import { RailIconButton } from './RailIconButton';
import { SharedWithTeammatesBadge } from './SharedWithTeammatesBadge';
import {
  CONTEXT_MENU_POINTER_OFFSET,
  useContextMenuPlacement,
} from './context-menu-placement';
import { SidebarRowAge } from './SidebarRowAge';
import { AgentStateGlyph, backgroundTasksLabel } from './AgentStateGlyph';
import { ThinkingSpinner } from './ThinkingSpinner';
import { ChoiceMark } from './Choice';
import { SidebarPinMenuItem } from './SidebarPinMenuItem';
import { SidebarPinnedBadge } from './SidebarPinnedBadge';
import { Tooltip } from './Tooltip';
import { StatusGlyph } from './StatusGlyph';
import {
  ArchiveBoxIcon,
  ArchiveIcon,
  CheckIcon,
  MoreHorizontalIcon,
  ListChecks,
  PencilIcon,
  PinFilledIcon,
  PinIcon,
  ShareIcon,
  TrashIcon,
} from '../icons/AppIcons';
import { SIDEBAR_INDICATOR_BLUE } from '../lib/operational-status-colors';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import {
  resolveSelectionClick,
  focusSelectionRow,
  resolveSelectionKey,
  shiftMouseDownSuppressesTextSelection,
} from '../lib/sidebar-row-selection-gestures';

/** Surfaces that mount a visual copy of a selected row (CAN-3127). */
export type WorkEntryRowPinnedSurface = 'pin-top' | 'pin-bottom';

/** A Work Entry's user-driven completion state. */
export type WorkEntryRowStatus = 'active' | 'done';

/**
 * Marks a row that handles its own clicks for the bulk selection. Same value
 * as `@canopy/ui-app`'s `SIDEBAR_SELECTION_ROW_ATTR`, which this package
 * cannot import.
 */
export const WORK_ENTRY_SELECTION_ROW_ATTR = 'data-worktree-selection-row';

/**
 * The row's part in the rail's bulk selection (CAN-3975), with macOS Finder
 * rules. Command-click (Ctrl-click off macOS) toggles, Shift-click ranges
 * from the anchor, Shift+Up/Down extend the range, `x` toggles the focused
 * row, Cmd/Ctrl+A selects the list, and Esc clears. A plain click opens the
 * entry, ends an active selection, and anchors Shift ranges on this row.
 */
export interface WorkEntryRowMultiSelect {
  readonly selectMode?: boolean;
  readonly onSelectItem?: () => void;
  /** This row is in the selection: the open row's fill and an sr-only label. */
  readonly selected: boolean;
  /** The row can join the selection. */
  readonly selectable: boolean;
  /** The row's selection key, which Shift+Up/Down focus finds rows by. */
  readonly rowKey: string;
  /** Any row in the rail is selected: a plain click opens and clears. */
  readonly active: boolean;
  /** Esc clears the selection; off while a batch runs. */
  readonly escapeClears: boolean;
  readonly onToggle: () => void;
  readonly onSelectRange: () => void;
  readonly onSelectAll: () => void;
  /** A plain click: clears the selection and anchors Shift ranges here. */
  readonly onAnchor: () => void;
  /** Shift+Up/Down: moves the range's far end; the key of the row to focus. */
  readonly onExtend: (step: 1 | -1) => string | undefined;
  readonly onClear: () => void;
}

/** A viewport point, such as the position of a right-click. */
export interface WorkEntryRowPoint {
  x: number;
  y: number;
}

/**
 * The host's drag-and-drop binding for a sortable row. Supplying it makes the
 * row a drag source: the row takes the ref, style, and attributes, and
 * forwards pointer-downs that do not start on one of its controls.
 */
export interface WorkEntryRowDragBinding {
  /** The sortable node ref (dnd-kit's `setNodeRef`). */
  ref?: Ref<HTMLDivElement>;
  /** The drag transform and transition. */
  style?: CSSProperties;
  /** Sortable ARIA attributes; the row keeps its own role and tab stop. */
  attributes?: HTMLAttributes<HTMLDivElement>;
  /** Drag activator, called only for pointer-downs outside the controls. */
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  /** Dims the row while it is being dragged. */
  isDragging?: boolean;
}

/** What a host needs to build the rows of a Work Entry's menu. */
export interface WorkEntryRowMenuContext {
  readonly onSelectItem?: () => void;
  /** Closes the menu. Call it before running the chosen command. */
  close: () => void;
  /**
   * The automation id for a menu row, e.g. `testIdFor('-rename')`. Carries
   * the row's base id and, on a pinned copy, its surface suffix.
   */
  testIdFor: (suffix: string) => string;
}

/** Everything a host needs to render the menu surface itself. */
export interface WorkEntryRowMenuRenderProps extends WorkEntryRowMenuContext {
  open: boolean;
  /** The ••• button: the anchor, and the element that toggles the menu. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  /** The right-click position, or `null` to anchor under the ••• button. */
  anchorPoint: WorkEntryRowPoint | null;
  /** The automation id for the menu surface (`-menu-popover`). */
  popoverTestId: string;
}

export interface WorkEntryRowProps {
  /** The Work Entry title. */
  title: string;
  /**
   * Base automation id, e.g. `sidebar-work-entry-${id}`. The row appends its
   * part suffixes (`-menu`, `-status-slot`, …) and, on a pinned copy, the
   * surface suffix after them.
   */
  testId: string;
  /** The Work Entry id, forwarded as `data-standalone-chat-id`. */
  entryId: string;
  /** `'done'` shows the leading checkmark and suppresses trailing status. */
  status?: WorkEntryRowStatus;
  /**
   * Where the row's status shows. `trailing` (default): the Working spinner
   * and one attention dot on the right, the done check on the left.
   * `leading` (desktop early access): one indicator in the leading slot,
   * orange for a waiting question, a loader while a turn runs, blue for
   * unread, grey otherwise, so the right side is left to the age.
   */
  statusPlacement?: 'trailing' | 'leading';
  /** Whether the row is the open Work Entry. */
  selected?: boolean;
  /** A chat in the entry has a turn in flight: shows the Working spinner. */
  working?: boolean;
  /**
   * Live background tasks in the entry's chats: the neutral background
   * spinner while no turn runs (turn-state D15). Hosts without the data omit
   * it.
   */
  backgroundTasks?: number;
  /** An agent question waits for an answer: the orange dot. Beats unread. */
  hasPendingQuestion?: boolean;
  /** A chat in the entry has output the user has not viewed: the blue dot. */
  hasUnread?: boolean;
  /** Shows the shared-with-teammates badge. */
  sharedWithTeammates?: boolean;
  /**
   * The user pinned the entry to the top of its list: shows the quiet pin
   * left of the shared badge and any status. Unrelated to
   * {@link pinnedSurface}, which marks a sticky copy of the selected row.
   */
  pinnedToTop?: boolean;
  /** Agent-armed removal intent, outside the live-status priority chain. */
  autoDelete?: WorkEntryAutoDeleteRowState;
  onAutoDeleteActivate?: () => void;
  autoDeleteReadOnly?: boolean;
  /**
   * When the entry last had activity (epoch ms or ISO string). Set, an idle
   * row shows its compact age (`5m`, `3h`, `2d`) on the right. A live status
   * takes that spot instead, and the hover actions replace it.
   */
  lastActivityAt?: string | number;
  /**
   * Renders the row as a pinned copy of the selected item. The copy suffixes
   * its automation ids and never carries the entry id or the selected-item
   * measurement mark, and ignores any drag binding.
   */
  pinnedSurface?: WorkEntryRowPinnedSurface;
  /**
   * Keeps the row's selection but opts it out of the sticky selected-item
   * pin, for a row whose owning header is not a workspace header (CAN-2363).
   */
  disableSelectedPin?: boolean;
  /**
   * Where the sticky selected-item pin seats this row's copy, forwarded as
   * `data-sidebar-selected-pin-seat`. Omit for a row under a workspace
   * header; the header-less Chats rows seat under the Chats header.
   */
  selectedPinSeat?: string;
  /** A removal is in flight: the row fades and stops taking input. */
  removing?: boolean;
  /**
   * Raises the row to the 44px touch minimum, for a host that renders it in a
   * touch drawer. The desktop rail leaves it off and keeps its 32px rows.
   */
  touchTarget?: boolean;
  /** Makes the row a drag source. Omit for a static row. */
  drag?: WorkEntryRowDragBinding;
  /**
   * The bulk selection (CAN-3975). Omit where the host offers none; a pinned
   * copy ignores it.
   */
  multiSelect?: WorkEntryRowMultiSelect;
  /** Opens the Work Entry. Runs on click, Enter, and Space. */
  onOpen?: () => void;
  /** Host-neutral intent to open this row; does not select or move focus. */
  onIntent?: (phase: 'start' | 'end', source: 'pointer' | 'focus') => void;
  /**
   * Shows the hover Delete button. The host confirms and removes; omit it on
   * a surface that cannot delete.
   */
  onDelete?: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Why the entry cannot be deleted right now. Set, it keeps the hover Delete
   * button visible but disabled, with this reason as its tooltip.
   */
  deleteDisabledReason?: string;
  /**
   * `classic` (default): hover shows Delete and •••. `compact` (desktop early
   * access, as on focused worktree rows): hover shows Pin and Archive, the
   * full menu opens on right-click (••• stays for touch only), and a pinned
   * row shows a pin icon beside its age, exactly where the hover Pin lands.
   */
  hoverActions?: 'classic' | 'compact';
  /** Compact hover Pin / Unpin, called with the next pin state. */
  onTogglePin?: (pinned: boolean) => void;
  /** Compact hover Archive. The host confirms and archives. */
  onArchive?: () => void;
  /**
   * Why the entry cannot be archived right now. Set, the compact Archive
   * button stays in place, disabled, with this reason as its tooltip.
   */
  archiveDisabledReason?: string;
  /**
   * The rows of the entry's menu, shown in the shared menu surface under the
   * ••• button or at a right-click. Supplying this (or `renderMenu`) shows
   * the ••• button and enables the context menu.
   */
  renderMenuItems?: (menu: WorkEntryRowMenuContext) => ReactNode;
  /**
   * Renders the whole menu surface instead of the shared one, for a host
   * that owns its own anchored menu. Takes precedence over
   * `renderMenuItems`, and is called whether or not the menu is open.
   */
  renderMenu?: (menu: WorkEntryRowMenuRenderProps) => ReactNode;
  /** Accessible name for the shared menu surface. */
  menuLabel?: string;
  /**
   * The unread-chats preview, shown while the attention dot is hovered or
   * focused and the entry has unread chats. `anchorRect` is the row's rect.
   */
  renderUnreadPreview?: (anchorRect: DOMRect) => ReactNode;
}

/** Controls whose pointer-downs and key presses belong to them, not the row. */
const INTERACTIVE_TARGET_SELECTOR =
  'button, input, textarea, select, a, [contenteditable="true"]';

/**
 * Whether an event started in the row's own DOM subtree. React bubbles
 * synthetic events through the component tree, so events from a portaled
 * descendant (the menu surface, the unread preview) reach the row's handlers
 * even though their targets sit under `document.body`; those are not the
 * row's to handle.
 */
function isOwnTarget(target: EventTarget, row: HTMLDivElement): boolean {
  return target instanceof Node && row.contains(target);
}

/** Whether an event started on one of the row's own controls. */
function isInteractiveTarget(
  target: EventTarget,
  row: HTMLDivElement,
): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(INTERACTIVE_TARGET_SELECTOR);
  return control !== null && control !== row && row.contains(control);
}

/**
 * The automation id for a part of a Work Entry row: the base id, the part
 * suffix, then the pinned-copy surface suffix (CAN-3127's convention).
 */
export function workEntryRowTestId(
  testId: string,
  suffix = '',
  pinnedSurface?: WorkEntryRowPinnedSurface,
): string {
  return `${testId}${suffix}${pinnedSurface ? `-${pinnedSurface}` : ''}`;
}

/**
 * One Work Entry row in a sidebar list: a leading done slot, the title, the
 * pin and shared badges, the trailing status (Working spinner plus one attention dot),
 * and hover Delete and ••• actions.
 *
 * Pure display, shared by the desktop rail and the web portal's Chats
 * section (CAN-3053). The host owns every command, dialog, store, and menu
 * row: it passes state in and callbacks and slots out. Actions the host
 * cannot perform are omitted by leaving their callback out, and the title
 * reserves room for exactly the actions that render.
 */
function WorkEntryRowImpl({
  title,
  testId,
  entryId,
  status = 'active',
  statusPlacement = 'trailing',
  selected = false,
  working = false,
  backgroundTasks = 0,
  hasPendingQuestion = false,
  hasUnread = false,
  sharedWithTeammates = false,
  pinnedToTop = false,
  autoDelete,
  onAutoDeleteActivate,
  autoDeleteReadOnly = false,
  lastActivityAt,
  pinnedSurface,
  disableSelectedPin = false,
  selectedPinSeat,
  removing = false,
  touchTarget = false,
  drag,
  multiSelect: multiSelectProp,
  onOpen,
  onIntent,
  onDelete,
  deleteDisabledReason,
  hoverActions = 'classic',
  onTogglePin,
  onArchive,
  archiveDisabledReason,
  renderMenuItems,
  renderMenu,
  menuLabel,
  renderUnreadPreview,
}: WorkEntryRowProps): JSX.Element {
  const isPinnedCopy = pinnedSurface !== undefined;
  const dragBinding = isPinnedCopy ? undefined : drag;
  const multiSelect = isPinnedCopy || removing ? undefined : multiSelectProp;
  const multiSelected = multiSelectProp?.selected === true && !isPinnedCopy;
  const testIdFor = useCallback(
    (suffix: string): string =>
      workEntryRowTestId(testId, suffix, pinnedSurface),
    [testId, pinnedSurface],
  );
  const isDone = status === 'done';
  const attentionDot = workEntryAttentionDot({
    done: isDone,
    hasPendingQuestion,
    hasUnread,
  });
  const showWorking = !isDone && working;
  const shownBackgroundTasks = isDone || working ? 0 : backgroundTasks;
  const statusLeads = statusPlacement === 'leading';
  // The leading placement shows live state on finished entries too, as
  // focused worktree rows do: question > running turn > unread > background
  // > idle. Background ranks below unread: a long-running server would
  // otherwise hide it for good.
  const leadingStatus: WorkEntryRowLeadingStatus | null = !statusLeads
    ? null
    : hasPendingQuestion
      ? 'needs-input'
      : working
        ? 'working'
        : hasUnread
          ? 'unread'
          : backgroundTasks > 0
            ? 'background'
            : 'idle';
  const hasTrailingStatus =
    !statusLeads &&
    (showWorking || shownBackgroundTasks > 0 || attentionDot !== null);

  const hasMenu = renderMenu !== undefined || renderMenuItems !== undefined;
  const compactActions =
    hoverActions === 'compact' &&
    (onTogglePin !== undefined || onArchive !== undefined);
  // Compact rows hold both Pin and Archive slots (an absent one stays empty)
  // so Pin never moves; ••• is touch-only there.
  const actionCount = compactActions
    ? 2
    : (onDelete ? 1 : 0) + (hasMenu ? 1 : 0);
  const coarseActionCount = autoDelete
    ? 0
    : compactActions
      ? hasMenu
        ? 1
        : 0
      : actionCount;

  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Early access (pointer-placed menus): the row stays lit while its menu is
  // open, so it is clear which row the menu acts on.
  const marksRowWhileMenuOpen = useContextMenuPlacement() === 'cursor';
  /** Right-click origin; null anchors the menu to the ••• button instead. */
  const [menuAnchorPoint, setMenuAnchorPoint] =
    useState<WorkEntryRowPoint | null>(null);
  /** The document body the right-click anchor portals into. */
  const [menuPortalBody, setMenuPortalBody] = useState<HTMLElement | null>(
    null,
  );
  const closeMenu = useCallback((): void => {
    setMenuOpen(false);
    setMenuAnchorPoint(null);
  }, []);

  const [unreadAnchorRect, setUnreadAnchorRect] = useState<DOMRect | null>(
    null,
  );
  const showUnreadPreview = useCallback((element: HTMLElement): void => {
    const anchor =
      element.closest<HTMLElement>('[data-entry-status]') ?? element;
    setUnreadAnchorRect(anchor.getBoundingClientRect());
  }, []);
  const hideUnreadPreview = useCallback((): void => {
    setUnreadAnchorRect(null);
  }, []);
  const toggleMenuFromButton = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      setMenuPortalBody(event.currentTarget.ownerDocument.body);
      setMenuAnchorPoint(null);
      setMenuOpen((open) => !open);
    },
    [],
  );

  const dragPointerDown = dragBinding?.onPointerDown;
  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (!dragPointerDown || multiSelect?.selectMode) return;
      if (!isOwnTarget(event.target, event.currentTarget)) return;
      if (isInteractiveTarget(event.target, event.currentTarget)) return;
      dragPointerDown(event);
    },
    [dragPointerDown, multiSelect?.selectMode],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!isOwnTarget(event.target, event.currentTarget)) return;
    // Enter on the ••• or Delete button activates that button, not the row.
    if (isInteractiveTarget(event.target, event.currentTarget)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (multiSelect?.selectMode && multiSelect.selectable) {
        multiSelect.onToggle();
        return;
      }
      // Opening from the keyboard moves the anchor like a plain click, so a
      // later Cmd-click never seeds a row that is no longer open.
      if (multiSelect !== undefined && !multiSelect.active) {
        if (multiSelect.selectable) multiSelect.onAnchor();
        else multiSelect.onClear();
      }
      onOpen?.();
      return;
    }
    // While the row's menu is open, Esc closes the menu, not the selection.
    if (multiSelect === undefined || menuOpen) return;
    const intent = resolveSelectionKey(event, multiSelect);
    if (intent === null) return;
    event.preventDefault();
    if (intent === 'toggle') multiSelect.onToggle();
    else if (intent === 'extend-up' || intent === 'extend-down') {
      const target = multiSelect.onExtend(intent === 'extend-up' ? -1 : 1);
      if (target !== undefined) {
        focusSelectionRow(
          event.currentTarget,
          WORK_ENTRY_SELECTION_ROW_ATTR,
          target,
        );
      }
    } else if (intent === 'select-all') multiSelect.onSelectAll();
    else multiSelect.onClear();
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!isOwnTarget(event.target, event.currentTarget)) return;
    if (multiSelect === undefined) {
      onOpen?.();
      return;
    }
    // A modified click on the row's own controls keeps their behavior.
    if (isInteractiveTarget(event.target, event.currentTarget)) {
      onOpen?.();
      return;
    }
    const intent =
      multiSelect.selectMode && multiSelect.selectable
        ? event.shiftKey
          ? 'range'
          : 'toggle'
        : resolveSelectionClick(event, multiSelect);
    if (intent === 'toggle' || intent === 'range') {
      event.preventDefault();
      if (intent === 'toggle') multiSelect.onToggle();
      else multiSelect.onSelectRange();
      return;
    }
    if (multiSelect.selectable) multiSelect.onAnchor();
    else multiSelect.onClear();
    onOpen?.();
  };

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
    if (!hasMenu) return;
    if (!isOwnTarget(event.target, event.currentTarget)) return;
    // Right-click opens the same menu the ••• button opens, anchored at the
    // pointer position.
    event.preventDefault();
    setMenuPortalBody(event.currentTarget.ownerDocument.body);
    setMenuAnchorPoint({ x: event.clientX, y: event.clientY });
    setMenuOpen(true);
  };

  const pinnedSuffix = isPinnedCopy ? `-${pinnedSurface}` : '';
  // Persistent metadata badges, in title-line order. The last one before the
  // status (or the actions) carries the coarse-pointer action reserve.
  // Compact rows draw the pin beside the age instead of as a badge.
  const pinnedBadge = pinnedToTop && !compactActions;
  const hasMetadataBadge =
    autoDelete !== undefined || sharedWithTeammates || pinnedBadge;
  const coarseReserveClassName = hasTrailingStatus
    ? ''
    : coarseActionCount === 2
      ? 'pointer-coarse:mr-11.5'
      : coarseActionCount === 1
        ? 'pointer-coarse:mr-5.5'
        : '';
  const menuContext: WorkEntryRowMenuContext = {
    close: closeMenu,
    testIdFor,
    onSelectItem: multiSelect?.selectable
      ? multiSelect.onSelectItem
      : undefined,
  };
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

  return (
    <div
      ref={dragBinding?.ref}
      style={dragBinding?.style}
      {...dragBinding?.attributes}
      role="button"
      aria-pressed={multiSelect?.selectMode ? multiSelected : undefined}
      tabIndex={0}
      data-testid={testIdFor('')}
      data-standalone-chat-id={isPinnedCopy ? undefined : entryId}
      data-sidebar-selected-item={selected && !isPinnedCopy ? '' : undefined}
      aria-current={selected && !isPinnedCopy ? 'page' : undefined}
      data-sidebar-selected-pin-disabled={disableSelectedPin ? '' : undefined}
      data-sidebar-selected-pin-seat={selectedPinSeat}
      data-entry-status={isDone ? 'done' : 'active'}
      {...intentHandlers}
      {...(multiSelect !== undefined
        ? { [WORK_ENTRY_SELECTION_ROW_ATTR]: multiSelect.rowKey }
        : {})}
      data-multiselected={multiSelected || undefined}
      onClick={handleClick}
      onDoubleClick={(event): void => {
        if (
          isOwnTarget(event.target, event.currentTarget) &&
          !isInteractiveTarget(event.target, event.currentTarget) &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          multiSelect?.selectable
        )
          multiSelect.onSelectItem?.();
      }}
      onMouseDown={
        multiSelect === undefined
          ? undefined
          : (event): void => {
              // The browser selects text on a Shift-click's mousedown,
              // before the click that extends the selection.
              if (
                shiftMouseDownSuppressesTextSelection(
                  event,
                  multiSelect.selectable,
                )
              ) {
                event.preventDefault();
              }
            }
      }
      onMouseLeave={hideUnreadPreview}
      onContextMenu={hasMenu ? handleContextMenu : undefined}
      onPointerDown={dragBinding ? handlePointerDown : undefined}
      onKeyDown={handleKeyDown}
      className={`group group/sidebar-item relative flex ${touchTarget ? 'min-h-11' : 'h-8'} w-full items-center gap-1.5 rounded-row px-1.5 py-0 text-left text-s transition-opacity ${
        dragBinding ? 'touch-none select-none' : ''
      } ${multiSelected ? 'bg-muted fg-primary' : selected && !multiSelect?.active ? 'bg-muted fg-primary' : `fg-secondary hover:bg-subtle${menuOpen && marksRowWhileMenuOpen ? ' bg-subtle' : ''}`} ${
        removing ? 'pointer-events-none opacity-50' : ''
      } ${dragBinding?.isDragging === true ? 'opacity-50' : ''}`}
    >
      {multiSelected && <span className="sr-only">Selected</span>}
      {multiSelect?.selectMode ? (
        <span className="flex size-5 shrink-0 items-center justify-center">
          <ChoiceMark
            kind="checkbox"
            checked={multiSelected}
            disabled={!multiSelect.selectable}
          />
        </span>
      ) : (
        <WorkEntryRowLeadingSlot
          done={isDone && !statusLeads}
          status={leadingStatus}
          backgroundTasks={backgroundTasks}
          testIdFor={testIdFor}
          onDotActivate={showUnreadPreview}
          onDotBlur={hideUnreadPreview}
        />
      )}
      {/* Done titles keep full text color: the state lives in the leading
          checkmark, matching code-worktree rows. */}
      <p
        className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate text-s font-normal leading-snug ${
          compactActions
            ? compactTitleReserveClassName(coarseActionCount, hasMetadataBadge)
            : titleReserveClassName(
                autoDelete ? 0 : actionCount,
                hasTrailingStatus,
                hasMetadataBadge,
              )
        }`}
        title={title}
      >
        {title}
      </p>
      {autoDelete && (
        <>
          {compactActions && (
            <WorkEntryRowCompactActions
              inline={autoDelete !== undefined}
              pinned={pinnedToTop}
              onTogglePin={onTogglePin}
              onArchive={onArchive}
              archiveDisabledReason={archiveDisabledReason}
              menuButtonRef={hasMenu ? menuButtonRef : undefined}
              menuOpen={menuOpen}
              onToggleMenu={toggleMenuFromButton}
              testIdFor={testIdFor}
            />
          )}
          {!compactActions && actionCount > 0 && (
            <WorkEntryRowActions
              inline={autoDelete !== undefined}
              onDelete={onDelete}
              deleteDisabledReason={deleteDisabledReason}
              menuButtonRef={hasMenu ? menuButtonRef : undefined}
              menuOpen={menuOpen}
              onToggleMenu={toggleMenuFromButton}
              testIdFor={testIdFor}
            />
          )}
          <SidebarAutoDeleteBadge
            autoDelete={autoDelete}
            onActivate={onAutoDeleteActivate}
            readOnly={autoDeleteReadOnly}
          />
        </>
      )}
      {/* Persistent metadata, outside the leading slot's priority contest:
          neither pinning nor shared-ness may hide the live status glyph. */}
      {pinnedBadge && (
        <SidebarPinnedBadge
          testId={`worktree-row-pinned-badge${pinnedSuffix}`}
          className={sharedWithTeammates ? undefined : coarseReserveClassName}
        />
      )}
      {sharedWithTeammates && (
        <SharedWithTeammatesBadge
          fadeOnRowHover
          testIdSuffix={pinnedSuffix}
          className={coarseReserveClassName}
        />
      )}
      {/* Beside the age, 6px off its 24px cell: the hover Archive button
          takes the age's cell and Pin (2px gap, 4px glyph inset) lands
          exactly here. */}
      {compactActions && pinnedToTop && (
        <span
          className="ml-auto inline-flex shrink-0 fg-quaternary group-hover/sidebar-item:hidden group-focus-within/sidebar-item:hidden pointer-coarse:hidden"
          role="img"
          aria-label="Pinned"
          data-testid={testIdFor('-pinned')}
        >
          <PinFilledIcon size={16} />
        </span>
      )}
      {!hasTrailingStatus && lastActivityAt !== undefined && (
        <SidebarRowAge
          lastActivityAt={lastActivityAt}
          hidesForActions={actionCount > 0}
          testId={testIdFor('-age')}
        />
      )}
      {hasTrailingStatus && (
        <WorkEntryRowTrailingStatus
          working={showWorking}
          backgroundTasks={shownBackgroundTasks}
          attentionDot={attentionDot}
          actionCount={autoDelete ? 0 : actionCount}
          testIdFor={testIdFor}
          onDotActivate={showUnreadPreview}
          onDotBlur={hideUnreadPreview}
        />
      )}
      {!autoDelete && (
        <>
          {compactActions && (
            <WorkEntryRowCompactActions
              inline={autoDelete !== undefined}
              pinned={pinnedToTop}
              onTogglePin={onTogglePin}
              onArchive={onArchive}
              archiveDisabledReason={archiveDisabledReason}
              menuButtonRef={hasMenu ? menuButtonRef : undefined}
              menuOpen={menuOpen}
              onToggleMenu={toggleMenuFromButton}
              testIdFor={testIdFor}
            />
          )}
          {!compactActions && actionCount > 0 && (
            <WorkEntryRowActions
              inline={autoDelete !== undefined}
              onDelete={onDelete}
              deleteDisabledReason={deleteDisabledReason}
              menuButtonRef={hasMenu ? menuButtonRef : undefined}
              menuOpen={menuOpen}
              onToggleMenu={toggleMenuFromButton}
              testIdFor={testIdFor}
            />
          )}
        </>
      )}
      {renderMenu
        ? renderMenu({
            ...menuContext,
            open: menuOpen,
            anchorRef: menuButtonRef,
            anchorPoint: menuAnchorPoint,
            popoverTestId: testIdFor('-menu-popover'),
          })
        : renderMenuItems !== undefined &&
          menuOpen &&
          menuPortalBody !== null && (
            <WorkEntryRowFloatingMenu
              anchorPoint={menuAnchorPoint}
              menuButtonRef={menuButtonRef}
              portalBody={menuPortalBody}
              onClose={closeMenu}
              label={menuLabel}
              testId={testIdFor('-menu-popover')}
            >
              {renderMenuItems(menuContext)}
            </WorkEntryRowFloatingMenu>
          )}
      {unreadAnchorRect !== null &&
        hasUnread &&
        renderUnreadPreview?.(unreadAnchorRect)}
    </div>
  );
}

/**
 * The title's share of the action reserve, 28px per revealed rail button.
 * The title carries it only while no status renders; otherwise the status
 * slot's margin does, so the status slides left beside the revealed buttons.
 * On a coarse pointer a metadata badge (pin or shared) keeps its footprint
 * and carries the coarse reserve instead, so the title drops its own (two
 * would stack).
 */
function titleReserveClassName(
  actionCount: number,
  hasTrailingStatus: boolean,
  hasMetadataBadge: boolean,
): string {
  if (hasTrailingStatus || actionCount === 0) return '';
  if (actionCount === 1) {
    return hasMetadataBadge
      ? 'group-hover/sidebar-item:pr-7 group-focus-within/sidebar-item:pr-7'
      : 'group-hover/sidebar-item:pr-7 group-focus-within/sidebar-item:pr-7 pointer-coarse:pr-6';
  }
  return hasMetadataBadge
    ? 'group-hover/sidebar-item:pr-14 group-focus-within/sidebar-item:pr-14'
    : 'group-hover/sidebar-item:pr-14 group-focus-within/sidebar-item:pr-14 pointer-coarse:pr-12';
}

/**
 * The compact title reserve: the two 28px hover buttons plus their 2px gap
 * (60px with the inset) on hover, and the touch-only ••• on a coarse pointer.
 */
function compactTitleReserveClassName(
  coarseActionCount: number,
  hasMetadataBadge: boolean,
): string {
  const hover =
    'group-hover/sidebar-item:pr-15 group-focus-within/sidebar-item:pr-15';
  return coarseActionCount > 0 && !hasMetadataBadge
    ? `${hover} pointer-coarse:pr-6`
    : hover;
}

type WorkEntryRowLeadingStatus =
  | 'needs-input'
  | 'working'
  | 'unread'
  | 'background'
  | 'idle';

interface WorkEntryRowLeadingSlotProps {
  done: boolean;
  /** The leading status indicator, or null for the trailing placement. */
  status: WorkEntryRowLeadingStatus | null;
  backgroundTasks: number;
  testIdFor: (suffix: string) => string;
  /** Opens the unread preview from a hovered or focused dot. */
  onDotActivate: (element: HTMLElement) => void;
  onDotBlur: () => void;
}

const LEADING_STATUS_LABELS: Record<WorkEntryRowLeadingStatus, string | null> =
  {
    'needs-input': 'Question waiting',
    working: 'Working',
    unread: 'Unread messages',
    background: null,
    idle: null,
  };

/**
 * The same w-5 leading column code-worktree rows reserve. It holds the done
 * checkmark (the shared Done status glyph); done titles keep full ink.
 */
function WorkEntryRowLeadingSlot({
  done,
  status,
  backgroundTasks,
  testIdFor,
  onDotActivate,
  onDotBlur,
}: WorkEntryRowLeadingSlotProps): JSX.Element {
  const label =
    status === 'background'
      ? backgroundTasksLabel(backgroundTasks)
      : status === null
        ? null
        : LEADING_STATUS_LABELS[status];
  const opensPreview = status === 'needs-input' || status === 'unread';
  const indicator =
    status === null ? null : (
      <span
        className="focus-ring pointer-events-auto relative inline-flex h-5 w-5 items-center justify-center rounded-sm outline-none"
        role={label === null ? undefined : 'img'}
        aria-label={label ?? undefined}
        tabIndex={opensPreview ? 0 : undefined}
        onMouseEnter={
          opensPreview
            ? (event: MouseEvent<HTMLSpanElement>): void =>
                onDotActivate(event.currentTarget)
            : undefined
        }
        onFocus={
          opensPreview
            ? (event: FocusEvent<HTMLSpanElement>): void =>
                onDotActivate(event.currentTarget)
            : undefined
        }
        onBlur={opensPreview ? onDotBlur : undefined}
        data-testid={testIdFor('-status')}
        data-row-status={status}
      >
        {status === 'working' || status === 'background' ? (
          // Follows Labs → Comet spinners; the comet keeps its 12px slot.
          <ThinkingSpinner
            tone={status === 'working' ? 'accent' : 'tertiary'}
            sizePx={12}
          />
        ) : (
          <span
            className={`rounded-full h-1.5 w-1.5 ${
              status === 'needs-input'
                ? 'bg-fg-warning'
                : status === 'unread'
                  ? SIDEBAR_INDICATOR_BLUE.background
                  : 'bg-fg-quaternary/50'
            }`}
            aria-hidden="true"
          />
        )}
      </span>
    );
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
      aria-hidden={done || label !== null ? undefined : 'true'}
      data-testid={testIdFor('-leading-slot')}
    >
      {/* Background work has no preview, so a tooltip names its count. */}
      {status === 'background' && label !== null ? (
        <Tooltip label={label}>{indicator}</Tooltip>
      ) : (
        indicator
      )}
      {done && (
        <Tooltip label="Done">
          <span
            className="inline-flex h-4 w-4 items-center justify-center"
            role="img"
            aria-label="Done"
            data-testid={testIdFor('-done')}
          >
            <StatusGlyph state="done" />
          </span>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * Done outranks every other state, as it does on code-worktree rows: a
 * finished entry shows only its leading checkmark. Otherwise the Working
 * spinner coexists with ONE attention dot, question (orange) over unread
 * (blue).
 */
export function workEntryAttentionDot(state: {
  done: boolean;
  hasPendingQuestion?: boolean;
  hasUnread?: boolean;
}): 'question' | 'unread' | null {
  if (state.done) return null;
  if (state.hasPendingQuestion) return 'question';
  return state.hasUnread ? 'unread' : null;
}

export interface WorkEntryRowTrailingStatusProps {
  working: boolean;
  /** Live background tasks: the neutral spinner when nothing is working. */
  backgroundTasks?: number;
  attentionDot: 'question' | 'unread' | null;
  /** Hover-revealed action buttons the cluster parks beside (0–2). */
  actionCount: number;
  testIdFor: (suffix: string) => string;
  /** Opens the unread preview from a hovered or focused dot. */
  onDotActivate?: (element: HTMLElement) => void;
  onDotBlur?: () => void;
}

/**
 * The status slot: the Working spinner beside at most one attention dot, in
 * action-button-sized w-6 slots whose last center sits under the right-most
 * 24px button (-mr-0.5). A hover margin parks the cluster flush beside the
 * revealed buttons, so it stays visible next to them.
 */
export function WorkEntryRowTrailingStatus({
  working,
  backgroundTasks = 0,
  attentionDot,
  actionCount,
  testIdFor,
  onDotActivate,
  onDotBlur,
}: WorkEntryRowTrailingStatusProps): JSX.Element {
  // A dot opens a preview only for a host that renders one.
  const dotProps = {
    className:
      'focus-ring pointer-events-auto relative inline-flex h-5 w-6 shrink-0 items-center justify-center rounded-sm outline-none',
    role: 'img',
    ...(onDotActivate
      ? {
          tabIndex: 0,
          onMouseEnter: (event: MouseEvent<HTMLSpanElement>): void =>
            onDotActivate(event.currentTarget),
          onFocus: (event: FocusEvent<HTMLSpanElement>): void =>
            onDotActivate(event.currentTarget),
          onBlur: onDotBlur,
        }
      : {}),
  };
  return (
    <span
      className={
        actionCount === 2
          ? 'inline-flex h-5 shrink-0 items-center justify-end -mr-0.5 pointer-fine:group-hover:mr-13.5 pointer-fine:group-focus-within:mr-13.5 pointer-coarse:mr-11.5'
          : actionCount === 1
            ? 'inline-flex h-5 shrink-0 items-center justify-end -mr-0.5 pointer-fine:group-hover:mr-6.5 pointer-fine:group-focus-within:mr-6.5 pointer-coarse:mr-5.5'
            : 'inline-flex h-5 shrink-0 items-center justify-end -mr-0.5'
      }
      data-testid={testIdFor('-status-slot')}
    >
      {/* The dots need no tooltip; they open the unread preview. */}
      {working ? (
        <AgentStateGlyph
          state="working"
          slot="row"
          testId={testIdFor('-thinking')}
        />
      ) : (
        backgroundTasks > 0 && (
          <AgentStateGlyph
            state="background"
            backgroundTasks={backgroundTasks}
            slot="row"
            testId={testIdFor('-background')}
          />
        )
      )}
      {attentionDot === 'question' && (
        <span
          {...dotProps}
          aria-label="Question waiting"
          data-testid={testIdFor('-question')}
        >
          <Dot tone="attention" />
        </span>
      )}
      {attentionDot === 'unread' && (
        <span
          {...dotProps}
          aria-label="Unread messages"
          data-testid={testIdFor('-unread')}
        >
          <Dot tone="unread" />
        </span>
      )}
    </span>
  );
}

interface WorkEntryRowActionsProps {
  inline?: boolean;
  onDelete?: (event: MouseEvent<HTMLButtonElement>) => void;
  deleteDisabledReason?: string;
  /** The ••• button's ref; omitted when the row has no menu. */
  menuButtonRef?: RefObject<HTMLButtonElement | null>;
  menuOpen: boolean;
  onToggleMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  testIdFor: (suffix: string) => string;
}

/** The hover-revealed Delete and ••• rail buttons at the row's end. */
function WorkEntryRowActions({
  inline = false,
  onDelete,
  deleteDisabledReason,
  menuButtonRef,
  menuOpen,
  onToggleMenu,
  testIdFor,
}: WorkEntryRowActionsProps): JSX.Element {
  return (
    <span
      className={
        inline
          ? 'pointer-events-none inline-flex shrink-0 items-center'
          : 'pointer-events-none absolute inset-y-0 right-1 flex items-center'
      }
    >
      {onDelete && (
        <RailIconButton
          icon={TrashIcon}
          tone="neutral"
          hoverSurface
          revealOnItemHover
          coarsePointerTarget
          onClick={(event): void => {
            event.stopPropagation();
            onDelete(event);
          }}
          disabled={deleteDisabledReason !== undefined}
          aria-label="Delete"
          tooltipLabel={deleteDisabledReason ?? 'Delete'}
          data-testid={testIdFor('-delete-button')}
        />
      )}
      {menuButtonRef && (
        <RailIconButton
          ref={menuButtonRef}
          icon={MoreHorizontalIcon}
          hoverSurface
          revealOnItemHover
          coarsePointerTarget
          onClick={onToggleMenu}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-testid={testIdFor('-menu')}
        />
      )}
    </span>
  );
}

interface WorkEntryRowCompactActionsProps {
  inline?: boolean;
  pinned: boolean;
  onTogglePin?: (pinned: boolean) => void;
  onArchive?: () => void;
  archiveDisabledReason?: string;
  /** The ••• button's ref; omitted when the row has no menu. */
  menuButtonRef?: RefObject<HTMLButtonElement | null>;
  menuOpen: boolean;
  onToggleMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  testIdFor: (suffix: string) => string;
}

/**
 * The compact hover Pin and Archive buttons. They end flush with the age's
 * right edge (`right-1.5`, the row's inset), so Archive covers the age's 24px
 * cell and Pin covers the resting pin icon. A missing action keeps its slot
 * empty so the other never moves. ••• stays for touch, which has no
 * right-click.
 */
function WorkEntryRowCompactActions({
  inline = false,
  pinned,
  onTogglePin,
  onArchive,
  archiveDisabledReason,
  menuButtonRef,
  menuOpen,
  onToggleMenu,
  testIdFor,
}: WorkEntryRowCompactActionsProps): JSX.Element {
  const slot = (
    <span aria-hidden="true" className="w-7 shrink-0 pointer-coarse:hidden" />
  );
  return (
    <span
      className={
        inline
          ? 'pointer-events-none inline-flex shrink-0 items-center gap-0.5'
          : 'pointer-events-none absolute inset-y-0 right-1.5 flex items-center gap-0.5'
      }
    >
      {onTogglePin ? (
        <RailIconButton
          icon={pinned ? PinFilledIcon : PinIcon}
          tone="neutral"
          hoverSurface
          revealOnItemHover
          className="pointer-coarse:hidden"
          onClick={(event): void => {
            event.stopPropagation();
            onTogglePin(!pinned);
          }}
          aria-label={pinned ? 'Unpin' : 'Pin'}
          aria-pressed={pinned}
          tooltipLabel={pinned ? 'Unpin' : 'Pin'}
          data-testid={testIdFor('-pin-button')}
        />
      ) : (
        slot
      )}
      {onArchive ? (
        <RailIconButton
          icon={ArchiveBoxIcon}
          tone="neutral"
          hoverSurface
          revealOnItemHover
          className="pointer-coarse:hidden"
          onClick={(event): void => {
            event.stopPropagation();
            onArchive();
          }}
          disabled={archiveDisabledReason !== undefined}
          aria-label="Archive"
          tooltipLabel={archiveDisabledReason ?? 'Archive'}
          data-testid={testIdFor('-archive-button')}
        />
      ) : (
        slot
      )}
      {/* RailIconButton sits in a tooltip wrapper, so the wrapper is what
          leaves fine pointers; a hidden button alone would keep a 2px gap. */}
      {menuButtonRef && (
        <span className="flex pointer-fine:hidden">
          <RailIconButton
            ref={menuButtonRef}
            icon={MoreHorizontalIcon}
            hoverSurface
            revealOnItemHover
            coarsePointerTarget
            onClick={onToggleMenu}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid={testIdFor('-menu')}
          />
        </span>
      )}
    </span>
  );
}

interface WorkEntryRowFloatingMenuProps {
  anchorPoint: WorkEntryRowPoint | null;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
  portalBody: HTMLElement;
  onClose: () => void;
  label?: string;
  testId: string;
  children: ReactNode;
}

/**
 * The shared menu surface, anchored under the ••• button or, for a
 * right-click, at a zero-size point portaled to the body (so a transformed
 * or clipped row cannot displace it). No entry motion: this is a
 * high-frequency context menu.
 */
function WorkEntryRowFloatingMenu({
  anchorPoint,
  menuButtonRef,
  portalBody,
  onClose,
  label,
  testId,
  children,
}: WorkEntryRowFloatingMenuProps): JSX.Element {
  const pointAnchorRef = useRef<HTMLSpanElement>(null);
  // Early access: a right-click menu sits 2px off the pointer on both axes,
  // the cursor placement's offset, rather than the button menu's 4px gap.
  const contextMenuPlacement = useContextMenuPlacement();
  const atCursor = anchorPoint !== null && contextMenuPlacement === 'cursor';
  const menu = (
    <FloatingMenu
      open
      onOpenChange={(open): void => {
        if (!open) onClose();
      }}
      {...(atCursor
        ? {
            gap: CONTEXT_MENU_POINTER_OFFSET,
            alignOffset: CONTEXT_MENU_POINTER_OFFSET,
          }
        : {})}
      anchorRef={anchorPoint ? pointAnchorRef : menuButtonRef}
      returnFocusRef={menuButtonRef}
      placement="bottom-left"
      motion="none"
      className="sidebar-instant-interactions w-45"
      aria-label={label}
      data-testid={testId}
      onContextMenu={(event): void => event.preventDefault()}
    >
      {/* Early access: quieter rows (small text, tertiary icons). */}
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
  );
  if (!anchorPoint) return menu;
  return (
    <>
      <FloatingMenuPointAnchor
        ref={pointAnchorRef}
        x={anchorPoint.x}
        y={anchorPoint.y}
        ownerDocument={portalBody.ownerDocument}
      />
      {menu}
    </>
  );
}

/** Shared Work Entry row. Memoized: sidebars render many of them. */
export const WorkEntryRow = memo(WorkEntryRowImpl);

export interface WorkEntryRowMenuItemsProps {
  /** The row's menu context, from `renderMenuItems` or `renderMenu`. */
  menu: WorkEntryRowMenuContext;
  /** Whether the entry is pinned; drives Pin to top / Unpin. */
  pinned?: boolean;
  /** Shows Pin to top / Unpin, called with the next pin state. */
  onTogglePin?: (pinned: boolean) => void;
  /** Shows Rename. */
  onRename?: () => void;
  /** Whether the entry is done; drives Mark done / Mark active. */
  done?: boolean;
  /** Shows Mark done / Mark active, called with the next status. */
  onToggleDone?: (status: WorkEntryRowStatus) => void;
  /** Shows Share. */
  onShare?: () => void;
  /**
   * This entry's saved notification choice. Shows the Notifications choices
   * when supplied together with `onNotificationChoice`.
   */
  notifications?: SpaceNotificationMenuState;
  /** Saves a notification choice; `null` clears the override. Keeps the menu open. */
  onNotificationChoice?: (choice: SpaceNotificationMenuChoice) => void;
  /** The mode of an agent-armed removal. */
  autoDelete?: WorkEntryAutoDeleteRowState;
  onAutoDeleteDisarm?: () => void;
  /** Shows Archive. */
  onArchive?: () => void;
  /** Hover explanation for Archive. */
  archiveTitle?: string;
  /** Shows Delete. */
  onDelete?: () => void;
  /** Hover explanation for Delete, such as its retention window. */
  deleteTitle?: string;
  /**
   * Why the entry cannot be archived or deleted right now. Set, Archive and
   * Delete stay listed but disabled, with this reason as their explanation.
   */
  removalDisabledReason?: string;
  /** Organizing actions inserted directly after Pin. */
  afterPin?: ReactNode;
  /**
   * Rows inserted after the notifications and before the Archive and Delete
   * group, such as the bulk selection's Select.
   */
  beforeRemoval?: ReactNode;
}

/**
 * The standard rows of a Work Entry menu, in the order every sidebar item
 * menu uses: Pin first, then Rename, Mark done, Share, Notifications, and
 * Archive and Delete in their own last group. Each row renders only when its callback is supplied, so a
 * host lists exactly the commands it can run. Every row closes the menu
 * before its command, except a notification choice, which stays open to show
 * whether it saved.
 */
export function WorkEntryRowMenuItems({
  menu,
  pinned = false,
  onTogglePin,
  onRename,
  done = false,
  onToggleDone,
  onShare,
  notifications,
  onNotificationChoice,
  autoDelete,
  onAutoDeleteDisarm,
  onArchive,
  archiveTitle,
  onDelete,
  deleteTitle,
  removalDisabledReason,
  afterPin,
  beforeRemoval,
}: WorkEntryRowMenuItemsProps): JSX.Element {
  const removalDisabled = removalDisabledReason !== undefined;
  const hasActionRows = Boolean(
    onTogglePin || afterPin || onRename || onToggleDone || onShare,
  );
  const notificationsShown =
    notifications !== undefined &&
    onNotificationChoice !== undefined &&
    !spaceNotificationMenuUnavailable(notifications);
  const run =
    (command: () => void): ((event: MouseEvent<HTMLButtonElement>) => void) =>
    (event): void => {
      event.stopPropagation();
      menu.close();
      command();
    };
  return (
    // The worktree menu's row style: quiet rows, tertiary icon ink.
    <ActionMenuRowStyle>
      {onTogglePin && (
        <SidebarPinMenuItem
          testId={menu.testIdFor('-toggle-pin')}
          pinned={pinned}
          onToggle={(next): void => {
            menu.close();
            onTogglePin(next);
          }}
        />
      )}
      {afterPin}
      {onRename && (
        <DropdownMenuItem
          onClick={run(onRename)}
          data-testid={menu.testIdFor('-rename')}
        >
          <DropdownMenuItemIcon>
            <PencilIcon />
          </DropdownMenuItemIcon>
          Rename
        </DropdownMenuItem>
      )}
      {onToggleDone && (
        <DropdownMenuItem
          onClick={run((): void => onToggleDone(done ? 'active' : 'done'))}
          data-testid={menu.testIdFor('-toggle-done')}
        >
          <DropdownMenuItemIcon>
            <CheckIcon />
          </DropdownMenuItemIcon>
          {done ? 'Mark active' : 'Mark done'}
        </DropdownMenuItem>
      )}
      {onShare && (
        <DropdownMenuItem
          onClick={run(onShare)}
          data-testid={menu.testIdFor('-invite')}
        >
          <DropdownMenuItemIcon>
            <ShareIcon />
          </DropdownMenuItemIcon>
          Share
        </DropdownMenuItem>
      )}
      {notifications && onNotificationChoice && (
        <SpaceNotificationMenuItems
          state={notifications}
          onSelect={onNotificationChoice}
          testIdFor={menu.testIdFor}
        />
      )}
      {menu.onSelectItem && (
        <DropdownMenuItem
          onClick={run(menu.onSelectItem)}
          data-testid={menu.testIdFor('-select-item')}
        >
          <DropdownMenuItemIcon>
            <ListChecks />
          </DropdownMenuItemIcon>
          Select item
        </DropdownMenuItem>
      )}
      {beforeRemoval}
      {/* Archive and Delete end the menu in their own group. */}
      {(hasActionRows || notificationsShown || beforeRemoval !== undefined) &&
        (onArchive || onDelete) && <DropdownMenuDivider />}
      {autoDelete && onAutoDeleteDisarm && (
        <DropdownMenuItem
          onClick={run(onAutoDeleteDisarm)}
          data-testid={menu.testIdFor('-auto-delete-disarm')}
        >
          {autoDelete.mode === 'archive'
            ? 'Turn off auto-archive'
            : 'Turn off auto-delete'}
        </DropdownMenuItem>
      )}
      {onArchive && (
        <DropdownMenuItem
          onClick={run(onArchive)}
          disabled={removalDisabled}
          data-testid={menu.testIdFor('-archive')}
          title={removalDisabledReason ?? archiveTitle}
        >
          <DropdownMenuItemIcon>
            <ArchiveIcon />
          </DropdownMenuItemIcon>
          Archive
        </DropdownMenuItem>
      )}
      {onDelete && (
        <DropdownMenuItem
          onClick={run(onDelete)}
          disabled={removalDisabled}
          data-testid={menu.testIdFor('-delete')}
          title={removalDisabledReason ?? deleteTitle}
        >
          <DropdownMenuItemIcon>
            <TrashIcon />
          </DropdownMenuItemIcon>
          Delete
        </DropdownMenuItem>
      )}
    </ActionMenuRowStyle>
  );
}
