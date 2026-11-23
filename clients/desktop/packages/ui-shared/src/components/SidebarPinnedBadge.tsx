import type { JSX } from 'react';
import { PinFilledIcon } from '../icons/AppIcons';

export const SIDEBAR_PINNED_LABEL = 'Pinned';

/**
 * Hides the mark while the row reveals its hover actions on a fine pointer.
 * The mark sits at the trailing edge of the title line, exactly where a
 * sidebar row paints its ••• and rail buttons on hover. Opacity rather than
 * unmount, so the footprint holds and nothing on the row jumps.
 */
export const SIDEBAR_PINNED_BADGE_FADE_CLASSNAME =
  'pointer-events-none transition-opacity pointer-fine:group-hover/sidebar-item:opacity-0 pointer-fine:group-focus-within/sidebar-item:opacity-0';

export interface SidebarPinnedBadgeProps {
  testId: string;
  /**
   * Extra layout classes for the glyph. Rows use it for their coarse-pointer
   * action reserve; a header passes its own visibility rule in place of the
   * row-hover fade (see {@link fadeOnRowHover}).
   */
  className?: string;
  /**
   * Fade on the row's hover, as described on
   * {@link SIDEBAR_PINNED_BADGE_FADE_CLASSNAME}. A host that hides the mark
   * by another rule (the project header hides it with its counter) turns
   * this off and supplies that rule through `className`.
   */
  fadeOnRowHover?: boolean;
  /** Header actions occupy the mark's pixels on touch, without a hover. */
  hideOnCoarsePointer?: boolean;
  /** A host can keep those actions visible, for example during onboarding. */
  forceHidden?: boolean;
  /**
   * `status` seats the mark in a row's 20px status column, so it centers
   * where the status glyphs and the last hover button's icon do. Default:
   * the 12px glyph alone.
   */
  footprint?: 'glyph' | 'status';
}

/**
 * The pin a pinned sidebar item carries, in the hover buttons' ink, at the trailing edge of its
 * title line: a project, a worktree, a Cowork or Chats Work Entry, and an
 * App Advisor Work Entry all wear the same mark. Pinning is persistent
 * metadata, not an activity subject, so like the shared badge it never enters
 * the leading slot's priority chain and sits left of any live status.
 *
 * No tooltip: the mark is invisible exactly while the pointer is over its
 * row, so one could never open. The accessible name carries the meaning, and
 * the row's menu names the action (Pin to top / Unpin).
 */
export function SidebarPinnedBadge({
  testId,
  className,
  fadeOnRowHover = true,
  hideOnCoarsePointer = false,
  forceHidden = false,
  footprint = 'glyph',
}: SidebarPinnedBadgeProps): JSX.Element {
  const classNames = [
    footprint === 'status'
      ? 'inline-flex h-5 w-5 shrink-0 items-center justify-center fg-secondary'
      : 'inline-flex h-3 w-3 shrink-0 items-center justify-center fg-secondary',
    fadeOnRowHover ? SIDEBAR_PINNED_BADGE_FADE_CLASSNAME : '',
    hideOnCoarsePointer ? 'pointer-coarse:opacity-0' : '',
    forceHidden ? 'opacity-0' : '',
    className ?? '',
  ]
    .filter((entry) => entry !== '')
    .join(' ');
  return (
    <span
      className={classNames}
      role="img"
      aria-label={SIDEBAR_PINNED_LABEL}
      data-testid={testId}
    >
      <PinFilledIcon size={12} aria-hidden="true" />
    </span>
  );
}
