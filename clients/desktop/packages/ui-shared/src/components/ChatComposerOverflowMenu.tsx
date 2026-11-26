import { ControlButton } from '../primitives/Button';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { CheckIcon, MoreHorizontalIcon } from '../icons/AppIcons';
import { focusMenuRow } from '../lib/input-modality';
import { DropdownMenuItem } from '../primitives/DropdownMenu';
import { FloatingMenu } from '../primitives/FloatingMenu';
import { Tooltip } from '../primitives/Tooltip';
import { useOverlayEscape } from '../primitives/useOverlayEscape';

/**
 * One entry in the composer's `⋯` overflow menu (CAN-1229). The menu is the
 * mobile home for the plan-mode, fast-mode, and thinking-level controls that
 * the desktop composer shows as inline chips — collapsing them keeps the mobile
 * toolbar to a single row. Each item is a controlled toggle/cycle: the host
 * owns the state and passes the resolved `active` flag plus a `stateLabel`
 * (e.g. `'On'`, `'High'`) so the current value is always visible in the menu.
 */
export interface ChatComposerOverflowMenuItemConfig {
  /** Stable key for React reconciliation + test selection. */
  key: string;
  /** Leading glyph (reuses the matching chip icon). */
  icon: ReactNode;
  /** Primary label, e.g. `'Plan mode'`, `'Thinking'`. */
  label: string;
  /** Current-state descriptor rendered trailing, e.g. `'On'`, `'Off'`, `'High'`. */
  stateLabel: string;
  /** Whether the control is currently on — drives the check indicator (and
   * `aria-checked` for `menuitemcheckbox` rows). */
  active: boolean;
  /**
   * ARIA role for the row. Defaults to `menuitemcheckbox` (binary toggles like
   * plan/fast). Pass `menuitem` for a multi-state cycler (thinking level), where
   * a binary `aria-checked` would mis-announce the value — the `stateLabel`
   * carries the level instead.
   */
  role?: 'menuitemcheckbox' | 'menuitem';
  /** Toggle/cycle handler. */
  onSelect: () => void;
  /**
   * Close the menu after selecting. Defaults to `true` (plan/fast toggles);
   * pass `false` for a cycler (thinking level) so the menu stays open and the
   * user can watch the value advance and tap again.
   */
  closeOnSelect?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  dataTestId?: string;
}

