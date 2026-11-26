'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { ChevronRightMediumIcon } from '../icons/AppIcons';
import {
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuItemTrailing,
  type DropdownMenuItemIconTone,
} from './DropdownMenu';
import { FLOATING_MENU_VIEWPORT_PADDING, FloatingMenu } from './FloatingMenu';

const DEFAULT_MENU_WIDTH_PX = 224;
const ANCHOR_INSET_PX = 0;
const HOVER_CLOSE_DELAY_MS = 180;

interface OpenFlyout {
  readonly trigger: HTMLElement;
  readonly menuRef: { readonly current: HTMLElement | null };
  /** Closes at once; `focusTarget` takes focus if the flyout held it. */
  readonly closeNow: (focusTarget: HTMLElement) => void;
}

/**
 * Open flyouts per document. Only one submenu shows at a time: opening one
 * closes every other open flyout at once (no hover grace), except the
 * flyouts it sits inside.
 */
const openFlyouts = new WeakMap<Document, Set<OpenFlyout>>();

function closeOtherFlyouts(trigger: HTMLElement): void {
  const flyouts = openFlyouts.get(trigger.ownerDocument);
  if (!flyouts) return;
  // Each flyout is portaled to the body, so walk up the chain of flyouts
  // holding the trigger, each one's trigger, and so on.
  const ancestors = new Set<OpenFlyout>();
  let node = trigger;
  for (;;) {
    const owner = [...flyouts].find(
      (flyout) => flyout.menuRef.current?.contains(node) === true,
    );
    if (!owner || ancestors.has(owner)) break;
    ancestors.add(owner);
    node = owner.trigger;
  }
  for (const flyout of [...flyouts]) {
    if (flyout.trigger === trigger || ancestors.has(flyout)) continue;
    flyout.closeNow(trigger);
  }
}

export interface NestedMenuFlyoutProps {
  readonly triggerRef?: Ref<HTMLButtonElement>;
  readonly disabled?: boolean;
  readonly tabIndex?: number;
  readonly onTriggerFocus?: () => void;
  readonly label: string;
  readonly description?: string;
  readonly triggerTestId: string;
  readonly menuTestId: string;
  readonly children: ReactNode;
  /** False when row actions close the parent menu and restore its focus. */
  readonly closeOnSelect?: boolean;
  readonly leading?: ReactNode;
  /**
   * Quiet text before the chevron, such as how many entries the flyout
   * holds. Not drawn in `disclosure`, whose chevron leads.
   */
  readonly trailing?: ReactNode;
  /** Ink of the leading slot; see {@link DropdownMenuItemIconTone}. */
  readonly leadingTone?: DropdownMenuItemIconTone;
  /**
   * `parent` matches the width of the menu the flyout opens from (the
   * model picker's 16rem), so a label truncates no differently in the
   * flyout than in the list; `compact` is the sidebar account menu's 14rem,
   * so long labels truncate instead of widening the flyout; `default` sizes
   * the flyout to its rows.
   */
  readonly menuWidth?: 'default' | 'parent' | 'compact';
  readonly menuWidthPx?: number;
  /**
   * `disclosure` reads as a quiet expander: supporting ink with the chevron
   * leading the label, and no leading slot unless `keepLeadingSlot`.
   */
  readonly appearance?: 'default' | 'disclosure';
  /** Keep the leading slot in `disclosure` so the label lines up with rows. */
  readonly keepLeadingSlot?: boolean;
  /**
   * The flyout holds the current selection. The row keeps the tinted surface
   * a highlighted picker gives its selected row, in place of a checkmark.
   */
  readonly containsSelection?: boolean;
}

