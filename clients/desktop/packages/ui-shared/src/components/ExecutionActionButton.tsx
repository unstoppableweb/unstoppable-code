import type {
  AriaAttributes,
  JSX,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from 'react';
import { Button, type ButtonVariant } from './Button';
import { Tooltip } from './Tooltip';

export type ExecutionActionButtonVariant =
  | 'default'
  | 'primary'
  | 'warning'
  | 'destructive'
  | 'destructive-chip'
  | 'ghost'
  | 'text'
  | 'ghost-destructive';

export interface ExecutionActionButtonProps extends Pick<
  AriaAttributes,
  'aria-describedby' | 'aria-haspopup'
> {
  /** Visible label. Pass an empty string to render an icon-only button. */
  label: ReactNode;
  /** Icon glyph rendered to the left of the label. */
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Test ID hook for automation. */
  dataTestId?: string;
  /** Optional `data-state` hook for hosts that expose a CTA state. */
  dataState?: string;
  /** Accessible label — required when the visible label is empty so the
   * button still announces meaningfully. */
  ariaLabel: string;
  variant?: ExecutionActionButtonVariant;
  /**
   * Where the action sits: an execution row, or a detail page's header
   * beside Share. Both draw the same 28px `compact` capsule, whose own hit
   * area grows to 44px on a coarse pointer.
   */
  placement?: 'row' | 'detail';
  /**
   * Inside a `@container/topbar` narrower than 640px, drop the label and
   * collapse the `primary` capsule to a 28px circle so the status region
   * keeps its room; the icon, accessible name, and tooltip carry the
   * meaning. The other variants keep their label.
   */
  iconOnlyWhenNarrow?: boolean;
  className?: string;
  labelClassName?: string;
  /** Draws the label in the shimmer that marks work in progress. */
  shimmer?: boolean;
  /** Hover/focus help shown in the shared rich tooltip (never a native title). */
  title?: string;
  /**
   * Whether keydown events stop at the button. Defaults to `true` for the
   * execution rows this was built for, where a row-level key handler must
   * not fire from a focused action. Pass `false` inside a detail page or
   * dialog that closes on a document-level Escape listener, or the focused
   * action swallows that shortcut.
   */
  stopKeyDownPropagation?: boolean;
}

/**
 * Each variant is a `Button` variant (docs/design/buttons.md). Labelled
 * actions are the 28px `compact` capsule; an empty label renders the 28px
 * `sm` icon-only circle. The chip tones are the ghosts that resolve or
 * destroy beside routine actions (`ghost`, `ghost-destructive`); `text` is
 * the same ghost repeated on every row; `destructive` (the Stop caption) is
 * the destructive ghost too, never a solid fill.
 */
const BUTTON_VARIANTS: Record<ExecutionActionButtonVariant, ButtonVariant> = {
  default: 'secondary',
  primary: 'primary',
  warning: 'ghost',
  destructive: 'ghost-destructive',
  'destructive-chip': 'ghost-destructive',
  ghost: 'ghost',
  text: 'ghost',
  'ghost-destructive': 'ghost-destructive',
};

/**
 * Narrow, the primary action is the 28px icon-only circle. From 640px of the
 * top bar the button widens to its label, and this inner span supplies the
 * labelled capsule's inset, which the icon-only button leaves out.
 */
const COLLAPSE_CONTENT_CLASS =
  'inline-flex items-center gap-1.5 @[640px]/topbar:px-3';
const COLLAPSED_LABEL_CLASS = 'hidden @[640px]/topbar:inline';

/**
 * Run/rerun/retry/stop and similar execution actions, on `Button` (see
 * {@link BUTTON_VARIANTS}). Pure display: parent owns the dispatch. The
 * wrapper adds only the click and keydown containment an execution row
 * needs, and keeps the action out of the window drag region.
 */
export function ExecutionActionButton({
  label,
  'aria-describedby': describedBy,
  'aria-haspopup': hasPopup,
  icon,
  onClick,
  disabled = false,
  dataTestId,
  dataState,
  ariaLabel,
  variant = 'default',
  iconOnlyWhenNarrow = false,
  className = '',
  labelClassName = '',
  shimmer = false,
  title,
  stopKeyDownPropagation = true,
}: ExecutionActionButtonProps): JSX.Element {
  const collapses = iconOnlyWhenNarrow && variant === 'primary';
  const labelNode = label ? (
    <span
      data-execution-action-label
      className={`whitespace-nowrap ${collapses ? COLLAPSED_LABEL_CLASS : labelClassName}${shimmer ? ' canopy-text-shimmer' : ''}`}
    >
      {label}
    </span>
  ) : null;
  const shared = {
    variant: BUTTON_VARIANTS[variant],
    disabled,
    'data-testid': dataTestId,
    'data-state': dataState,
    'data-execution-action-button': 'true',
    'aria-describedby': describedBy,
    'aria-haspopup': hasPopup,
    onClick: (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      onClick();
    },
    onKeyDown: stopKeyDownPropagation
      ? (event: KeyboardEvent<HTMLButtonElement>): void => {
          event.stopPropagation();
        }
      : undefined,
  };
  return (
    <Tooltip label={title} disabled={title === undefined}>
      {collapses ? (
        <Button
          {...shared}
          size="compact"
          iconOnly
          aria-label={ariaLabel}
          // Never a window drag handle: the top bar is a drag region and the
          // class is inert everywhere else, including the web.
          className={`electron-no-drag pointer-coarse:before:hidden @[640px]/topbar:w-auto ${className}`}
        >
          <span className={COLLAPSE_CONTENT_CLASS}>
            {icon}
            {labelNode}
          </span>
        </Button>
      ) : labelNode === null ? (
        <Button
          {...shared}
          size="sm"
          iconOnly
          aria-label={ariaLabel}
          // An icon action sits 8px from its neighbours in a run row, so it
          // keeps its own 28px target rather than growing over them on a
          // coarse pointer. Switches to Button's `touchArea` (#7528).
          className={`electron-no-drag pointer-coarse:before:hidden ${className}`}
        >
          {icon}
        </Button>
      ) : (
        <Button
          {...shared}
          size="compact"
          aria-label={ariaLabel}
          className={`electron-no-drag ${className}`}
        >
          {icon}
          {labelNode}
        </Button>
      )}
    </Tooltip>
  );
}
