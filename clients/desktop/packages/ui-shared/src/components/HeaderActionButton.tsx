import {
  createContext,
  forwardRef,
  useContext,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { Button, type ButtonVariant } from './Button';
import { Tooltip } from './Tooltip';

export type HeaderActionButtonTone =
  | 'accent'
  | 'neutral'
  | 'warning'
  | 'destructive';

interface HeaderActionButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Semantic foreground and hover treatment; geometry stays unchanged. */
  tone?: HeaderActionButtonTone;
  /**
   * Keep the hover surface while the enclosing `group/gitaction` is hovered.
   * While an action runs, its cancel ✕ is an overlay inside the group but
   * outside the pill, so without this the pill would drop its hover state the
   * moment the pointer reaches the ✕.
   */
  groupHover?: boolean;
  /**
   * Disabled, keep the tone's ink at 80% instead of the disabled ink, for a
   * control that stays in place while its action runs (Refresh).
   */
  quietWhenDisabled?: boolean;
  /**
   * How pressed and disabled states read. `default` keeps the established
   * look. `toolbar` (the early-access browser address bar) gives a pressed
   * toggle its hover look and drops a disabled icon control's name tooltip;
   * an explicit `tooltipLabel` or `title` still shows.
   */
  stateStyle?: HeaderActionButtonStateStyle;
  /**
   * Rich tooltip content. Defaults to `title`, then (icon-only controls) the
   * `aria-label`; labeled controls with neither render no tooltip.
   */
  tooltipLabel?: ReactNode;
}

export type HeaderActionButtonProps = HeaderActionButtonBaseProps &
  (
    | {
        /** Render a circular icon-only action. */
        iconOnly: true;
        /** Accessible name required for icon-only controls. */
        'aria-label': string;
      }
    | {
        iconOnly?: false;
      }
  );

export type HeaderActionButtonStateStyle = 'default' | 'toolbar';

/**
 * The tone a header action takes when its caller names none. A surface
 * whose rows are neutral (the Activity card) sets `neutral`, so the section
 * controls it hosts (refresh, review, settings) match it; everywhere else
 * keeps the established accent.
 */
export const HeaderActionDefaultToneContext =
  createContext<HeaderActionButtonTone>('accent');

/** Each tone is a quiet `Button` variant: ink at rest, a tinted hover. */
const TONE_VARIANTS: Record<HeaderActionButtonTone, ButtonVariant> = {
  accent: 'ghost',
  neutral: 'ghost',
  warning: 'ghost',
  /** Irreversible or trash-bound actions (Delete permanently, Empty trash). */
  destructive: 'ghost-destructive',
};

/**
 * Compact action shared by worktree headers and activity-card controls: the
 * `compact` `Button` (28px capsule, 13px label) in the tone's quiet variant,
 * with a shared tooltip. Under the desktop window's drag region, so it is
 * `electron-no-drag`.
 */
export const HeaderActionButton = forwardRef<
  HTMLButtonElement,
  HeaderActionButtonProps
>(function HeaderActionButton(
  {
    tone: toneProp,
    groupHover = false,
    quietWhenDisabled = false,
    stateStyle = 'default',
    iconOnly,
    className = '',
    tooltipLabel,
    title,
    'aria-label': ariaLabel,
    children,
    ...buttonProps
  },
  ref,
): JSX.Element {
  const defaultTone = useContext(HeaderActionDefaultToneContext);
  const tone = toneProp ?? defaultTone;
  const toolbarStates = stateStyle === 'toolbar';
  const states = {
    ...buttonProps,
    ref,
    variant: TONE_VARIANTS[tone],
    groupHover,
    // A pressed toolbar toggle keeps its hover look; a disabled control
    // already takes the disabled ink unless it is quiet.
    pressedHover: toolbarStates,
    quietWhenDisabled,
  };
  // A header action never wraps its label when the row squeezes it (a
  // wrapped "Create PR" squashed its icon). `contents` keeps the icon and
  // the label as the button's own flex items, so its gap still applies.
  const label = <span className="contents whitespace-nowrap">{children}</span>;
  // `title` feeds the shared rich tooltip only — never the DOM: a native
  // title lags on macOS and would stack a second tooltip on the same control.
  const control =
    iconOnly === true ? (
      <Button
        {...states}
        size="compact"
        iconOnly
        aria-label={ariaLabel}
        data-header-action-button="true"
        className={`electron-no-drag ${className}`}
      >
        {label}
      </Button>
    ) : (
      <Button
        {...states}
        size="compact"
        aria-label={ariaLabel}
        data-header-action-button="true"
        className={`electron-no-drag ${className}`}
      >
        {label}
      </Button>
    );

  // In the toolbar style a disabled icon control has nothing to explain by
  // name, so it shows no name tooltip.
  const showsNameTooltip =
    iconOnly === true && !(toolbarStates && buttonProps.disabled === true);
  const tooltip =
    tooltipLabel ?? title ?? (showsNameTooltip ? ariaLabel : undefined);
  if (tooltip === undefined) return control;

  return <Tooltip label={tooltip}>{control}</Tooltip>;
});

HeaderActionButton.displayName = 'HeaderActionButton';
