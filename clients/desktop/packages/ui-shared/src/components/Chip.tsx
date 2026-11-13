import type { JSX, ReactNode } from 'react';
import { CheckIcon, CloseIcon, type AppIcon } from '../icons/AppIcons';
import { Tooltip } from './Tooltip';

/** A state a gallery or lab can force so every look is visible at once. */
export type ChipForcedState = 'hover' | 'pressed' | 'remove-hover';

export interface ChipProps {
  /** The label. Plain text also names the remove button. */
  children: ReactNode;
  /** Optional leading glyph, drawn at 14px. */
  icon?: AppIcon;
  /** Makes the chip an action (open the file, switch the mode). */
  onClick?: () => void;
  /**
   * Makes the action a toggle (`aria-pressed`). Selected, the chip takes the
   * accent tint and ink and leads with a check in place of `icon`.
   */
  selected?: boolean;
  /** Test id for the action button. */
  actionTestId?: string;
  /** Adds a trailing remove button. */
  onRemove?: () => void;
  /**
   * Accessible name for the remove button. Defaults to `Remove <label>` when
   * the label is plain text.
   */
  removeLabel?: string;
  disabled?: boolean;
  /**
   * Names the element that describes the chip, for the action button. A
   * `Tooltip` around the chip sets it.
   */
  'aria-describedby'?: string;
  /**
   * Help text shown in the shared `Tooltip` on hover or keyboard focus, never
   * as a native `title`. The chip then sits in the tooltip's wrapper, so
   * `className` flex participation (`flex-1`, `shrink`) applies inside it.
   */
  title?: string;
  /** Placement only: margin, max width, flex participation. */
  className?: string;
  /** Draws the hover or pressed look without the pointer, for galleries. */
  forcedState?: ChipForcedState;
  'data-testid'?: string;
  /** Test id for the remove button. */
  removeTestId?: string;
}

const ROOT_CLASS =
  'inline-flex h-6 min-w-0 max-w-full shrink-0 select-none items-center gap-1 rounded-md text-xs';
const FILL_CLASS = 'bg-subtle fg-primary';
const SELECTED_FILL_CLASS = 'bg-accent-subtle fg-accent-strong';
// Hover is instant (no color transition) and a press dims and shrinks the
// chip, like `Button`. Both follow the chip's own action button, never the
// whole chip: a bare `hover:` would also light the chip while the pointer is
// on the remove button, hiding that button's hover, and a bare `active:`
// would press the whole chip when only remove is pressed. The forced variants
// draw the same looks for galleries. Tailwind's `scale-*` sets the CSS
// `scale` property, so the transition names it.
const INTERACTIVE_CLASS =
  'transition-[opacity,transform,scale] duration-150 has-[[data-chip-main]:hover]:bg-muted has-[[data-chip-main]:active]:scale-97 has-[[data-chip-main]:active]:opacity-70 data-[forced-state=hover]:bg-muted data-[forced-state=pressed]:scale-97 data-[forced-state=pressed]:bg-muted data-[forced-state=pressed]:opacity-70';
// Selected, hover and press keep the accent tint (its -subtle/80 hover)
// rather than dropping back to the neutral fill.
const SELECTED_INTERACTIVE_CLASS =
  'transition-[opacity,transform,scale] duration-150 has-[[data-chip-main]:hover]:bg-accent-subtle/80 has-[[data-chip-main]:active]:scale-97 has-[[data-chip-main]:active]:opacity-70 data-[forced-state=hover]:bg-accent-subtle/80 data-[forced-state=pressed]:scale-97 data-[forced-state=pressed]:bg-accent-subtle/80 data-[forced-state=pressed]:opacity-70';
// Disabled, the chip stays the click target, so a click is swallowed rather
// than handed to a clickable row behind it, like a disabled `Button`.
const DISABLED_CLASS = 'cursor-not-allowed opacity-40';
const MAIN_CLASS =
  'focus-ring inline-flex h-full min-w-0 items-center gap-1 rounded-md text-left';
// On a coarse pointer the 18px remove button reaches a 30px hit area.
const REMOVE_CLASS =
  "relative before:absolute before:content-[''] pointer-coarse:before:-inset-1.5 focus-ring inline-flex size-4.5 shrink-0 items-center justify-center rounded-sm fg-tertiary hover:bg-muted hover:fg-primary data-[forced-state=hover]:bg-muted data-[forced-state=hover]:fg-primary";

/**
 * A token the user can act on: an attached file, a composer mode, a
 * calendar event. Not a marker: a word that only shows a state is a
 * `Badge`. Optional leading icon, optional remove button.
 */
export function Chip({
  children,
  icon,
  onClick,
  selected,
  actionTestId,
  onRemove,
  removeLabel,
  disabled = false,
  'aria-describedby': describedBy,
  title,
  className,
  forcedState,
  'data-testid': testId,
  removeTestId,
}: ChipProps): JSX.Element {
  const interactive = onClick !== undefined || onRemove !== undefined;
  const Icon = selected === true ? CheckIcon : icon;
  // The padding sits on the action button when there is one, so the whole
  // chip up to the remove button is its hit area.
  const startPadding = Icon ? 'pl-1.5' : 'pl-2';
  const endPadding = onRemove ? 'pr-1' : 'pr-2';
  const rootClass = [
    ROOT_CLASS,
    selected === true ? SELECTED_FILL_CLASS : FILL_CLASS,
    onClick ? '' : startPadding,
    onClick || onRemove ? '' : endPadding,
    onRemove ? 'pr-0.5' : '',
    onClick && !disabled
      ? selected === true
        ? SELECTED_INTERACTIVE_CLASS
        : INTERACTIVE_CLASS
      : '',
    interactive && disabled ? DISABLED_CLASS : '',
    className ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  const iconNode = Icon ? (
    <Icon
      key="icon"
      size={14}
      // Selected, the check takes the chip's accent ink.
      className={selected === true ? 'shrink-0' : 'shrink-0 fg-secondary'}
      aria-hidden
    />
  ) : null;
  const text = (
    <span key="text" className="min-w-0 truncate">
      {children}
    </span>
  );
  const name =
    removeLabel ??
    (typeof children === 'string' ? `Remove ${children}` : 'Remove');
  // The icon and text stay direct children (no fragment) so a tooltip's
  // `aria-describedby` reaches the chip's buttons, not a fragment.
  const chip = (
    <span
      data-chip=""
      data-forced-state={
        forcedState === 'remove-hover' ? undefined : forcedState
      }
      data-testid={testId}
      className={rootClass}
    >
      {onClick ? (
        <button
          type="button"
          data-chip-main=""
          data-testid={actionTestId}
          aria-pressed={selected}
          aria-describedby={describedBy}
          className={`${MAIN_CLASS} ${startPadding} ${endPadding}`}
          onClick={onClick}
          disabled={disabled}
        >
          {iconNode}
          {text}
        </button>
      ) : (
        [iconNode, text]
      )}
      {onRemove ? (
        <button
          type="button"
          aria-label={name}
          data-testid={removeTestId}
          data-forced-state={
            forcedState === 'remove-hover' ? 'hover' : undefined
          }
          className={REMOVE_CLASS}
          onClick={onRemove}
          disabled={disabled}
        >
          <CloseIcon size={12} aria-hidden />
        </button>
      ) : null}
    </span>
  );
  if (title === undefined) return chip;
  return (
    <Tooltip label={title} className="max-w-full">
      {chip}
    </Tooltip>
  );
}