export interface ChatComposerOverflowMenuProps {
  /** Menu items, rendered top-to-bottom in array order. */
  items: ChatComposerOverflowMenuItemConfig[];
  /** Trigger button accessible name. Defaults to `'More composer options'`. */
  triggerAriaLabel?: string;
  /**
   * Trigger hover/focus help, shown through the rich {@link Tooltip} (never a
   * native `title`, CAN-2799). Defaults to the aria-label.
   */
  triggerTitle?: string;
  triggerDataTestId?: string;
  menuDataTestId?: string;
  /**
   * Non-interactive row rendered BELOW the items, inside the same surface.
   *
   * The phone composer folds its context-usage readout in here (it used to
   * lead the left rail as a bare spinner, i.e. the first thing in reading
   * order on the smallest screen, before the model name). It is presentational
   * on purpose: it is excluded from the roving-focus item list and carries
   * `role="presentation"`, so Arrow/Home/End keyboard navigation over the real
   * `menuitem`s is unchanged and no non-actionable row can take focus.
   */
  footerSlot?: ReactNode;
  /**
   * Optional host handle on the trigger button.
   *
   * The menu already restores focus to its own trigger when IT closes. This
   * exists for the other direction: an item here can open a SECOND surface the
   * host owns (the phone composer's Commands popup), and when that surface
   * closes, the host has to return focus somewhere. The control the user
   * actually opened it from is this trigger — on the phone tier the host's own
   * button is not rendered at all — so the host needs a handle on it. Purely an
   * out-parameter; the menu's behaviour does not change.
   */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/** Index of the next enabled item at/after `from`, wrapping; -1 if none. */
function nextEnabledIndex(
  items: ChatComposerOverflowMenuItemConfig[],
  from: number,
  step: 1 | -1,
): number {
  const count = items.length;
  if (count === 0) return -1;
  for (let i = 1; i <= count; i += 1) {
    const index = (((from + step * i) % count) + count) % count;
    if (!items[index]?.disabled) return index;
  }
  return -1;
}

function firstEnabledIndex(
  items: ChatComposerOverflowMenuItemConfig[],
): number {
  return items.findIndex((item) => !item.disabled);
}

function lastEnabledIndex(items: ChatComposerOverflowMenuItemConfig[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (!items[i]?.disabled) return i;
  }
  return -1;
}

/**
 * The composer `⋯` overflow menu (CAN-1229). Props-only and store-free so it can
 * live in `@canopy/ui-shared`: the host passes controlled toggle/cycle items and
 * the menu renders an ARIA `menu` of `menuitemcheckbox`s with full keyboard
 * support (Arrow/Home/End roving focus, Enter/Space activate, Escape/Tab close),
 * focus return to the trigger, outside-pointer-down dismissal, and shared
 * `useOverlayEscape` participation so it cooperates with the mobile drawers.
 */
export function ChatComposerOverflowMenu({
  items,
  triggerAriaLabel = 'More composer options',
  triggerTitle,
  triggerDataTestId,
  menuDataTestId,
  footerSlot,
  triggerRef: hostTriggerRef,
}: ChatComposerOverflowMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();
  const initialItemRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Mirrors the trigger node into the host's ref, when one was supplied, so the
  // host can return focus here after a surface IT owns closes.
  const assignTrigger = useCallback(
    (node: HTMLButtonElement | null): void => {
      triggerRef.current = node;
      if (hostTriggerRef) {
        hostTriggerRef.current = node;
      }
    },
    [hostTriggerRef],
  );

  const focusTrigger = useCallback((): void => {
    triggerRef.current?.focus();
  }, []);

  const close = useCallback((): void => {
    setOpen(false);
  }, []);

  const closeAndReturnFocus = useCallback((): void => {
    setOpen(false);
    focusTrigger();
  }, [focusTrigger]);

  // Escape closes even when focus has drifted off the menu, and joining the
  // shared overlay stack keeps a background drawer from also closing (the menu
  // is topmost). Escape raised while focus is inside the `role="menu"` boundary
  // is handled by the menu's own keydown below — `useOverlayEscape` ignores it.
  useOverlayEscape(open, closeAndReturnFocus);

  const openMenu = useCallback((index: number): void => {
    setActiveIndex(index);
    setOpen(true);
  }, []);

  // Focus the active item whenever the menu opens or the active row changes.
  // A click open leaves it unpainted until the first arrow; see `focusMenuRow`.
  useEffect(() => {
    if (!open) return;
    const item = itemRefs.current[activeIndex];
    if (item) focusMenuRow(item);
  }, [open, activeIndex]);

  const selectItem = useCallback(
    (item: ChatComposerOverflowMenuItemConfig): void => {
      if (item.disabled) return;
      item.onSelect();
      // A cycler (thinking) keeps the menu open so the advancing value stays
      // visible; a plain toggle closes and hands focus back to the trigger.
      if (item.closeOnSelect ?? true) {
        closeAndReturnFocus();
      }
    },
    [closeAndReturnFocus],
  );

  const onTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      // A footer-only menu (no items, e.g. the phone composer's context-usage
      // readout) is still something to show, and the click handler already
      // treats it that way.
      //
      // ENTER/SPACE ARE DELIBERATELY LEFT TO THE NATIVE ACTIVATION when there
      // is no item to focus. A `<button>` turns them into a click, which
      // reaches the click handler's `if (open) { close(); return; }` toggle —
      // so returning early here means the same key both opens AND closes the
      // menu. Swallowing them with `preventDefault()` would open it and then
      // leave the user unable to close it with the key they opened it with,
      // because focus never enters an itemless menu for the in-menu handler to
      // see. (Escape still works through the document-level `useOverlayEscape`,
      // but "Escape is your only way out" is not an acceptable answer.)
      //
      // THE ARROW KEYS HAVE NO SUCH FALLBACK — they produce no click — so they
      // must be handled here or they silently do nothing. `openMenu(0)` is the
      // neutral index: there is no item to focus, so the focus effect no-ops
      // and focus stays on the trigger.
      const hasItemToFocus = firstEnabledIndex(items) !== -1;

      if (event.key === 'Enter' || event.key === ' ') {
        if (!hasItemToFocus) return;
        event.preventDefault();
        openMenu(firstEnabledIndex(items));
      } else if (event.key === 'ArrowDown') {
        const first = firstEnabledIndex(items);
        // Only swallow the key when there is actually something to open.
        if (first === -1 && !footerSlot) return;
        event.preventDefault();
        openMenu(first === -1 ? 0 : first);
      } else if (event.key === 'ArrowUp') {
        const last = lastEnabledIndex(items);
        if (last === -1 && !footerSlot) return;
        event.preventDefault();
        openMenu(last === -1 ? 0 : last);
      }
    },
    [items, openMenu, footerSlot],
  );

  const onMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActiveIndex((current) => {
            const next = nextEnabledIndex(items, current, 1);
            return next === -1 ? current : next;
          });
          break;
        case 'ArrowUp':
          event.preventDefault();
          setActiveIndex((current) => {
            const prev = nextEnabledIndex(items, current, -1);
            return prev === -1 ? current : prev;
          });
          break;
        case 'Home':
          event.preventDefault();
          setActiveIndex((current) => {
            const first = firstEnabledIndex(items);
            return first === -1 ? current : first;
          });
          break;
        case 'End':
          event.preventDefault();
          setActiveIndex((current) => {
            const last = lastEnabledIndex(items);
            return last === -1 ? current : last;
          });
          break;
        case 'Enter':
        case ' ': {
          event.preventDefault();
          const item = items[activeIndex];
          if (item) selectItem(item);
          break;
        }
        case 'Escape':
          // Consume it so the shared overlay stack (background drawers) skips
          // this defaultPrevented Escape and only the menu closes.
          event.preventDefault();
          closeAndReturnFocus();
          break;
        case 'Tab':
          // Continue the document's tab order from the composer trigger.
          closeAndReturnFocus();
          break;
        default:
          break;
      }
    },
    [items, activeIndex, selectItem, closeAndReturnFocus],
  );

  return (
    <div className="relative shrink-0">
      {/* Suppressed while open so the tooltip never sits over the menu the
          trigger just revealed. */}
      <Tooltip label={triggerTitle ?? triggerAriaLabel} suppressed={open}>
        <ControlButton
          ref={assignTrigger}
          type="button"
          onClick={() => {
            if (open) {
              close();
              return;
            }
            const first = firstEnabledIndex(items);
            // Nothing to show — never open an empty/unfocusable menu. A
            // footer-only menu is still something to show, so it opens; there
            // is simply no item to move focus onto.
            if (first === -1 && !footerSlot) return;
            openMenu(first === -1 ? 0 : first);
          }}
          onKeyDown={onTriggerKeyDown}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={triggerAriaLabel}
          data-testid={triggerDataTestId}
          presentation="composer-overflow-trigger"
        >
          <MoreHorizontalIcon />
        </ControlButton>
      </Tooltip>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        initialFocusRef={initialItemRef}
        openOnArrowKeys={false}
        outsidePressSwallowsClick={false}
        placement="top-right"
        gap={8}
        motion="none"
        interaction="manual"
        role="menu"
        sizing="custom"
        data-canopy-browser-native-overlay="true"
        data-testid={menuDataTestId}
        aria-label={triggerAriaLabel}
        aria-orientation="vertical"
        onKeyDown={onMenuKeyDown}
        className="min-w-48"
      >
        {items.map((item, index) => (
          <DropdownMenuItem
            key={item.key}
            ref={(node) => {
              itemRefs.current[index] = node;
              if (index === activeIndex) initialItemRef.current = node;
            }}
            presentation="composer-overflow"
            selected={item.active}
            role={item.role ?? 'menuitemcheckbox'}
            aria-checked={
              (item.role ?? 'menuitemcheckbox') === 'menuitemcheckbox'
                ? item.active
                : undefined
            }
            aria-label={item.ariaLabel}
            disabled={item.disabled}
            tabIndex={index === activeIndex ? 0 : -1}
            data-testid={item.dataTestId}
            onClick={() => selectItem(item)}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {item.icon}
            </span>
            <span className="flex-1 truncate">{item.label}</span>
            <span className="shrink-0 text-xs fg-secondary">
              {item.stateLabel}
            </span>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center fg-accent">
              {item.active ? <CheckIcon size="sm" /> : null}
            </span>
          </DropdownMenuItem>
        ))}
        {footerSlot ? (
          <div
            // `presentation` strips the implicit row semantics rather than
            // announcing a menu item that cannot be activated.
            role="presentation"
            className="flex min-h-11 items-center gap-2.5 px-3 text-s fg-secondary"
            data-testid="chat-composer-overflow-footer"
          >
            {footerSlot}
          </div>
        ) : null}
      </FloatingMenu>
    </div>
  );
}
