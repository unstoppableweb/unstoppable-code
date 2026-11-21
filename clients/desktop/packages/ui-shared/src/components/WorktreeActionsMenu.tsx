'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { AppIcon } from '../icons/AppIcons';
import { MoreHorizontalIcon } from '../icons/AppIcons';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from './ActionMenuItems';
import type { SpaceNotificationMenuChoiceKey } from './SpaceNotificationMenu';
import { RailIconButton } from './RailIconButton';
import {
  CONTEXT_MENU_POINTER_OFFSET,
  useContextMenuPlacement,
} from './context-menu-placement';
import { FloatingMenu, FloatingMenuPointAnchor } from './FloatingMenu';
import { WorktreeRowActionChip } from './WorktreeRow';

export type WorktreeMenuItemKey =
  | 'set-label'
  | 'branch-info'
  | 'invite'
  | 'debug-info'
  | 'launch'
  | 'stop-scripts'
  | 'dispatch-pipeline'
  | 'split-pr'
  | 'create-branch'
  | 'ungroup-from-base'
  | 'ungroup-children'
  | 'group-children'
  | 'group-with-base'
  | 'add-repository'
  | 'move-to-organization'
  | 'split-workspace'
  | 'toggle-pin'
  | 'toggle-hidden'
  | 'toggle-selection'
  | 'bulk-archive'
  | 'bulk-delete'
  | 'clear-selection'
  | 'bulk-pin'
  | 'bulk-stop-scripts'
  | 'bulk-done'
  | 'bulk-hide'
  | 'bulk-notifications'
  /** The bulk Notifications submenu's choice rows: `bulk-notify-mute`. */
  | `bulk-${SpaceNotificationMenuChoiceKey}`
  | 'share-chat'
  | 'more'
  | 'notifications'
  | SpaceNotificationMenuChoiceKey
  | 'auto-delete-disarm'
  | 'archive'
  | 'delete'
  | `sidebar-group-${string}`;

/** A worktree menu row: the shared action menu row, keyed by worktree action. */
export type WorktreeMenuItem = ActionMenuItem<WorktreeMenuItemKey>;

/** The worktree menu's rows inside a submenu or another host's surface. */
export const WorktreeActionMenuItems = ActionMenuItems<WorktreeMenuItemKey>;

export interface WorktreeDirectAction {
  readonly key: string;
  readonly icon: AppIcon;
  readonly label: string;
  readonly onSelect: () => void;
  readonly tone?: 'neutral' | 'warning' | 'destructive';
  readonly testId?: string;
  readonly visibility?: 'fine-pointer' | 'coarse-pointer';
  /** Shown but unavailable; `tooltip` says why. */
  readonly disabled?: boolean;
  /** The hover tooltip; defaults to `label`. */
  readonly tooltip?: string;
}

export interface WorktreeActionsMenuProps {
  readonly items: readonly WorktreeMenuItem[];
  readonly accessibleLabel: string;
  readonly triggerTestId?: string;
  readonly menuTestId?: string;
  readonly triggerDataAttributes?: Readonly<Record<`data-${string}`, string>>;
  readonly alwaysVisible?: boolean;
  readonly directActions?: readonly WorktreeDirectAction[];
  /**
   * Hides the ••• trigger for fine pointers, for a host whose menu opens by
   * right-click. The trigger stays mounted, so the right-click still opens
   * the menu (and touch keeps the button).
   */
  readonly hideTriggerForFinePointer?: boolean;
  /**
   * Holds an empty fine-pointer button slot after the direct actions, for a
   * host whose last action is sometimes unavailable: the actions before it
   * keep their place instead of sliding right.
   */
  readonly reserveTrailingSlot?: boolean;
  /** Called once each time the menu opens, for hosts that read lazily. */
  readonly onOpen?: () => void;
}

/**
 * Registry connecting a mounted trigger button to its own `openAtPoint`, so a
 * host that only holds the row's DOM node (a right-click on the row, not the
 * button) can still open that row's existing menu, anchored at the pointer,
 * without threading an imperative handle through every intermediate slot.
 * Entries are added on mount/openAtPoint change and removed on unmount.
 */
