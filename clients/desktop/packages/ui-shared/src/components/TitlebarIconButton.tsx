import { ControlButton } from '../primitives/Button';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import type { AppIcon } from '../icons/AppIcons';
import { Tooltip } from '../primitives/Tooltip';

/**
 * Which ink drives the glyph. `top-bar` is the shared secondary ink that
 * lifts to primary on hover. `titlebar` is for the persistent window-titlebar
 * corner (sidebar toggle, history arrows): it sits on the translucent sidebar
 * material, which overrides the local `--fg-*` roles, so its controls read
 * the app-window control token the desktop stylesheet captured before that
 * override (`titlebar-control-fg`).
 */
export type TitlebarIconButtonForeground = 'top-bar' | 'titlebar';

/**
 * The chrome row the control sits in. `titlebar` is the window titlebar and
 * the worktree top bars. `panelChrome` is a panel group's control cluster,
 * where the panels stylesheet keeps the arrow cursor and inks a pressed
 * control in accent. `panelTabStrip` is the strip's `+`, which the strip
 * centers, transitions, and focus-rings inside its own bounds.
 */
export type TitlebarIconButtonSurface =
  | 'titlebar'
  | 'panelChrome'
  | 'panelTabStrip';

export interface TitlebarIconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className'
> {
  icon: AppIcon;
  /** App glyph size. Titlebar controls use 16px. */
  iconSize?: number;
  /** Grow the control itself to 44px on touch layouts, without changing desktop geometry. */
  coarsePointerTarget?: boolean;
  /** Defaults to the top-bar ink. */
  foreground?: TitlebarIconButtonForeground;
  surface?: TitlebarIconButtonSurface;
  /**
   * Visible tooltip text. Defaults to `title`, then `aria-label`; pass an
   * empty string to disable the tooltip (e.g. when a caller owns its own).
   */
  tooltipLabel?: ReactNode;
  /**
   * Keys that perform the same action, drawn as caps after the tooltip
   * label (`formatShortcut(id)`).
   */
  tooltipShortcut?: string;
  /**
   * Keep the hover look (subtle surface, primary ink) while `aria-expanded`
   * is true, for a toggle whose card or panel is open beside it.
   */
  holdHoverWhenExpanded?: boolean;
}

/**
 * Canonical 28×28 titlebar/top-bar icon action: the exact frame used by the
 * persistent titlebar corner controls (sidebar toggle, history arrows), reused
 * by the worktree/cowork top bars so every chrome-row icon shares one optical
 * size, radius, and hover surface.
 */
export const TitlebarIconButton = forwardRef<
  HTMLButtonElement,
  TitlebarIconButtonProps
>(function TitlebarIconButton(
  {
    icon: Icon,
    iconSize = 16,
    coarsePointerTarget = false,
    foreground = 'top-bar',
    surface = 'titlebar',
    tooltipLabel,
    tooltipShortcut,
    holdHoverWhenExpanded = false,
    title,
    'aria-label': ariaLabel,
    type = 'button',
    ...props
  },
  ref,
): JSX.Element {
  // `title` feeds the tooltip only — forwarding it to the DOM would stack the
  // native browser tooltip on top of the custom one (RailIconButton parity).
  const resolvedTooltipLabel = tooltipLabel ?? title ?? ariaLabel;
  return (
    <Tooltip
      label={resolvedTooltipLabel}
      shortcut={tooltipShortcut}
      disabled={resolvedTooltipLabel == null || resolvedTooltipLabel === ''}
    >
      <ControlButton
        ref={ref}
        type={type}
        aria-label={ariaLabel}
        presentation="titlebar-icon"
        appearance={{
          coarsePointerTarget,
          foreground,
          surface,
          holdHoverWhenExpanded,
        }}
        {...props}
      >
        <Icon size={iconSize} aria-hidden="true" />
      </ControlButton>
    </Tooltip>
  );
});

TitlebarIconButton.displayName = 'TitlebarIconButton';