/** Shared right/left-colliding submenu used by action and picker menus. */
export function NestedMenuFlyout({
  label,
  description,
  triggerTestId,
  menuTestId,
  children,
  closeOnSelect = true,
  leading,
  trailing,
  leadingTone,
  menuWidth = 'default',
  menuWidthPx = DEFAULT_MENU_WIDTH_PX,
  appearance = 'default',
  keepLeadingSlot = false,
  containsSelection = false,
  triggerRef: forwardedTriggerRef,
  disabled = false,
  tabIndex,
  onTriggerFocus,
}: NestedMenuFlyoutProps): JSX.Element {
  const disclosure = appearance === 'disclosure';
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rightAnchorRef = useRef<HTMLSpanElement | null>(null);
  const leftAnchorRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  // Only a keyboard open moves focus into the flyout; a pointer open keeps it.
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const [side, setSide] = useState<'right' | 'left'>('right');
  const closeTimerRef = useRef<number | null>(null);

  const cancelPendingClose = useCallback((): void => {
    if (closeTimerRef.current === null) return;
    const view = triggerRef.current?.ownerDocument.defaultView;
    view?.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const openNow = useCallback((): void => {
    cancelPendingClose();
    if (triggerRef.current) closeOtherFlyouts(triggerRef.current);
    setOpen(true);
  }, [cancelPendingClose]);

  useEffect((): (() => void) | undefined => {
    const trigger = triggerRef.current;
    if (!open || !trigger) return undefined;
    const doc = trigger.ownerDocument;
    const flyouts = openFlyouts.get(doc) ?? new Set<OpenFlyout>();
    openFlyouts.set(doc, flyouts);
    const entry: OpenFlyout = {
      trigger,
      menuRef,
      closeNow: (focusTarget): void => {
        cancelPendingClose();
        // A keyboard-opened flyout holds focus; keep it in the menu.
        if (menuRef.current?.contains(doc.activeElement) === true)
          focusTarget.focus();
        setOpen(false);
      },
    };
    flyouts.add(entry);
    return (): void => {
      flyouts.delete(entry);
    };
  }, [cancelPendingClose, open]);

  const scheduleClose = useCallback(
    (event: PointerEvent<HTMLElement>): void => {
      cancelPendingClose();
      // Touch emits pointerleave after a tap; keep the choice's outcome visible.
      if (event.pointerType === 'touch') return;
      const view = triggerRef.current?.ownerDocument.defaultView;
      if (!view) return;
      closeTimerRef.current = view.setTimeout(() => {
        closeTimerRef.current = null;
        const doc = triggerRef.current?.ownerDocument;
        const active = doc?.activeElement ?? null;
        const flyoutHeldFocus =
          active !== null &&
          active !== doc?.body &&
          active.closest('[data-floating-menu-nested="true"]') !== null;
        setOpen(false);
        if (flyoutHeldFocus || active === doc?.body)
          triggerRef.current?.focus();
      }, HOVER_CLOSE_DELAY_MS);
    },
    [cancelPendingClose],
  );

  useEffect((): (() => void) => cancelPendingClose, [cancelPendingClose]);

  useLayoutEffect((): void => {
    if (!open) return;
    const row = triggerRef.current?.getBoundingClientRect();
    const view = triggerRef.current?.ownerDocument.defaultView;
    if (!row || !view) return;
    setSide(
      row.right +
        ANCHOR_INSET_PX +
        (menuRef.current?.offsetWidth ?? menuWidthPx) <=
        view.innerWidth - FLOATING_MENU_VIEWPORT_PADDING
        ? 'right'
        : 'left',
    );
  }, [menuWidthPx, open]);

  return (
    <>
      <DropdownMenuItem
        ref={(node): void => {
          triggerRef.current = node;
          if (typeof forwardedTriggerRef === 'function')
            forwardedTriggerRef(node);
          else if (forwardedTriggerRef) forwardedTriggerRef.current = node;
        }}
        disabled={disabled}
        tabIndex={tabIndex}
        onFocus={onTriggerFocus}
        className="relative min-w-0"
        tone={disclosure ? 'tertiary' : 'default'}
        expanded={open || containsSelection}
        data-contains-selection={containsSelection ? 'true' : undefined}
        data-testid={triggerTestId}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerEnter={(): void => {
          if (disabled) return;
          if (!open) setFocusOnOpen(false);
          openNow();
        }}
        onKeyDown={(event): void => {
          if (disabled || !['ArrowRight', 'Enter', ' '].includes(event.key))
            return;
          event.preventDefault();
          event.stopPropagation();
          setFocusOnOpen(true);
          openNow();
        }}
        onPointerLeave={scheduleClose}
        onClick={(event: MouseEvent<HTMLButtonElement>): void => {
          event.preventDefault();
          event.stopPropagation();
          if (disabled) return;
          setFocusOnOpen(event.detail === 0);
          openNow();
        }}
      >
        {!disclosure || keepLeadingSlot || leading ? (
          <DropdownMenuItemIcon tone={leadingTone}>
            {leading}
          </DropdownMenuItemIcon>
        ) : null}
        {disclosure ? (
          <ChevronRightMediumIcon
            size={16}
            className="shrink-0 fg-tertiary"
            aria-hidden="true"
          />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col truncate whitespace-nowrap">
          <span className="truncate">{label}</span>
          {description ? (
            <span className="truncate text-2xs fg-tertiary">{description}</span>
          ) : null}
        </span>
        {!disclosure && trailing !== undefined ? (
          <DropdownMenuItemTrailing>{trailing}</DropdownMenuItemTrailing>
        ) : null}
        {disclosure ? null : (
          <ChevronRightMediumIcon
            size={16}
            className="shrink-0 fg-quaternary"
            aria-hidden="true"
          />
        )}
        <span
          ref={rightAnchorRef}
          aria-hidden="true"
          className="pointer-events-none absolute right-0 -top-1 h-0 w-0"
        />
        <span
          ref={leftAnchorRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 -top-1 h-0 w-0"
        />
      </DropdownMenuItem>
      {open ? (
        <FloatingMenu
          ref={menuRef}
          open
          nested
          closeOnSelect={closeOnSelect}
          sizing={menuWidth === 'default' ? 'content' : 'custom'}
          focusOnOpen={focusOnOpen}
          onOpenChange={(nextOpen): void => {
            if (!nextOpen) setOpen(false);
          }}
          anchorRef={side === 'right' ? rightAnchorRef : leftAnchorRef}
          returnFocusRef={triggerRef}
          placement={side === 'right' ? 'bottom-left' : 'bottom-right'}
          gap={0}
          onPointerEnter={cancelPendingClose}
          onPointerLeave={scheduleClose}
          onKeyDown={(event): void => {
            if (event.key === 'ArrowLeft' || event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
          data-testid={menuTestId}
          aria-label={label}
          className={
            menuWidth === 'parent'
              ? 'w-64 max-w-[calc(100vw-16px)]'
              : menuWidth === 'compact'
                ? 'w-56 max-w-[calc(100vw-16px)]'
                : ''
          }
        >
          {children}
        </FloatingMenu>
      ) : null}
    </>
  );
}