const OPEN_AT_POINT_BY_TRIGGER = new WeakMap<
  HTMLButtonElement,
  (point: { x: number; y: number }) => void
>();

/** Stable hook for {@link openWorktreeActionsMenuAt} to find the trigger. */
const TRIGGER_SELECTOR = '[data-worktree-actions-trigger="true"]';

/**
 * Opens the `WorktreeActionsMenu` mounted somewhere inside `container`
 * (typically a row's own DOM element), anchored at `point`, mirroring the
 * legacy desktop rail's right-click-anywhere-on-the-row behavior. Returns
 * `false` when the row has no menu to open (for example, a menu emptied down
 * to nothing), so the caller can fall back to the browser's native menu.
 */
export function openWorktreeActionsMenuAt(
  container: HTMLElement,
  point: { x: number; y: number },
): boolean {
  const trigger = container.querySelector<HTMLButtonElement>(TRIGGER_SELECTOR);
  const openAtPoint = trigger
    ? OPEN_AT_POINT_BY_TRIGGER.get(trigger)
    : undefined;
  if (!openAtPoint) return false;
  openAtPoint(point);
  return true;
}

/**
 * Compact buttons {@link WorktreeActionsMenu} renders for these props on a
 * fine pointer: every direct action, plus the More trigger when the menu has
 * items. Hosts pass it to `WorktreeRow.actionChipButtonCount` so the row's
 * hover reserve always matches the chip. Keep it beside the render conditions
 * it mirrors (CAN-3053).
 */
export function worktreeActionsMenuButtonCount({
  items,
  directActions = [],
}: Pick<WorktreeActionsMenuProps, 'items' | 'directActions'>): number {
  return directActions.length + (items.length > 0 ? 1 : 0);
}

export const WorktreeActionsMenu = forwardRef<
  HTMLButtonElement,
  WorktreeActionsMenuProps
