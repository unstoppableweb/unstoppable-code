import type {
  AriaAttributes,
  JSX,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  Ref,
} from 'react';
import { Button, type ButtonVariant } from '../primitives/Button';
import { Tooltip } from '../primitives/Tooltip';
import { MorphLabel } from './MorphLabel';

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
   * Inside a `@container/topbar` narrower than 640px, the `primary` capsule
   * morphs into a 28px circle showing only its icon, so the status region
   * keeps its room; from 640px it shows only its label. The accessible name
   * and tooltip carry the meaning. The other variants keep their label.
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
  /** The rendered button, so a host can return focus to it. */
  buttonRef?: Ref<HTMLButtonElement>;
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
  buttonRef,
}: ExecutionActionButtonProps): JSX.Element {
  const collapses = iconOnlyWhenNarrow && variant === 'primary';
  const labelNode = label ? (
    <span
      data-execution-action-label
      className={`whitespace-nowrap ${collapses ? '' : labelClassName}${shimmer ? ' canopy-text-shimmer' : ''}`}
    >
      {label}
    </span>
  ) : null;
  const shared = {
    ref: buttonRef,
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
          // Narrow, the 28px icon circle; from 640px of top bar, the
          // labelled capsule. The content morphs between the two (icon out,
          // label in) and the button follows its width.
          contentWidth
          aria-label={ariaLabel}
          // Never a window drag handle: the top bar is a drag region and the
          // class is inert everywhere else, including the web.
          className={`electron-no-drag pointer-coarse:before:hidden ${className}`}
        >
          <span className="canopy-morph-pad" data-morph-at="topbar-640">
            <MorphLabel at="topbar-640" show="narrow">
              {icon}
            </MorphLabel>
            <MorphLabel at="topbar-640">{labelNode}</MorphLabel>
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
