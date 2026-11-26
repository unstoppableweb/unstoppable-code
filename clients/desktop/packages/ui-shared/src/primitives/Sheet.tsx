import { useRef, type HTMLAttributes, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss, useModalFocusTrap } from './DialogModal';
import { useOverlayEscape } from './useOverlayEscape';

// Pure display slide-in drawer shell. Mirrors DialogModal's scrim,
// Escape-stack, focus, and backdrop-click conventions. No Electron, no
// window.api, no Next router or stores referenced from this module.

interface SheetProps {
  /** Edge the panel slides in from. */
  side: 'left' | 'right';
  /** Whether the sheet is currently shown. When false, renders nothing. */
  open: boolean;
  onClose: () => void;
  /** Accessible label for the drawer dialog. */
  ariaLabel: string;
  children: ReactNode;
  /**
   * Override the panel width. Defaults to `w-[85vw] max-w-sm`. Pass a full
   * Tailwind width utility (e.g. `w-[90vw] max-w-md`) to replace it.
   */
  widthClassName?: string;
  /** Extra classes on the sliding panel element. */
  className?: string;
  /** Close when clicking the backdrop (default: true). */
  closeOnBackdrop?: boolean;
  /** Close when pressing Escape (default: closeOnBackdrop). */
  closeOnEscape?: boolean;
  /** Stable test ID placed on the sliding panel element. */
  dataTestId?: string;
}

