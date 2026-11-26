/**
 * Always-visible, icon-only row actions for data tables.
 *
 * This is the table variant of a row-action control: the buttons live inside a
 * normal right-aligned `<td>`, are always visible (no hover reveal), and the
 * destructive tone is an *armed* filled state used by two-step deletes.
 *
 * See `./RowActions.tsx` for the hover-revealed, absolutely positioned
 * `RowActionTray` / `RowActionButton` used by sidebar and attachment rows.
 * The two are deliberately separate: overloading one control would force the
 * tray's hover-only destructive styling and opt-in focus ring onto tables.
 *
 * Consumers: the Automations page tables and the Pipelines management table.
 */
import type { JSX, ReactNode } from 'react';
import { Button } from '../primitives/Button';
import { Tooltip } from '../primitives/Tooltip';

export interface TableActionButtonProps {
  /** Accessible name and tooltip text. */
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly tone?: 'default' | 'destructive';
  readonly testId?: string;
  /**
   * Toggle state for actions that flip a persisted boolean.
   *
   * Only set this when {@link TableActionButtonProps.label} stays constant
   * across states. A label that already flips to describe the next action
   * ("Disable pipeline" / "Enable pipeline") plus `aria-pressed` announces
   * "Disable pipeline, toggle button, pressed" — two contradictory readings of
   * one control. Pick one or the other.
   */
  readonly ariaPressed?: boolean;
  readonly children: ReactNode;
}

/**
 * One icon-only action inside a {@link TableActionsCell}. Clicks are stopped
 * from propagating so a row-level click handler does not also fire.
 */
export function TableActionButton({
  label,
  onClick,
  disabled,
  tone = 'default',
  testId,
  ariaPressed,
  children,
}: TableActionButtonProps): JSX.Element {
  // The destructive tone marks the *armed* half of a two-step delete, so it has
  // to read at a glance with no hover: DESIGN.md forbids hiding required
  // feedback behind hover, and a tooltip label flip alone left the armed state
  // communicated only by a faint tint on a 14px glyph. The solid destructive
  // fill makes "the next click deletes" unmistakable from across the row; at
  // rest the action is the quiet per-row ghost every list repeats.
  return (
    <Tooltip label={label}>
      <Button
        variant={tone === 'destructive' ? 'destructive' : 'ghost'}
        size="sm"
        iconOnly
        onClick={(event): void => {
          event.stopPropagation();
          onClick();
        }}
        disabled={disabled}
        aria-label={label}
        aria-pressed={ariaPressed}
        data-testid={testId}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

export interface TableActionsCellProps {
  readonly children: ReactNode;
  readonly testId?: string;
  /**
   * Fired when focus leaves the action group entirely. Used by two-step
   * destructive actions to disarm when the row is escaped.
   *
   * Deliberately NOT named `onBlurCapture`: that is a real React DOM prop with
   * capture-phase semantics, and this fires on the bubbling `onBlur` only once
   * focus has left the whole group. Reusing the DOM name would mislead callers.
   */
  readonly onFocusLeave?: () => void;
  /**
   * Fired when Escape is pressed inside the action group. Gives a two-step
   * destructive action an explicit dismiss that does not require moving focus
   * out of the row.
   *
   * Return `true` to signal the key was consumed; only then is propagation
   * stopped. Returning `false`/`undefined` lets Escape keep bubbling, so a
   * consumer rendering this table inside a drawer or dialog does not lose
   * Escape-to-close while focus sits in an action group.
   */
  readonly onEscape?: () => boolean | void;
}

/**
 * Right-aligned container for {@link TableActionButton}s. Isolates clicks from
 * the surrounding row so both consuming pages get identical spacing and
 * click behaviour.
 */
export function TableActionsCell({
  children,
  testId,
  onFocusLeave,
  onEscape,
}: TableActionsCellProps): JSX.Element {
  // On a coarse pointer each icon Button's hit area reaches 8px past its
  // circle, so the 16px gap lets neighbouring hit areas meet without
  // overlapping: a tap meant for Edit can never land on an armed Delete.
  return (
    <div
      className="flex items-center justify-end gap-0.5 pointer-coarse:gap-4"
      data-testid={testId}
      onClick={(event): void => event.stopPropagation()}
      onBlur={
        onFocusLeave
          ? (event): void => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                onFocusLeave();
              }
            }
          : undefined
      }
      onKeyDown={
        onEscape
          ? (event): void => {
              if (event.key !== 'Escape') {
                return;
              }
              if (onEscape() === true) {
                event.stopPropagation();
              }
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}
