'use client';

import { type JSX, type ReactNode, useCallback, useRef, useState } from 'react';
import { CloseMediumIcon } from '../icons/AppIcons';
import { Button } from '../primitives/Button';
import {
  FloatingMenu,
  type FloatingMenuPlacement,
} from '../primitives/FloatingMenu';

/** Which edge of the surrounding stack the hugged pill sits against. */
export type CtaBannerAlign = 'start' | 'end';

export interface CtaBannerProps {
  /** Optional leading glyph. Sized by the caller; rendered as-is. */
  icon?: ReactNode;
  /**
   * Single-line pill copy. The pill sizes itself to hold this, and truncates
   * rather than wrapping only when the surrounding column is too narrow.
   */
  message: string;
  /** Label for the accent action button that opens the popover. */
  actionLabel: string;
  onDismiss: () => void;
  dismissAriaLabel?: string;
  /**
   * Which edge of the surrounding stack to sit against. Defaults to `start`.
   * Callers in a corner-anchored stack pass the side that corner is on.
   */
  align?: CtaBannerAlign;
  /** Popover body. Rendered only while the popover is open. */
  children: ReactNode;
  popoverAriaLabel: string;
  popoverPlacement?: FloatingMenuPlacement;
  onPopoverOpenChange?: (open: boolean) => void;
  'data-testid'?: string;
}

/**
 * Generic dismissible CTA pill with a rich anchored popover.
 *
 * Mounts inside the in-app notification stack alongside `GuestUpgradeNudge`
 * and the toasts, so it follows the user's corner placement preference.
 *
 * **No auto-dismiss.** Unlike the toasts it sits next to, this pill never
 * schedules its own removal — visibility is entirely the caller's, via
 * `onDismiss` plus whatever gate the adapter applies. A toast that expires is
 * recoverable from notification history; this pill has no history entry, so a
 * timeout would be a silent loss, and auto-hiding would fight the popover by
 * yanking a QR code out from under a phone camera mid-scan. Do not add a
 * `durationMs` prop or an internal timer here; a future consumer that wants
 * toast-like expiry owns that timer itself.
 *
 * Popover open state lives here (`useState`); callers only observe it through
 * `onPopoverOpenChange`. Interaction state inside ui-shared is established
 * precedent (`FloatingMenu`, `Sheet`).
 *
 * `FloatingMenu` owns dismissal (Escape, outside click), the z-layer
 * (`--layer-floating-menu`), and focus restore back to the action button. Do
 * not add a second Escape path. Collision flipping means the default
 * `top-center` placement resolves itself for top-corner notification
 * placements without any plumbing here.
 *
 * Dismissing drops focus to `<body>`, which is accepted: the pill is an
 * unsolicited interruption in a notification stack, not a navigation step, so
 * there is no "place" in the tab order to return the user to. `FloatingMenu`
 * still restores focus to the action button when only the popover closes.
 *
 * **The pill sizes to its copy** (`w-max`) instead of to its container. It
 * renders in a fixed-width notification column (24rem in the desktop shell),
 * and a flex child with `width: auto` stretches to fill that column — which
 * left the message ellipsised inside a pill that had no more room to give.
 * `truncate` survives as the last resort for a window too narrow for the
 * copy, not as the normal state.
 *
 * `w-max`, not `w-fit`: `fit-content` clamps to the containing block, so a
 * pill whose copy outgrows the column would still truncate at 24rem. The pill
 * is a floating overlay, so it may exceed the column and grow across the app
 * behind it; the cap is the viewport (matching the stack's 1rem inset on each
 * side), which is the point past which growing would clip instead of overlap.
 *
 * A definite width also opts the pill out of flex's `stretch` default, which
 * falls back to flex-start, so `align` (not the parent's `align-items`) is
 * what keeps it against the correct edge of a corner-anchored stack — and is
 * what makes the overflow spill inward, away from that edge.
 *
 * `interaction="manual"` alone would leave the popover pointer-only — it keeps
 * focus on the trigger and closes on any Tab — so this opts into `trapFocus`
 * (focus lands inside on open, Tab cycles within) and hands `FloatingMenu` the
 * banner root as the outside-press boundary so the sibling dismiss X still
 * fires on the first click while the popover is open.
 */
export function CtaBanner({
  icon,
  message,
  actionLabel,
  onDismiss,
  dismissAriaLabel = 'Dismiss',
  align = 'start',
  children,
  popoverAriaLabel,
  popoverPlacement = 'top-center',
  onPopoverOpenChange,
  'data-testid': dataTestId,
}: CtaBannerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  // The pill's controls are siblings of the popover trigger, so without this
  // boundary an open popover reads a press on the dismiss X as an outside
  // dismiss: it closes AND swallows the click, and `onDismiss` never fires.
  const bannerRef = useRef<HTMLDivElement | null>(null);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      setOpen(next);
      onPopoverOpenChange?.(next);
    },
    [onPopoverOpenChange],
  );

  return (
    <div
      ref={bannerRef}
      role="status"
      aria-live="polite"
      data-testid={dataTestId}
      className={`pointer-events-auto animate-slide-up flex w-max max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full bg-card p-2 pl-3 fg-primary shadow-lg ${
        align === 'end' ? 'self-end' : 'self-start'
      }`}
    >
      {icon && (
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {icon}
        </span>
      )}
      {/* No `flex-1`: it would stretch the message back out inside the hugged
          pill. `min-w-0` still lets it shrink into the ellipsis when the
          column itself cannot hold the copy. */}
      <span className="min-w-0 truncate text-s fg-primary">{message}</span>
      <Button
        ref={actionRef}
        variant="primary"
        data-testid={dataTestId ? `${dataTestId}-action` : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => handleOpenChange(!open)}
      >
        {actionLabel}
      </Button>
      <Button
        variant="ghost"
        iconOnly
        data-testid={dataTestId ? `${dataTestId}-dismiss` : undefined}
        aria-label={dismissAriaLabel}
        onClick={onDismiss}
      >
        <CloseMediumIcon size={16} aria-hidden="true" />
      </Button>
      <FloatingMenu
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={actionRef}
        placement={popoverPlacement}
        interaction="manual"
        trapFocus
        outsidePressBoundaryRef={bannerRef}
        role="dialog"
        aria-label={popoverAriaLabel}
        data-testid={dataTestId ? `${dataTestId}-popover` : undefined}
      >
        {children}
      </FloatingMenu>
    </div>
  );
}
