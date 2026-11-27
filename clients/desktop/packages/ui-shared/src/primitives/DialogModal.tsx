import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type JSX,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  focusableWithin,
  isCoarsePointer,
  openingFocusTarget,
} from '../lib/focusable';
import {
  DIALOG_INITIAL_FOCUS_TARGET_EVENT,
  DIALOG_INITIAL_FOCUS_TARGET_SELECTOR,
} from '../lib/dialog-initial-focus';
import { Button } from './Button';
import { floatingSurfaceAnchor } from './Menu';
import { useOverlayEscape } from './useOverlayEscape';
import { CloseIcon as AppCatalogCloseIcon } from '../icons/AppIcons';

/**
 * Is this element still a real focus target in `doc`?
 *
 * `isConnected` is the load-bearing check: a confirmation frequently removes
 * the control that opened it, and `HTMLElement.focus()` on a detached node
 * silently does nothing.
 *
 * The realm check is deliberate too. `instanceof HTMLElement` uses the calling
 * realm's constructor, so a dialog rendered into an `ownerDocument` from
 * another window — an iframe, or a second Electron window, both already
 * supported by this component — would fail it for every element and skip
 * restoration entirely. Resolve the constructor from the owning view instead,
 * exactly as `useOverlayEscape` already does.
 */
function isRestorable(
  candidate: Element,
  doc: Document,
  ownerDocument: Document | undefined,
): candidate is HTMLElement {
  const view = (ownerDocument ?? doc).defaultView;
  const ElementConstructor = view?.HTMLElement;
  // A pulled-out panel's content is created in the opener window and adopted
  // into the panel's own document, so the control that opened a page there
  // is an instance of this realm's `HTMLElement`, not of that window's.
  const isElement =
    (ElementConstructor !== undefined &&
      candidate instanceof ElementConstructor) ||
    (typeof HTMLElement !== 'undefined' && candidate instanceof HTMLElement);
  return isElement && candidate.isConnected && !candidate.matches(':disabled');
}

/** Caller-named fallback when the original trigger no longer exists. */
function resolveFallbackFocus(
  restoreFocusRef: RefObject<HTMLElement | null> | undefined,
  doc: Document,
): HTMLElement | null {
  const named = restoreFocusRef?.current;
  if (named && named.isConnected) return named;
  // Nothing named and nothing to go back to. `<body>` is a poor destination,
  // but it is at least a real one and it is where the browser would have put
  // focus anyway; returning null here would leave focus on a node that is
  // about to be removed from the document.
  return doc.body;
}

// Pure display dialog shell. Callers pass `onClose` and children; no Electron,
// no window.api, no Next router or stores referenced from this module.

type DialogTitle = ReactNode;

export type DialogPlacement = 'center' | 'top';

/**
 * A top-placed card's gap above it: a tenth of the window, kept between 1rem
 * (short windows) and 6rem (tall ones). The max height leaves that gap and the
 * overlay's 1rem bottom padding, so the card never runs off the window and its
 * body scrolls instead.
 */
const TOP_PLACEMENT_GAP = 'clamp(1rem, 10dvh, 6rem)';
// Tailwind needs the literal; keep it in step with TOP_PLACEMENT_GAP.
const TOP_PLACEMENT_PADDING_CLASS = 'pt-[clamp(1rem,10dvh,6rem)]';
const TOP_PLACEMENT_MAX_HEIGHT = `calc(100dvh - ${TOP_PLACEMENT_GAP} - 1rem)`;

const maxWidthClasses: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  // `'full'` is the near-viewport surface: a card that is as wide as its
  // overlay allows. Pair it with `maxHeight` and `scrollableBody={false}`
  // when the body manages its own independently scrolling panes.
  full: 'max-w-none',
};

let nextFocusTrapId = 0;
/** Frames to keep retrying a focus return into a shell that is still inert. */
const INERT_RESTORE_ATTEMPTS = 10;
/**
 * A shell a window page still covers: `inert`, or hidden and marked
 * `aria-hidden` (the desktop main shell, which hides without `inert` so that
 * covering it does not restyle everything inside).
 */
const COVERED_SHELL_SELECTOR = '[inert], [aria-hidden="true"]';

interface FocusTrapEntry {
  readonly id: number;
  readonly card: Element;
  /** The pane a `containment="parent"` dialog covers; null for the window. */
  readonly pane: Element | null;
}

const focusTrapStacks = new WeakMap<Document, FocusTrapEntry[]>();

function addFocusTrap(
  doc: Document,
  trapId: number,
  card: Element,
  pane: Element | null,
): void {
  const stack = focusTrapStacks.get(doc) ?? [];
  stack.push({ id: trapId, card, pane });
  focusTrapStacks.set(doc, stack);
}

function removeFocusTrap(doc: Document, trapId: number): void {
  const stack = focusTrapStacks.get(doc);
  if (!stack) return;
  const index = stack.map((entry) => entry.id).lastIndexOf(trapId);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length === 0) focusTrapStacks.delete(doc);
}

/** The element is the card of a trapping dialog under `trapId`'s. */
function isTrapBelow(doc: Document, trapId: number, element: Element): boolean {
  const stack = focusTrapStacks.get(doc) ?? [];
  const index = stack.map((entry) => entry.id).lastIndexOf(trapId);
  return stack
    .slice(0, Math.max(0, index))
    .some((entry) => entry.card === element);
}

/**
 * Whether this trap handles a Tab pressed with focus on `active`. A dialog
 * over one pane handles only Tab from inside its pane, and does so even when
 * a dialog over another pane opened after it; anything opened over the whole
 * window after it takes Tab first, and so does a later dialog over the same
 * pane. A window-wide trap yields to later traps except pane dialogs whose
 * pane does not hold focus.
 */
