import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import type { AppIcon } from '../icons/AppIcons';
import { ControlButton, Button, type ButtonVariant } from './Button';
import { Tooltip } from './Tooltip';

/**
 * `neutral` brightens from tertiary to primary under the pointer. `section`
 * rests in a section header's own quaternary ink, so its controls read as one
 * line with the label and chevron beside them. `secondary` keeps its ink and
 * lets only the surface respond, for the account row's feedback and settings
 * actions. `warning` and `destructive` name the action.
 */
export type RailIconButtonTone =
  | 'neutral'
  | 'section'
  | 'secondary'
  | 'warning'
  | 'armed'
  | 'destructive';
export type RailIconButtonSize = 'compact' | 'row';

export interface RailIconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className'
> {
  icon: AppIcon;
  /** App glyph size. Defaults to 16px; optical exceptions can override. */
  iconSize?: number;
  iconClassName?: string;
  /**
   * `compact` is the 28px `sm` icon-only `Button`, nested 2px inside a 32px
   * sidebar row; `row` is the 32px `md` one, with the row's own radius.
   */
  size?: RailIconButtonSize;
  /** Reveal the control only when its `group/sidebar-item` header is hovered. */
  revealOnItemHover?: boolean;
  /**
   * Hold a 44px square slot on coarse-pointer layouts. The `Button`'s own hit
   * area already grows to 44px there; this keeps the row's layout.
   */
  coarsePointerTarget?: boolean;
  /**
   * Hold a 44px minimum height on every pointer, not only coarse ones, for a
   * header laid out for touch.
   */
  touchTarget?: boolean;
  /**
   * Opt into a tone-specific hover surface; the default is icon-only hover.
   * Only the `section` and `destructive` tones read it: the `Button` tones
   * always have their hover surface.
   */
  hoverSurface?: boolean;
  tone?: RailIconButtonTone;
  visibility?: 'all' | 'fine-pointer' | 'coarse-pointer';
  inset?: 'none' | 'tight-end' | 'roomy-inline';
  /** Visible tooltip text. Defaults to `title`, then `aria-label`. */
  tooltipLabel?: ReactNode;
}

/**
 * The tones a `Button` variant draws (docs/design/buttons.md): `neutral` is
 * the quiet ghost repeated on every row, `secondary` the ghost over a raised
 * or hovered surface, `warning` the quiet warning action. Each always has
 * its hover surface, so `hoverSurface` does not change them.
 */
const BUTTON_TONE_VARIANTS: Record<
  Exclude<RailIconButtonTone, NativeTone>,
  ButtonVariant
> = {
  neutral: 'ghost',
  secondary: 'ghost',
  warning: 'ghost',
  armed: 'ghost',
};

/**
 * The two tones no `Button` variant draws stay a native button with the
 * same nested 28px/32px shape: `section` rests in the section header's quaternary
 * ink, and `destructive` rests in tertiary ink and turns destructive only
 * under the pointer (`ghost-destructive` is destructive at rest).
 */
type NativeTone = 'section' | 'destructive';

/** Without a hover surface only the ink answers the pointer. */

function isNativeTone(tone: RailIconButtonTone): tone is NativeTone {
  return tone === 'section' || tone === 'destructive';
}

/** Canonical compact icon action for sidebar and rail item headers. */
export const RailIconButton = forwardRef<
  HTMLButtonElement,
  RailIconButtonProps
>(function RailIconButton(
  {
    revealOnItemHover = false,
    coarsePointerTarget = false,
    touchTarget = false,
    hoverSurface = false,
    tone = 'neutral',
    size = 'compact',
    icon: Icon,
    iconSize = 16,
    iconClassName,
    tooltipLabel,
    title,
    'aria-label': ariaLabel,
    type = 'button',
    visibility = 'all',
    inset = 'none',
    ...props
  },
  ref,
): JSX.Element {
  const resolvedTooltipLabel = tooltipLabel ?? title ?? ariaLabel;
  const revealClassName =
    'inline-flex opacity-0 pointer-events-none transition-opacity group-hover/sidebar-item:opacity-100 group-hover/sidebar-item:pointer-events-auto group-focus-within/sidebar-item:opacity-100 group-focus-within/sidebar-item:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:pointer-events-auto';
  const glyph = <Icon size={iconSize} className={iconClassName} />;
  // The 44px floors. A native button grows to them itself; a `Button` sizes
  // itself, so its slot holds them while its own hit area reaches 44px on a
  // coarse pointer.
  const floorClassName = `${coarsePointerTarget ? 'pointer-coarse:min-h-11 pointer-coarse:min-w-11' : ''} ${touchTarget ? 'min-h-11' : ''}`;
  const native = isNativeTone(tone);

  const button = native ? (
    <ControlButton
      ref={ref}
      type={type}
      aria-label={ariaLabel}
      presentation="rail-icon"
      appearance={{
        size,
        tone,
        hoverSurface,
        coarsePointerTarget,
        touchTarget,
        visibility,
        inset,
      }}
      {...props}
    >
      {glyph}
    </ControlButton>
  ) : (
    <Button
      ref={ref}
      type={type}
      variant={BUTTON_TONE_VARIANTS[tone]}
      size={size === 'row' ? 'md' : 'sm'}
      iconOnly
      iconShape="nested"
      aria-label={ariaLabel ?? ''}
      // Without a 44px slot to hold it, the Button's coarse-pointer hit area
      // would reach over the controls beside it (header clusters, buttons side by side,
      // the account footer), so it keeps its own 28px/32px target, as the
      // native rail buttons did. Switches to Button's `touchArea` (#7528).
      railPlacement={{ coarsePointerTarget, visibility, inset }}
      {...props}
    >
      {glyph}
    </Button>
  );

  const control = (
    <Tooltip
      label={resolvedTooltipLabel}
      disabled={resolvedTooltipLabel == null || resolvedTooltipLabel === ''}
    >
      {button}
    </Tooltip>
  );

  // Tooltip owns an `inline-flex` wrapper. Keep conditional display on a
  // separate ancestor: Tailwind emits `.inline-flex` after `.hidden`, so
  // applying both utilities to Tooltip's wrapper makes the control visible at
  // rest regardless of the row's hover state.
  return (
    <span
      className={`${revealOnItemHover ? revealClassName : 'inline-flex'} shrink-0 items-center justify-center ${native ? '' : floorClassName}`}
    >
      {control}
    </span>
  );
});

RailIconButton.displayName = 'RailIconButton';