>(function WorktreeActionsMenu(
  {
    items,
    accessibleLabel,
    triggerTestId,
    menuTestId,
    triggerDataAttributes,
    alwaysVisible = false,
    directActions = [],
    hideTriggerForFinePointer = false,
    reserveTrailingSlot = false,
    onOpen,
  },
  forwardedRef,
): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const contextMenuPlacement = useContextMenuPlacement();
  // Set only for a right-click/context-menu-key open (`openAtPoint`); a
  // button-triggered open clears it so the menu re-anchors to the trigger
  // the next time it opens normally.
  const [pointerAnchor, setPointerAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pointAnchorRef = useRef<HTMLSpanElement | null>(null);
  const itemCount = items.length;

  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null): void => {
      triggerRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
  const closeAndReturnFocus = useCallback((): void => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  // Opens the menu anchored at an arbitrary point (a right-click, or the
  // ContextMenu key, on the row rather than this trigger button).
  // Registered per trigger element in `OPEN_AT_POINT_BY_TRIGGER` below so a
  // host holding only the row's DOM node can still reach it.
  const openAtPoint = useCallback(
    (point: { x: number; y: number }): void => {
      if (items.length === 0) return;
      setPointerAnchor(point);
      setOpen(true);
    },
    [items],
  );
  useEffect(() => {
    const node = triggerRef.current;
    if (!node) return undefined;
    OPEN_AT_POINT_BY_TRIGGER.set(node, openAtPoint);
    return (): void => {
      OPEN_AT_POINT_BY_TRIGGER.delete(node);
    };
  }, [openAtPoint]);
  useEffect(() => {
    if (!open) setPointerAnchor(null);
  }, [open]);
  // The latest callback is read through a ref so a host passing a fresh
  // closure each render does not re-run the read while the menu stays open.
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  const handleOpenChange = useCallback((next: boolean): void => {
    if (next) setPointerAnchor(null);
    setOpen(next);
  }, []);

  const selectItem = (item: WorktreeMenuItem): void => {
    if (item.disabled || !item.onSelect) return;
    item.onSelect();
    if (item.role !== 'menuitemradio') closeAndReturnFocus();
  };

  // Early access: a right-click opens the menu with its top-left corner at
  // the pointer, as desktop context menus do. Otherwise a pointer open keeps
  // the button-anchored shape: the menu's right edge at the pointer.
  const atCursor = pointerAnchor !== null && contextMenuPlacement === 'cursor';

  // Nothing to trigger, so no trigger. A host that withholds every row command
  // — the web rail on any route but `/chat`, which is navigation-only by
  // policy — otherwise rendered a "More actions" button whose click handler
  // opened at `items[-1]` and returned, i.e. a control that looked live on
  // hover and did nothing on press. Direct actions still render on their own.
  if (worktreeActionsMenuButtonCount({ items, directActions }) === 0)
    return null;

  return (
    <WorktreeRowActionChip
      menuOpen={open}
      // Early access (pointer-placed menus): the row stays lit while its menu
      // is open, so it is clear which row the menu acts on.
      marksRowWhileOpen={contextMenuPlacement === 'cursor'}
      alwaysVisible={alwaysVisible}
    >
      {directActions.map((action) => (
        <RailIconButton
          key={action.key}
          icon={action.icon}
          tone={action.tone}
          hoverSurface
          revealOnItemHover={!open && !alwaysVisible}
          coarsePointerTarget
          aria-label={action.label}
          tooltipLabel={action.tooltip}
          disabled={action.disabled}
          data-testid={action.testId}
          visibility={action.visibility}
          onClick={(event) => {
            event.stopPropagation();
            if (action.disabled === true) return;
            action.onSelect();
          }}
        />
      ))}
      {reserveTrailingSlot && (
        <span
          aria-hidden="true"
          className="w-7 shrink-0 pointer-coarse:hidden"
        />
      )}
      {itemCount > 0 && (
        // RailIconButton sits in a tooltip wrapper, so the wrapper is what
        // leaves fine pointers; a hidden button alone would keep the chip's
        // 2px gap and push the last hover action 4px off the row's edge.
        <span
          className={
            hideTriggerForFinePointer ? 'flex pointer-fine:hidden' : 'contents'
          }
        >
          <RailIconButton
            ref={setTriggerRef}
            icon={MoreHorizontalIcon}
            hoverSurface
            revealOnItemHover={!open && !alwaysVisible}
            coarsePointerTarget
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            data-worktree-actions-trigger="true"
            {...triggerDataAttributes}
            data-testid={triggerTestId}
            onClick={(event) => {
              event.stopPropagation();
              handleOpenChange(!open);
            }}
          />
        </span>
      )}
      {open && pointerAnchor ? (
        <FloatingMenuPointAnchor
          ref={pointAnchorRef}
          x={pointerAnchor.x}
          y={pointerAnchor.y}
          ownerDocument={triggerRef.current?.ownerDocument ?? document}
        />
      ) : null}
      <FloatingMenu
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={pointerAnchor ? pointAnchorRef : triggerRef}
        {...(pointerAnchor ? { anchorPoint: pointerAnchor } : {})}
        returnFocusRef={triggerRef}
        placement={atCursor ? 'bottom-left' : 'bottom-right'}
        {...(atCursor ? { gap: CONTEXT_MENU_POINTER_OFFSET } : {})}
        closeOnWindowChange={pointerAnchor !== null}
        // Rows close the menu themselves; a radio row keeps it open.
        closeOnSelect={false}
        id={menuId}
        aria-label={accessibleLabel}
        data-testid={menuTestId}
        // A fixed compact width, as the sidebar's other menus have: a long
        // status line wraps rather than widening the menu.
        className="w-45"
        // The menu portals to the body, but React bubbles its clicks
        // through the row, where a click would select the worktree.
        onClick={(event) => event.stopPropagation()}
      >
        <ActionMenuRowStyle>
          <WorktreeActionMenuItems items={items} onSelect={selectItem} />
        </ActionMenuRowStyle>
      </FloatingMenu>
    </WorktreeRowActionChip>
  );
});

WorktreeActionsMenu.displayName = 'WorktreeActionsMenu';