function ownsTab(
  doc: Document,
  trapId: number,
  active: Element | null,
): boolean {
  const stack = focusTrapStacks.get(doc);
  if (!stack) return false;
  const index = stack.map((entry) => entry.id).lastIndexOf(trapId);
  const own = stack[index];
  if (!own) return false;
  if (own.pane !== null && !(active !== null && own.pane.contains(active)))
    return false;
  return stack
    .slice(index + 1)
    .every(
      (above) =>
        above.pane !== null &&
        !(active !== null && above.pane.contains(active)),
    );
}

/**
 * `confirm` is the compact confirmation and short-form shape: a 380px card
 * with the title, one sentence and the actions, no header rule and no close
 * button (Cancel and Escape close it). `confirm-wide` is the same card at
 * 400px, for a footer with three buttons. Both override `maxWidth`,
 * `headerBorder`, `headerSpacing` and `showCloseButton`.
 *
 * `page` is a whole page opened over the app (Settings, project settings, a
 * run or skill detail): the card fills the window inside a margin of scrim,
 * keeps the dialog radius and header, and traps focus by default, so Escape,
 * focus and motion match every other dialog. It overrides `maxWidth` and the
 * default `maxHeight`; a body with its own panes passes
 * `scrollableBody={false}`.
 */
export type DialogModalVariant =
  | 'default'
  | 'confirm'
  | 'confirm-wide'
  | 'page';

export type DialogInset = 'section' | 'flush';

interface DialogModalBaseProps {
  onClose: () => void;
  /** Card shape. Default keeps the classic header; see {@link DialogModalVariant}. */
  variant?: DialogModalVariant;
  /**
   * Optional subtitle shown below the title. A node, so a caller can block
   * one value in it (such as a person's name) from session replay.
   */
  subtitle?: ReactNode;
  titleId?: string;
  /**
   * Card width. `'full'` is the near-viewport surface — the card fills the
   * overlay, which drops its padding and corner radius below `sm` so the
   * dialog is genuinely full-bleed on a phone, and the card fills the phone's
   * height too, sizing to its content again from `sm` up. Use it for a detail
   * surface whose own layout needs the viewport (see CAN-3020); pair it with
   * `maxHeight="100%"` and `scrollableBody={false}`.
   *
   * A discrete union rather than a `className` width passthrough: the card
   * already emits a `max-w-*` utility, and appending a second one leaves two
   * declarations of equal specificity resolved by stylesheet order rather
   * than by the caller (the same trap `headerSpacing` documents above).
   */
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | 'full';
  children: ReactNode;
  /** Extra classes on the dialog card element */
  className?: string;
  /** CSS max-height for the dialog card element (default: min(80vh, 85dvh)); dvh tracks the visible mobile viewport so the card stays above browser chrome and keyboards */
  maxHeight?: string;
  /**
   * CSS height for the card. A body that fills its parent through
   * `position: absolute` (a virtualized transcript) contributes no intrinsic
   * height, so the card needs a definite one, not only `maxHeight`, for its
   * flex body to size.
   */
  height?: string;
  /** CSS min-height for the card, so a short or still-loading body does not collapse it. */
  minHeight?: string;
  /** Wrap children in a scrollable body (default: true); callers that manage their own card-level layout or scrolling can opt out */
  scrollableBody?: boolean;
  /** Close when clicking the backdrop (default: true) */
  closeOnBackdrop?: boolean;
  /** Close when pressing Escape (default: closeOnBackdrop) */
  closeOnEscape?: boolean;
  /** Document that receives Escape events and whose body hosts the portaled overlay (default: global document) */
  ownerDocument?: Document;
  portalContainer?: HTMLElement;
  /** Show border below header (default: true) */
  headerBorder?: boolean;
  /** Keep the close affordance visible but inert while work is committing. */
  closeButtonDisabled?: boolean;
  /**
   * Space between the header block and the body (default: `'default'`, 16px).
   *
   * `'tight'` (8px) is for a dialog whose body opens with a supporting line
   * that belongs to the title. At the default the header's 16px plus a body's
   * own top padding puts that line as far from the title as from the content
   * below it, so it reads as attached to neither.
   *
   * A discrete union rather than a `headerClassName` passthrough: the header
   * already sets `pb-4`, and appending a competing `pb-*` would leave both
   * declarations in the class list with equal specificity, resolved by
   * stylesheet order rather than by the caller.
   */
  headerSpacing?: 'default' | 'tight';
  /**
   * The dialog owns its insets (docs/design/layout.md#page-column-and-dialog-body).
   * Header, body and footer line up 24px (`section`) from the sides.
   *
   * - `'section'` (the default): the dialog also pads the body, 24px below the
   *   header's divider and on every side, and spaces the body's direct
   *   children 16px (`group`) apart. Callers pass blocks, never padding.
   * - `'flush'`: the body is left to the caller, for a body that lays itself
   *   out (a tab bar, a full-bleed list, a bordered footer, its own
   *   scroller). Its content aligns at 24px itself.
   */
  inset?: DialogInset;
  /** Stable test ID placed on the dialog card element */
  dataTestId?: string;
  /**
   * The id of the body element that describes the dialog (a page's alert
   * text, a load failure's reason), read with the title when it opens.
   */
  ariaDescribedBy?: string;
  /** Optional actions rendered at the right end of the subtitle row */
  headerActions?: ReactNode;
  /**
   * Optional actions rendered inline with (to the left of) the close button
   * in the top-right corner of the dialog. Use for primary affordances that
   * belong in the header chrome, not the body.
   */
  topRightActions?: ReactNode;
  /**
   * The dialog's action buttons (Cancel, Save, Done), drawn in the footer at
   * the bottom right in that order, outside the scrolling body. A dialog's
   * actions always go here, never beside the title in `topRightActions`.
   */
  footer?: ReactNode;
  /** Render the header close button (default: true). */
  showCloseButton?: boolean;
  /** Compact list dialogs align their title and circular close control. */
  headerAlignment?: 'start' | 'center';
  /** Extra classes on the full-screen backdrop/overlay element */
  overlayClassName?: string;
  /** Stable test ID on the scrim. */
  overlayDataTestId?: string;
  /**
   * `window` (default): the scrim covers the window, portaled to the body.
   * `parent`: the scrim covers only the nearest positioned ancestor and is
   * rendered in place, for a dialog that blocks one pane while the rest of
   * the app stays usable (a page's alert in the in-app browser pane). Focus,
   * Escape and motion are the same.
   */
  containment?: 'window' | 'parent';
  /**
   * Where the card sits vertically (default: `center`). `top` pins its top
   * edge a viewport-relative gap below the window's top, so a dialog whose
   * content changes height (switching panels) grows downward instead of
   * jumping. The card's default max height then fills the rest of the window.
   */
  placement?: DialogPlacement;
  /**
   * Move focus into the dialog on mount and keep it there while open, then
   * restore it on close.
   *
   * OPT-IN, defaulting to off (on for `variant="page"`). The card has always carried `aria-modal="true"`
   * while doing no focus management at all, so opening one left focus wherever
   * it was — on `<body>` if the activating control unmounted — and Tab walked
   * the page behind an overlay that claims to be modal. Every consumer would
   * benefit, but flipping the default would change focus behavior for ~120
   * existing call sites at once; callers adopt it deliberately instead.
   *
   * Restoration is conditional: if something else has claimed focus by the
   * time this unmounts (a surface reopening behind the dialog, say), that
   * wins rather than being yanked back.
   */
  trapFocus?: boolean;
  /**
   * First focus target when `trapFocus` is set. Defaults to the first
   * focusable descendant, which is the header close button. A descendant
   * marked `data-dialog-initial-focus` takes priority when this ref is omitted.
   *
   * Read through a latest-ref internally, so an inline conditional
   * (`enabled ? aRef : bRef`) is safe and will not rebuild the trap.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * On a coarse pointer, open on the first control that is not a text field,
   * so the touch keyboard stays closed until the user taps the field. Off by
   * default; set it where typing is optional on open (a rename).
   */
  keepTouchKeyboardClosed?: boolean;
  /**
   * What takes focus first when `trapFocus` is set (default: `'control'`, the
   * `initialFocusRef` target or first focusable descendant).
   *
   * `'dialog'` focuses the card itself. Use it for a dialog that can open
   * without the user asking, such as one an agent raises while the user is
   * typing: on a button, the next space or Enter would answer the dialog.
   * Tab from the card moves to the first control, Shift+Tab to the last.
   */
  initialFocus?: 'control' | 'dialog';
  /**
   * Where focus goes on close when the element that opened the dialog is gone.
   *
   * Confirmations routinely destroy their own trigger — removing a member,
   * revoking a key, deleting the row the menu belonged to. Without a fallback,
   * restoration targets a detached node, `focus()` no-ops, and focus is left on
   * `<body>`. Point this at a stable ancestor (the list, the toolbar) so
   * keyboard users resume somewhere meaningful. Falls back to `<body>` when
   * unset or itself detached.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** A scoped host can prevent restoration after its chat/account has changed. */
  restoreFocusWhen?: () => boolean;
  /**
   * @deprecated Dialogs always mount and unmount instantly. Retained for
   * source compatibility with callers that previously opted out of motion.
   */
  noEnterAnimation?: boolean;
}