export function Sheet({
  side,
  open,
  onClose,
  ariaLabel,
  children,
  widthClassName = 'w-[85vw] max-w-sm',
  className = '',
  closeOnBackdrop = true,
  closeOnEscape = closeOnBackdrop,
  dataTestId,
}: SheetProps): JSX.Element {
  // An open sheet remains the top Escape boundary even when it is not
  // dismissible. Otherwise Escape leaks through and closes the overlay below.
  useOverlayEscape(open, (): void => {
    if (closeOnEscape) onClose();
  });
  // A modal sheet keeps DialogModal's focus contract: Tab stays inside and
  // focus returns to the opener. Focus lands on the panel itself, not its
  // first control: a drawer that leads with a field would otherwise open
  // the phone keyboard with it. The next Tab reaches the first control.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useModalFocusTrap(panelRef, {
    enabled: open,
    focusSurface: true,
    initialFocusRef: undefined,
    restoreFocusRef: undefined,
    restoreFocusWhen: undefined,
    containment: 'window',
    ownerDocument: undefined,
  });
  const backdropDismiss = useBackdropDismiss(
    closeOnBackdrop ? onClose : undefined,
  );

  if (!open) return <></>;

  const isLeft = side === 'left';
  const justifyClass = isLeft ? 'justify-start' : 'justify-end';
  const panelAnimation = isLeft
    ? 'animate-slide-in-left'
    : 'animate-slide-in-right';
  // The panel shadow draws the edge ring; a second edge line doubled it.
  const edgeClass = isLeft ? 'rounded-r-2xl' : 'rounded-l-2xl';
  // Pad the panel's own outer edge (the one flush with the screen) and its
  // bottom by the device safe-area insets so drawer content clears a notch or
  // home indicator (CAN-1206). `env(safe-area-inset-*)` is 0 on non-notch
  // devices and desktop, so this is a no-op outside mobile. `overscroll-contain`
  // stops a scroll that reaches the drawer's top/bottom from chaining to the
  // page behind the backdrop.
  const safeAreaClass = `overscroll-contain pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${
    isLeft
      ? 'pl-[env(safe-area-inset-left)]'
      : 'pr-[env(safe-area-inset-right)]'
  }`;

  const overlay = (
    <div
      data-canopy-browser-native-overlay="true"
      className={`fixed inset-0 z-drawer flex ${justifyClass} bg-overlay-scrim animate-fade-in`}
      {...backdropDismiss}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={dataTestId}
        className={`${panelAnimation} ${widthClassName} ${edgeClass} ${safeAreaClass} flex h-full flex-col overflow-y-auto bg-base shadow-xl outline-none ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );

  // Portal to `<body>`, exactly as `DialogModal` already does, so no ancestor
  // can clip or re-anchor a viewport-anchored drawer.
  //
  // `fixed` is only viewport-relative while no ancestor establishes a
  // containing block for it. `container-type: size` computes to
  // `contain: size layout style`, and layout containment does exactly that —
  // so the web app shell's scrolling content region (which carries
  // `[container-type:size]` for its `100cqh` consumers) would otherwise inset
  // this scrim by the sidebar rail's width and the banner's height instead of
  // covering the viewport. Ancestor `overflow`/`transform` stacking contexts
  // and iOS Safari's fixed-in-scroll quirk (CAN-1294) are the same class of
  // problem.
  const targetDocument = typeof document !== 'undefined' ? document : undefined;
  return targetDocument?.body
    ? createPortal(overlay, targetDocument.body)
    : overlay;
}

/**
 * Where a {@link PaneSheet} docks: `bottom` spans its pane's width 12px in,
 * capped at three fifths of its height; `top-end` hugs the pane's top end
 * corner 8px in, as a preview's find bar does; `window-top` is centred 12px
 * under the window's top edge, as the window-wide find bar is.
 */
export type PaneSheetPlacement = 'bottom' | 'top-end' | 'window-top';

const PANE_SHEET_PLACEMENT_CLASS: Record<PaneSheetPlacement, string> = {
  bottom: 'absolute bottom-3 right-3 z-20 max-h-3/5',
  'top-end': 'absolute right-2 top-2 z-20 max-w-[calc(100%-1rem)]',
  'window-top':
    'electron-no-drag fixed left-1/2 top-3 z-drawer w-max min-w-[min(28rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] -translate-x-1/2',
};

interface PaneSheetProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'className' | 'style' | 'role' | 'children'
> {
  readonly placement: PaneSheetPlacement;
  /**
   * The start edge of a `bottom` sheet: `edge` sits 12px in; `controls`
   * clears a column of pane controls there (a canvas's zoom buttons).
   */
  readonly start?: 'edge' | 'controls';
  /** `search` is a find bar's 360px; otherwise the sheet sizes to its pane. */
  readonly width?: 'pane' | 'search';
  /**
   * `toolbar` (6px) for a row of toolbar buttons and a field; `controls`
   * (8px) for a bar of fields; `readout` (12px) for a detail.
   */
  readonly padding?: 'toolbar' | 'controls' | 'readout';
  /** `search` for a find bar; otherwise a labelled complementary region. */
  readonly role?: 'search' | 'complementary';
  /**
   * For `window-top`: the element to portal into (a dialog the bar searches),
   * defaulting to the document body.
   */
  readonly portalContainer?: HTMLElement | null;
  readonly 'data-testid'?: string;
  readonly children: ReactNode;
}

const PANE_SHEET_PADDING_CLASS = {
  toolbar: 'p-1.5',
  controls: 'p-2',
  readout: 'p-3',
} as const;

// A field's 10px corner plus the inset, so a field at the sheet's edge nests
// in its corner; a readout holds text, so it keeps the menu's 12px.
const PANE_SHEET_RADIUS_CLASS = {
  toolbar: 'rounded-xl',
  controls: 'rounded-[calc(var(--radius-row)+0.5rem)]',
  readout: 'rounded-lg',
} as const;

/**
 * A modeless panel docked to one edge of a pane, over the pane's content and
 * nothing else: a canvas's selected-node detail, a preview's find bar; or,
 * with `window-top`, to the window's top edge, as the window-wide find bar
 * is. A pane sheet renders in place inside the nearest positioned ancestor;
 * a window sheet is fixed and portaled. Either sits on the menu surface
 * (fill, radius, shadow) and scrolls itself when its content is taller than
 * its cap. It is not a dialog: it takes no focus and traps none, and the app
 * keeps working around it. Its content owns closing (a Close button, Escape
 * in its own field).
 */
export function PaneSheet({
  placement,
  start = 'edge',
  width = 'pane',
  padding = 'readout',
  role = 'complementary',
  portalContainer,
  children,
  ...rest
}: PaneSheetProps): JSX.Element {
  const startClass =
    placement === 'bottom' ? (start === 'controls' ? 'left-14' : 'left-3') : '';
  const sheet = (
    <div
      {...rest}
      role={role}
      className={`flex min-w-0 flex-col overflow-auto ${PANE_SHEET_RADIUS_CLASS[padding]} bg-quaternary fg-primary shadow-xl ${
        PANE_SHEET_PLACEMENT_CLASS[placement]
      } ${startClass} ${width === 'search' ? 'w-90' : ''} ${
        PANE_SHEET_PADDING_CLASS[padding]
      }`}
    >
      {children}
    </div>
  );
  if (placement !== 'window-top') return sheet;
  const container =
    portalContainer ?? (typeof document === 'undefined' ? null : document.body);
  return container ? createPortal(sheet, container) : sheet;
}
