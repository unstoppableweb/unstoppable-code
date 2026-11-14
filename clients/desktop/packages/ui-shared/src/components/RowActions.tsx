/**
 * Hover-revealed row actions for list-style rows.
 *
 * `RowActionTray` is absolutely positioned and reveals on row hover and focus,
 * and stays visible on touch, where neither exists. It backs sidebar,
 * attachment, and similar compact rows; its 28px quiet icon buttons fit the
 * 28–32px rows it floats over.
 *
 * See `./TableActions.tsx` for the always-visible, right-aligned
 * `TableActionButton` / `TableActionsCell` used inside data-table `<td>`s,
 * whose destructive tone is an *armed* filled state for two-step deletes. The
 * two are deliberately separate rather than one overloaded control.
 */
import type { JSX, ReactNode } from 'react';
import { Button } from './Button';
import { Tooltip } from './Tooltip';

export interface RowActionTrayProps {
  readonly children: ReactNode;
  readonly testId?: string;
  /** Reveal keyboard-focused actions as well as on row hover. */
  readonly revealOnFocus?: boolean;
  /** Keep replacement controls visible after their trigger unmounts. */
  readonly forceVisible?: boolean;
  /**
   * On touch, where the tray always shows, take its place in a flex row
   * instead of covering the row's label.
   */
  readonly inRowOnTouch?: boolean;
}

/**
 * Absolutely positioned row actions whose contents can change without
 * affecting the surrounding row's layout. The tray is as tall as its 28px
 * buttons and rounds with them.
 */
export function RowActionTray({
  children,
  testId,
  revealOnFocus = true,
  forceVisible = false,
  inRowOnTouch = false,
}: RowActionTrayProps): JSX.Element {
  const visibilityClasses = forceVisible
    ? 'pointer-events-auto opacity-100'
    : `pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100${
        revealOnFocus
          ? ' focus-within:pointer-events-auto focus-within:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
          : ''
      } pointer-coarse:pointer-events-auto pointer-coarse:opacity-100`;
  const touchClasses = inRowOnTouch
    ? ' pointer-coarse:static pointer-coarse:pr-1 pointer-coarse:shrink-0 pointer-coarse:translate-y-0 pointer-coarse:self-center pointer-coarse:bg-transparent pointer-coarse:shadow-none'
    : '';

  return (
    <div
      className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-full bg-card shadow-sm pointer-coarse:gap-4 transition-opacity ${visibilityClasses}${touchClasses}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export interface RowActionButtonProps {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /**
   * Kept for callers. Every row action draws the shared `Button` focus ring,
   * so this has no effect.
   */
  readonly focusRing?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
  /** Id of the element naming what the action applies to. */
  readonly describedBy?: string;
}

/**
 * Icon-only row action: the 28px quiet icon button, `ghost-destructive` when
 * it destroys something. `label` supplies its accessible name and tooltip.
 */
export function RowActionButton({
  label,
  destructive = false,
  disabled = false,
  onClick,
  children,
  testId,
  describedBy,
}: RowActionButtonProps): JSX.Element {
  return (
    <Tooltip label={label}>
      <Button
        variant={destructive ? 'ghost-destructive' : 'ghost-quiet'}
        size="sm"
        iconOnly
        disabled={disabled}
        onClick={(event): void => {
          event.stopPropagation();
          onClick();
        }}
        aria-label={label}
        aria-describedby={describedBy}
        data-testid={testId}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

export interface InlineDeleteConfirmProps {
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly deleting: boolean;
  readonly disabled?: boolean;
  /**
   * Confirm-button label. Defaults to `Delete?`; archive-retention surfaces
   * can supply `Archive?` when deletion archives the container.
   */
  readonly confirmLabel?: string;
  readonly confirmTestId?: string;
  readonly cancelTestId?: string;
  /** Kept for callers. Both buttons draw the shared `Button` focus ring. */
  readonly focusRing?: boolean;
  readonly autoFocusConfirm?: boolean;
}

/**
 * Compact confirmation controls intended to replace a row's action tray: the
 * solid destructive confirm and a ghost Cancel, both 28px `compact` capsules.
 */
export function InlineDeleteConfirm({
  onConfirm,
  onCancel,
  deleting,
  disabled = false,
  confirmLabel = 'Delete?',
  confirmTestId,
  cancelTestId,
  autoFocusConfirm = false,
}: InlineDeleteConfirmProps): JSX.Element {
  return (
    <span className="flex items-center gap-0.5">
      <Button
        variant="destructive"
        size="compact"
        autoFocus={autoFocusConfirm}
        onClick={(event): void => {
          event.stopPropagation();
          onConfirm();
        }}
        disabled={deleting || disabled}
        data-testid={confirmTestId}
      >
        {deleting ? '...' : confirmLabel}
      </Button>
      <Button
        variant="ghost"
        size="compact"
        onClick={(event): void => {
          event.stopPropagation();
          onCancel();
        }}
        data-testid={cancelTestId}
      >
        Cancel
      </Button>
    </span>
  );
}