interface DialogModalWithHeaderProps extends DialogModalBaseProps {
  /** The dialog's own header row: title, subtitle, actions and Close. */
  header?: 'default';
  title: DialogTitle;
}

interface DialogModalContentHeaderProps extends DialogModalBaseProps {
  /**
   * `content`: the body draws its own header (a detail page with its title,
   * back control and actions), so the dialog draws none and is named by the
   * body's heading, whose id is `titleId`. Escape, the scrim and focus work
   * as for every dialog; the body owns its own way to close.
   */
  header: 'content';
  title?: never;
  titleId: string;
  subtitle?: never;
  headerActions?: never;
  topRightActions?: never;
}

type DialogModalProps =
  | DialogModalWithHeaderProps
  | DialogModalContentHeaderProps;

/**
 * The floating surface was opened, at some depth, from a control inside
 * `surface`: its anchor is there, or inside another floating surface that
 * was.
 */
/**
 * Where focus really is: a floating surface draws at the page body, so follow
 * its anchors back to the control that opened it.
 */
function floatingOrigin(element: Element): Element {
  let current = element;
  for (let depth = 0; depth < 8; depth += 1) {
    const menu = current.closest('.canopy-floating-menu');
    const anchor = menu ? floatingSurfaceAnchor(menu) : null;
    if (!anchor) return current;
    current = anchor;
  }
  return current;
}

function ownedBySurface(menu: Element, surface: HTMLElement): boolean {
  let current: Element | null = menu;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const anchor = floatingSurfaceAnchor(current);
    if (!anchor) return false;
    if (surface.contains(anchor)) return true;
    current = anchor.closest('.canopy-floating-menu');
  }
  return false;
}

/**
 * A scrim press closes its overlay only when it starts and ends on the scrim.
 * A drag that starts in the card (selecting a field's text) and is released
 * past its edge fires `click` on the scrim, their common ancestor; that must
 * not close the overlay and lose the draft.
 */
export function useBackdropDismiss(onClose: (() => void) | undefined): {
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onClick: (event: MouseEvent<HTMLElement>) => void;
} {
  const pressedScrimRef = useRef(false);
  return {
    onPointerDown: (event): void => {
      pressedScrimRef.current = event.target === event.currentTarget;
    },
    onClick: (event): void => {
      const pressedScrim = pressedScrimRef.current;
      pressedScrimRef.current = false;
      if (onClose && pressedScrim && event.target === event.currentTarget) {
        onClose();
      }
    },
  };
}

interface ModalFocusTrapOptions {
  readonly enabled: boolean;
  /** Restore focus after a marked initial target was focused, even without a trap. */
  readonly initialFocusAppliedRef?: RefObject<boolean>;
  /** Focus the surface itself rather than its first control. */
  readonly focusSurface: boolean;
  readonly initialFocusRef: RefObject<HTMLElement | null> | undefined;
  readonly keepTouchKeyboardClosed?: boolean;
  readonly restoreFocusRef: RefObject<HTMLElement | null> | undefined;
  readonly restoreFocusWhen: (() => boolean) | undefined;
  readonly containment: 'window' | 'parent';
  readonly ownerDocument: Document | undefined;
}

/**
 * The modal focus contract shared by {@link DialogModal} and
 * {@link WindowPage}: while enabled, focus moves into the surface, Tab and
 * Shift+Tab stay inside it, and on disable focus goes back where it was (or
 * to a named fallback). DialogModal also restores focus after its marked
 * initial target is focused when its host intentionally leaves the trap off.
 */
export function useModalFocusTrap(
  cardRef: RefObject<HTMLElement | null>,
  {
    enabled,
    initialFocusAppliedRef,
    focusSurface,
    initialFocusRef,
    keepTouchKeyboardClosed = false,
    restoreFocusRef,
    restoreFocusWhen,
    containment,
    ownerDocument,
  }: ModalFocusTrapOptions,
): void {
  const focusTrapIdRef = useRef<number | null>(null);
  if (focusTrapIdRef.current === null) {
    nextFocusTrapId += 1;
    focusTrapIdRef.current = nextFocusTrapId;
  }

  // Read through a latest-ref so the effect depends on `trapFocus` alone. With
  // `initialFocusRef` in the dep array, a caller passing an inline conditional
  // (`enabled ? aRef : bRef`) would tear the trap down and rebuild it mid-
  // dialog: cleanup would restore focus, then the new run would re-capture
  // `previouslyFocused` from whatever happened to be focused INSIDE the dialog,
  // so closing would strand focus there instead of returning it.
  const initialFocusRefRef = useRef(initialFocusRef);
  initialFocusRefRef.current = initialFocusRef;
  const keepTouchKeyboardClosedRef = useRef(keepTouchKeyboardClosed);
  keepTouchKeyboardClosedRef.current = keepTouchKeyboardClosed;
  const restoreFocusWhenRef = useRef(restoreFocusWhen);
  restoreFocusWhenRef.current = restoreFocusWhen;
  const restoreFocusRefRef = useRef(restoreFocusRef);
  restoreFocusRefRef.current = restoreFocusRef;
  const containmentRef = useRef(containment);
  containmentRef.current = containment;
  const focusCardRef = useRef(focusSurface);
  focusCardRef.current = focusSurface;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const previouslyFocusedRef = useRef<Element | null>(null);
  const hasPreviousFocusRef = useRef(false);
  const effectGenerationRef = useRef(0);
  const restoresInitialFocus = initialFocusAppliedRef !== undefined;
  if (!enabled && !restoresInitialFocus) {
    previouslyFocusedRef.current = null;
    hasPreviousFocusRef.current = false;
  } else if (!hasPreviousFocusRef.current) {
    // Capture before a descendant's React `autoFocus` runs, so close restores
    // focus to the opener instead of the search field being removed.
    const doc =
      ownerDocument ?? (typeof document === 'undefined' ? null : document);
    if (doc) {
      previouslyFocusedRef.current = doc.activeElement;
      hasPreviousFocusRef.current = true;
    }
  }

  useLayoutEffect(() => {
    if (!enabled && !restoresInitialFocus) return;
    effectGenerationRef.current += 1;
    const card = cardRef.current;
    if (!card) return;
    const doc = card.ownerDocument;
    const previouslyFocused = previouslyFocusedRef.current ?? doc.activeElement;
    const trapId = focusTrapIdRef.current;
    if (trapId === null) return;
    if (enabled) {
      // The pane a pane dialog covers: its scrim's positioned parent.
      const pane =
        containmentRef.current === 'parent'
          ? (card.parentElement?.parentElement ?? null)
          : null;
      addFocusTrap(doc, trapId, card, pane);

      // Resolve the named target against the focusable set rather than
      // trusting it. A caller naturally names a semantic target ("the Cancel
      // button"), which can be `disabled` at mount — `ConfirmDialog` disables
      // Cancel while busy, so a dialog opened already-busy would `focus()` a
      // disabled node, silently no-op, and strand focus on `<body>` inside an
      // `aria-modal` surface: exactly the failure the trap exists to prevent.
      const focusables = focusableWithin(card);
      const named = initialFocusRefRef.current?.current;
      const marked = card.querySelector<HTMLElement>(
        DIALOG_INITIAL_FOCUS_TARGET_SELECTOR,
      );
      const preferred =
        named !== null && named !== undefined && focusables.includes(named)
          ? named
          : marked !== null && focusables.includes(marked)
            ? marked
            : focusables[0];
      const initial = focusCardRef.current
        ? card
        : keepTouchKeyboardClosedRef.current
          ? openingFocusTarget(preferred, focusables)
          : preferred;
      initial?.focus();
    }

    // Capture phase so the dialog claims Tab before anything underneath it.
    // A const arrow rather than a function declaration: declarations hoist, so
    // TypeScript drops the `if (!card) return` narrowing inside one.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !ownsTab(doc, trapId, doc.activeElement))
        return;
      const focusables = focusableWithin(card);
      if (focusables.length === 0) {
        // Nothing to move to; leaving Tab alone would walk the page behind an
        // `aria-modal` surface, which is the whole failure being closed here.
        event.preventDefault();
        return;
      }
      const active = doc.activeElement;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      // A menu, listbox or popover opened from one of this surface's own
      // controls draws at the page body; the trap knows it by its anchor,
      // with or without `aria-controls`. One opened from inside such a
      // surface (a select in a filters popover) handles Tab itself.
      const menu = active?.closest('.canopy-floating-menu');
      const anchor = menu ? floatingSurfaceAnchor(menu) : null;
      if (menu && anchor && card.contains(anchor)) {
        // A popover keeps Tab inside itself.
        if (menu.getAttribute('role') === 'dialog') return;
        // A menu or listbox closes on Tab with focus back on its trigger,
        // and Tab moves on from there, so the trap judges the boundary by
        // the trigger: past the last (or before the first) control it wraps.
        const atBoundary = (control: HTMLElement): boolean =>
          anchor === control || anchor.contains(control);
        if (event.shiftKey ? atBoundary(first) : atBoundary(last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
        return;
      }
      if (menu && ownedBySurface(menu, card)) return;
      // A dialog that does not trap (a report or follow-up opened over a
      // page) draws beside this card at the body. Tab inside it, or in a menu
      // opened from it, belongs to that dialog; pulling it back here would put
      // focus behind it.
      const otherDialog = active
        ? floatingOrigin(active).closest('[role="dialog"][aria-modal="true"]')
        : null;
      if (
        otherDialog &&
        otherDialog !== card &&
        !card.contains(otherDialog) &&
        !otherDialog.contains(card) &&
        !isTrapBelow(doc, trapId, otherDialog)
      )
        return;
      // The card itself is not a Tab stop, so Tab from it enters the controls
      // the same way Tab from behind the dialog does.
      const inside =
        active !== null && active !== card && card.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    if (enabled) doc.addEventListener('keydown', handleKeyDown, true);
    return (): void => {
      if (enabled) {
        doc.removeEventListener('keydown', handleKeyDown, true);
        removeFocusTrap(doc, trapId);
      }
      if (!enabled && initialFocusAppliedRef?.current !== true) return;
      const cleanupGeneration = ++effectGenerationRef.current;
      queueMicrotask(() => {
        // A new setup means this was an effect replay or the same surface is
        // still active. Do not restore focus from a stale cleanup.
        if (
          effectGenerationRef.current !== cleanupGeneration &&
          enabledRef.current === enabled
        )
          return;

        const active = doc.activeElement;
        // Only reclaim focus we still own. A caller that reopens its own
        // surface as the dialog resolves has already placed focus deliberately,
        // and pulling it back to the pre-dialog element would fight that.
        const stillOurs =
          active === null || active === doc.body || card.contains(active);
        if (!stillOurs || restoreFocusWhenRef.current?.() === false) return;

        // Layout-effect cleanup runs before React finishes the DOM mutations
        // for this commit. Resolve the trigger only afterward so removed or
        // disabled controls fall back to the caller's named target.
        const restoreTarget =
          previouslyFocused !== null &&
          previouslyFocused !== doc.body &&
          isRestorable(previouslyFocused, doc, ownerDocument)
            ? previouslyFocused
            : resolveFallbackFocus(restoreFocusRefRef.current, doc);
        // The shell behind a window page stays covered until it re-renders
        // (`inert`, or hidden under `aria-hidden`), so a target there cannot
        // take focus yet: try again on the next frames while focus is still
        // nowhere.
        const restore = (attempt: number): void => {
          if (!restoreTarget) return;
          restoreTarget.focus();
          const view = doc.defaultView;
          if (
            doc.activeElement === restoreTarget ||
            attempt >= INERT_RESTORE_ATTEMPTS ||
            !view ||
            restoreTarget.closest(COVERED_SHELL_SELECTOR) === null
          )
            return;
          view.requestAnimationFrame((): void => {
            const current = doc.activeElement;
            if (current === null || current === doc.body) restore(attempt + 1);
          });
        };
        restore(0);
      });
    };
  }, [cardRef, enabled, ownerDocument]);
}

/** Focus picker searches present initially or announced after an open action. */
function useDialogInitialFocusTarget(
  surfaceRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onFocus?: () => void,
): void {
  useEffect(() => {
    if (!enabled) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const doc = surface.ownerDocument;
    const view = doc.defaultView;
    if (!view) return;

    const selector = DIALOG_INITIAL_FOCUS_TARGET_SELECTOR;
    let userInteracted = false;
    let interactedAfterTarget = false;
    let suppressedTarget = false;
    let activationControl: Element | null = null;
    let target: HTMLElement | null = null;
    let frame: number | null = null;
    let framesRemaining = 0;

    const cancelFocusFrames = (): void => {
      if (frame !== null && typeof view.cancelAnimationFrame === 'function')
        view.cancelAnimationFrame(frame);
      frame = null;
      framesRemaining = 0;
    };
    const markUserInteraction = (event: Event): void => {
      userInteracted = true;
      if (target !== null) interactedAfterTarget = true;
      activationControl = null;
      const isActivation =
        event.type === 'pointerdown' ||
        (event instanceof view.KeyboardEvent &&
          (event.key === 'Enter' || event.key === ' '));
      const eventTarget = event.target;
      if (isActivation && eventTarget instanceof view.Element) {
        const control = eventTarget.closest('button, [role="button"]');
        if (control && surface.contains(control)) activationControl = control;
      }
      cancelFocusFrames();
    };
    const focusInitialTarget = (
      nextTarget: HTMLElement | null,
      retry = false,
    ): void => {
      if (
        !nextTarget ||
        !surface.contains(nextTarget) ||
        !focusableWithin(surface).includes(nextTarget)
      )
        return;
      const targetChanged = target !== nextTarget;
      if (targetChanged) {
        target = nextTarget;
        interactedAfterTarget = false;
        const role = activationControl?.getAttribute('role');
        const isToggle =
          activationControl?.hasAttribute('aria-pressed') === true ||
          activationControl?.hasAttribute('aria-checked') === true ||
          role === 'tab' ||
          role === 'switch';
        const isCollapsedDisclosure =
          activationControl?.getAttribute('aria-expanded') === 'false';
        // Deliberate picker-opening buttons and expanded disclosures move
        // focus to their new search. Tabs and state toggles only replace inline
        // content, and should leave focus on the control the user chose.
        suppressedTarget =
          userInteracted &&
          (activationControl === null || isToggle || isCollapsedDisclosure);
        cancelFocusFrames();
        if (suppressedTarget) return;
      } else {
        // Recheck after motion ends in case the surface animation displaced
        // focus, but never move it after the user has started using the field.
        if (!retry || suppressedTarget || interactedAfterTarget) return;
      }

      framesRemaining = 2;
      const focus = (): void => {
        if (
          !target?.isConnected ||
          !surface.contains(target) ||
          !focusableWithin(surface).includes(target) ||
          suppressedTarget ||
          interactedAfterTarget
        )
          return;
        target.focus();
        if (doc.activeElement === target) {
          onFocus?.();
        }
        framesRemaining -= 1;
        if (
          framesRemaining > 0 &&
          typeof view.requestAnimationFrame === 'function'
        )
          frame = view.requestAnimationFrame(focus);
      };
      focus();
    };
    const focusRegisteredTarget = (event: Event): void => {
      const nextTarget = event.target;
      if (
        nextTarget instanceof view.HTMLElement &&
        nextTarget.matches(selector)
      )
        focusInitialTarget(nextTarget);
    };
    const retryFocusInitialTarget = (): void => {
      focusInitialTarget(target, true);
    };

    doc.addEventListener('pointerdown', markUserInteraction, true);
    doc.addEventListener('keydown', markUserInteraction, true);
    surface.addEventListener(
      DIALOG_INITIAL_FOCUS_TARGET_EVENT,
      focusRegisteredTarget,
    );
    surface.addEventListener('animationend', retryFocusInitialTarget, true);
    surface.addEventListener('transitionend', retryFocusInitialTarget, true);
    focusInitialTarget(surface.querySelector<HTMLElement>(selector));
    return (): void => {
      cancelFocusFrames();
      doc.removeEventListener('pointerdown', markUserInteraction, true);
      doc.removeEventListener('keydown', markUserInteraction, true);
      surface.removeEventListener(
        DIALOG_INITIAL_FOCUS_TARGET_EVENT,
        focusRegisteredTarget,
      );
      surface.removeEventListener(
        'animationend',
        retryFocusInitialTarget,
        true,
      );
      surface.removeEventListener(
        'transitionend',
        retryFocusInitialTarget,
        true,
      );
    };
  }, [enabled, onFocus, surfaceRef]);
}

/**
 * A dialog's Close: the 28px ghost button around a 16px glyph. The glyph is
 * drawn at exactly 16px (the icon catalog would otherwise snap it to its
 * 14px tier, which reads as too small for the corner of a dialog).
 */
export function CloseButton({
  onClick,
  disabled = false,
}: {
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="compact"
      iconOnly
      onClick={onClick}
      disabled={disabled}
      aria-label="Close"
    >
      <AppCatalogCloseIcon size={16} exactSize aria-hidden="true" />
    </Button>
  );
}

export function DialogModal({
  onClose,
  variant = 'default',
  header = 'default',
  title,
  subtitle,
  titleId,
  maxWidth = 'lg',
  children,
  className = '',
  maxHeight,
  height,
  minHeight,
  scrollableBody = true,
  closeOnBackdrop = true,
  headerBorder = true,
  closeButtonDisabled = false,
  headerSpacing = 'default',
  inset = 'section',
  dataTestId,
  ariaDescribedBy,
  headerActions,
  topRightActions,
  footer,
  showCloseButton = true,
  headerAlignment = 'start',
  overlayClassName = '',
  overlayDataTestId,
  containment = 'window',
  placement = 'center',
  closeOnEscape = closeOnBackdrop,
  ownerDocument,
  portalContainer,
  trapFocus: trapFocusProp,
  initialFocus = 'control',
  initialFocusRef,
  keepTouchKeyboardClosed = false,
  restoreFocusRef,
  restoreFocusWhen,
}: DialogModalProps): JSX.Element {
  // A unique fallback, so a dialog stacked over another is never named by
  // the heading underneath it.
  const generatedTitleId = useId();
  const id = titleId ?? generatedTitleId;
  const pageShape = variant === 'page';
  const trapFocus = trapFocusProp ?? pageShape;
  const confirmShape = variant === 'confirm' || variant === 'confirm-wide';
  const borderClass = headerBorder && !confirmShape ? 'border-b' : '';
  // Both insets put the header and footer at 24px; only `section` pads the body.
  const owned = inset === 'section';
  const headerBottomClass = headerSpacing === 'tight' ? 'pb-2' : 'pb-4';
  // A dialog's proportions (docs/design/overlays.md#dialogs). The card's
  // content keeps one 24px line: the sides, the footer's buttons from the
  // bottom, and the title's own ink from the top (20px of padding plus the
  // leading above its first line). The header's end is 18px in, so Close's
  // 16px glyph, centered in its 28px button, ends on that same 24px line.
  // A page keeps the roomier 24px top of the page it stands in for.
  const headerTopClass = pageShape ? 'pt-6' : 'pt-5';
  const headerPadClass = confirmShape
    ? `pl-6 pr-4.5 ${headerTopClass}`
    : `pl-6 pr-4.5 ${headerTopClass} ${headerBottomClass}`;
  // The owned body: 24px sides, 16px below a header divider, the same as
  // above it (24px in a page; the header's own bottom inset is the gap
  // without a divider), blocks 16px apart. Above a
  // footer the body keeps 4px under its last control so the scroll edge
  // never clips its focus ring; without one it ends on the 24px inset.
  // The body always grows into the card, so a fixed-height dialog's
  // `flex-1` / `h-full` children get a height. Inside the dialog's scroller
  // it keeps its content height and scrolls; a body the caller lays out
  // itself (`scrollableBody={false}`) may also shrink, so its own scroller
  // keeps a definite height.
  const ownedBodyClass = `flex ${scrollableBody ? 'flex-1 ' : 'min-h-0 flex-1 '}flex-col gap-4 px-6 ${
    headerBorder && !confirmShape ? (pageShape ? 'pt-6' : 'pt-4') : ''
  } ${footer ? 'pb-1' : 'pb-6'}`;
  const footerPadClass = 'px-6 pb-6 pt-4';
  // One title for every dialog: the 16px medium of a confirmation. A dialog
  // is a small card, and the 18px semibold of a page heading outweighs the
  // 14px body under it. A page keeps the page heading.
  const titleClass = pageShape
    ? 'text-lg font-semibold fg-primary'
    : confirmShape
      ? 'text-m font-medium text-balance fg-primary'
      : 'text-m font-medium fg-primary';
  // The subtitle supports the title, so it steps under the body's 14px.
  const subtitleClass = pageShape
    ? 'text-s fg-secondary'
    : 'text-xs text-pretty fg-secondary';
  // Close and the header's actions center on the title's first line (24px,
  // 28px in a page) whatever their own height, instead of hanging from its
  // top.
  const titleLineClass = pageShape ? 'h-7' : 'h-6';
  const widthClass =
    variant === 'confirm'
      ? 'max-w-95'
      : variant === 'confirm-wide'
        ? 'max-w-100'
        : pageShape
          ? 'max-w-none'
          : maxWidthClasses[maxWidth];
  const renderCloseButton = showCloseButton && !confirmShape;
  // A full-bleed card on a phone clears the status bar and home indicator
  // (web pages use `viewport-fit=cover`); `env()` is 0 everywhere else.
  const overlayPadClass = pageShape
    ? 'px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-[max(1.5rem,env(safe-area-inset-top))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]'
    : maxWidth === 'full'
      ? 'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:p-4'
      : 'p-4';
  const placementClass =
    placement === 'top'
      ? `items-start ${TOP_PLACEMENT_PADDING_CLASS}`
      : 'items-center';
  const resolvedMaxHeight =
    maxHeight ??
    (pageShape
      ? '100%'
      : placement === 'top'
        ? TOP_PLACEMENT_MAX_HEIGHT
        : 'min(80vh, 85dvh)');
  const radiusClass =
    maxWidth === 'full' && !pageShape
      ? 'rounded-none sm:rounded-2xl'
      : 'rounded-2xl';
  // Full-bleed on a phone means the height as well as the width.
  const heightClass = pageShape
    ? 'h-full'
    : maxWidth === 'full'
      ? 'h-full sm:h-auto'
      : '';
  const cardRef = useRef<HTMLDivElement | null>(null);

  // A mounted dialog must remain the top Escape boundary even when it is not
  // dismissible. Dropping it from the shared overlay stack would expose a
  // dialog underneath, so one Escape could close the parent and unmount this
  // pending operation indirectly.
  useOverlayEscape(
    true,
    (): void => {
      if (closeOnEscape) onClose();
    },
    ownerDocument,
  );

  const focusCard = trapFocus && initialFocus === 'dialog';
  const initialFocusAppliedRef = useRef(false);
  const markInitialFocusApplied = useCallback((): void => {
    initialFocusAppliedRef.current = true;
  }, []);
  useModalFocusTrap(cardRef, {
    enabled: trapFocus,
    initialFocusAppliedRef,
    focusSurface: focusCard,
    initialFocusRef,
    keepTouchKeyboardClosed,
    restoreFocusRef,
    restoreFocusWhen,
    containment,
    ownerDocument,
  });
  useDialogInitialFocusTarget(
    cardRef,
    // A marked field would open the touch keyboard after all.
    !(keepTouchKeyboardClosed && isCoarsePointer(ownerDocument)),
    markInitialFocusApplied,
  );
  const backdropDismiss = useBackdropDismiss(
    closeOnBackdrop ? onClose : undefined,
  );

  const overlay: JSX.Element = (
    <div
      data-canopy-browser-native-overlay="true"
      data-canopy-overlay-root="modal"
      // Whether the modal covers the window or only the pane it sits in, for
      // window-wide shortcuts that must hold still behind the first kind.
      data-canopy-overlay-containment={containment}
      data-testid={overlayDataTestId}
      className={`${containment === 'parent' ? 'absolute' : 'fixed'} inset-0 z-modal flex ${placementClass} justify-center bg-overlay-scrim ${overlayPadClass} ${overlayClassName}`}
      {...backdropDismiss}
    >
      {/* `electron-no-drag`: a card (a page's header and Close above all) can
          land in a desktop window-drag band painted underneath. app-region
          hit testing ignores z-order, so without it a mouse press there drags
          the window instead of clicking. The scrim keeps dragging. */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        aria-describedby={ariaDescribedBy}
        data-testid={dataTestId}
        tabIndex={focusCard ? -1 : undefined}
        className={`electron-no-drag w-full ${widthClass} ${heightClass} flex flex-col overflow-hidden ${radiusClass} bg-card shadow-xl ${focusCard ? 'outline-none' : ''} ${className}`}
        style={{ maxHeight: resolvedMaxHeight, height, minHeight }}
        onClick={(e) => e.stopPropagation()}
      >
        {header === 'content' ? null : (
          <div
            className={`flex ${headerAlignment === 'center' ? 'items-center' : 'items-start'} justify-between ${headerPadClass} ${borderClass}`}
          >
            <div className="min-w-0 flex-1">
              <h2 id={id} className={titleClass}>
                {title}
              </h2>
              {(subtitle || headerActions) && (
                <div className="mt-0.5 flex items-center gap-3">
                  {subtitle && <p className={subtitleClass}>{subtitle}</p>}
                  {headerActions && (
                    <div className="ml-auto flex items-center gap-2">
                      {headerActions}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div
              className={`flex ${titleLineClass} shrink-0 items-center gap-2`}
            >
              {topRightActions}
              {renderCloseButton ? (
                <CloseButton onClick={onClose} disabled={closeButtonDisabled} />
              ) : null}
            </div>
          </div>
        )}
        {scrollableBody ? (
          <div
            // Above a footer the body keeps 4px under its last control, so
            // the scroll edge never clips that control's edge or focus ring.
            className={`flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain ${footer && !owned ? 'pb-1' : ''}`}
            data-dialog-body=""
          >
            {owned ? (
              <div className={ownedBodyClass}>{children}</div>
            ) : (
              children
            )}
          </div>
        ) : owned ? (
          <div className={ownedBodyClass} data-dialog-body="">
            {children}
          </div>
        ) : (
          children
        )}
        {footer ? (
          <div
            data-dialog-footer=""
            className={`flex shrink-0 items-center justify-end gap-2 ${footerPadClass}`}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  const targetDocument =
    ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);

  // Portal so ancestor overflow/transform/stacking contexts cannot clip or
  // re-anchor the modal, including iOS Safari's fixed-in-scroll quirk (CAN-1294).
  if (containment === 'parent') return overlay;
  const targetContainer = portalContainer ?? targetDocument?.body;
  return targetContainer ? createPortal(overlay, targetContainer) : overlay;
}

interface WindowPageProps {
  /** Shown. With `keepMounted`, a closed page stays mounted, hidden and inert. */
  readonly open?: boolean;
  /** Escape closes it (the topmost overlay first); Back is the caller's. */
  readonly onClose: () => void;
  /**
   * Keep the page mounted while closed, so a half-finished form survives
   * closing and reopening (Settings). It is then inert, ignores the pointer
   * and leaves the accessibility tree; the caller hides its content once its
   * own exit motion ends.
   */
  readonly keepMounted?: boolean;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  /** For the trigger's `aria-controls`. */
  readonly id?: string;
  readonly dataTestId?: string;
  /** First focus target; defaults to the first focusable control. */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /** Where focus goes on close when the control that opened it is gone. */
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
  /**
   * `false` renders in place, for a page whose host already sits outside
   * the app shell (Settings, mounted beside the shell at the app's root).
   */
  readonly portal?: boolean;
  /**
   * The document of the control that opened the page, when that is another
   * window's (a pulled-out panel): the page portals to that document's body
   * and takes its Escape and focus there. Defaults to this window's.
   */
  readonly ownerDocument?: Document;
  readonly children: ReactNode;
}

/**
 * A page that takes over the whole window, over the app: Settings and
 * project settings, each a rail beside a card. Unlike `DialogModal
 * variant="page"` there is no scrim or card of its own; the caller draws the
 * page edge to edge. It is modal: it portals to the body (so a hidden, inert
 * shell beneath never takes it along) unless `portal={false}`, sits on the
 * modal layer, moves focus
 * in on open and keeps Tab inside, closes on Escape, and sends focus back on
 * close. A live in-app browser page yields beneath it while it shows.
 */
export function WindowPage({
  open = true,
  onClose,
  keepMounted = false,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  id,
  dataTestId,
  initialFocusRef,
  restoreFocusRef,
  portal = true,
  ownerDocument,
  children,
}: WindowPageProps): JSX.Element | null {
  const pageRef = useRef<HTMLDivElement | null>(null);
  useOverlayEscape(open, onClose, ownerDocument);
  useModalFocusTrap(pageRef, {
    enabled: open,
    focusSurface: false,
    initialFocusRef,
    restoreFocusRef,
    restoreFocusWhen: undefined,
    containment: 'window',
    ownerDocument,
  });
  useDialogInitialFocusTarget(pageRef, open);
  if (!open && !keepMounted) return null;
  const page = (
    <div
      ref={pageRef}
      id={id}
      // A closed page stays mounted: it must not read as an open dialog to
      // anything that looks for one (the browser pane yielding, the release
      // highlights waiting for open modals to clear).
      role={open ? 'dialog' : undefined}
      aria-modal={open ? 'true' : undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-hidden={open ? undefined : 'true'}
      inert={!open}
      data-canopy-browser-native-overlay={open ? 'true' : undefined}
      data-canopy-overlay-root={open ? 'modal' : undefined}
      data-canopy-overlay-containment="window"
      data-testid={dataTestId}
      className={`fixed inset-0 z-modal flex ${open ? '' : 'pointer-events-none'}`}
    >
      {children}
    </div>
  );
  const portalDocument =
    ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
  return !portal || portalDocument === undefined
    ? page
    : createPortal(page, portalDocument.body);
}
