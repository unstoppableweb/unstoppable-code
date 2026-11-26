import type { JSX } from 'react';
import { HoverCard } from '../primitives/HoverCard';
import { ShareIcon } from '../icons/AppIcons';

export const SHARED_WITH_TEAMMATES_LABEL = 'Shared with teammates';

export interface SharedWithTeammatesBadgeProps {
  /**
   * Extra classes for the element the host row actually lays out. That is the
   * tooltip wrapper normally, and the glyph itself under `fadeOnRowHover`,
   * where the tooltip is disabled and its wrapper is dropped. Hosts use it for
   * their own coarse-pointer action reserve, which differs per row type and
   * per trailing-status occupancy.
   */
  className?: string;
  /** Appended to the `worktree-row-shared-badge` test id, as rows do elsewhere. */
  testIdSuffix?: string;
  /**
   * Fade the badge out while the row reveals its hover actions.
   *
   * The badge sits at the trailing edge of the title line, which is exactly
   * where a sidebar row paints its ••• and rail buttons on hover. The rail is
   * `bg-transparent` at rest, so without this the glyphs overlap. Opacity
   * rather than unmount: the footprint is preserved, so nothing on the row
   * jumps when the pointer arrives or leaves.
   *
   * Opt-in because only the classic sidebar rows put the badge in that slot.
   * The kanban/card path has a different rail geometry and keeps its badge on
   * the subtitle line, where nothing is revealed over it.
   */
  fadeOnRowHover?: boolean;
}

/**
 * The "shared with teammates" glyph, identical on code-worktree and Cowork
 * rows.
 *
 * Persistent metadata, not an activity subject: it never enters the leading
 * icon's priority chain, so a shared row still shows its live status glyph.
 *
 * Note on {@link SharedWithTeammatesBadgeProps.fadeOnRowHover}: on that path the
 * badge is invisible precisely when the pointer is over the row, so a hover
 * tooltip is unreachable no matter what — the glyph fades on the same
 * `group-hover` that would open it. It is also made inert, so the faded-out
 * glyph can never swallow a click aimed at the ••• button that now occupies the
 * same pixels. Because both of those hold, the tooltip is skipped outright
 * rather than mounted and blocked, which drops the wrapper `<span>` and the
 * `cloneElement` per shared row. (`HoverCard`'s `disabled` return sits
 * after its hooks, so the `useId`/state/refs still run — the correctness
 * argument is what carries this decision, not the saving.) The accessible name
 * is unaffected — it lives on the glyph's
 * `aria-label`, not in the tooltip. Hosts that render without the fade keep the
 * real tooltip.
 */
export function SharedWithTeammatesBadge({
  className,
  testIdSuffix,
  fadeOnRowHover = false,
}: SharedWithTeammatesBadgeProps): JSX.Element {
  // `HoverCard`'s `disabled` branch returns the child bare, dropping its
  // wrapper — so the layout classes the wrapper would have carried (the host's
  // coarse-pointer action reserve included) have to ride on the glyph itself.
  const glyphClassName = [
    'inline-flex h-3 w-3 shrink-0 items-center justify-center fg-quaternary',
    fadeOnRowHover
      ? 'pointer-events-none transition-opacity pointer-fine:group-hover/sidebar-item:opacity-0 pointer-fine:group-focus-within/sidebar-item:opacity-0'
      : '',
    fadeOnRowHover ? (className ?? '') : '',
  ]
    .filter((entry) => entry !== '')
    .join(' ');

  const wrapperClassName = `shrink-0 ${className ?? ''}`;

  return (
    <HoverCard
      disabled={fadeOnRowHover}
      surfaceClassName="w-max"
      surfacePadding="relaxed"
      triggerWrapperClassName={wrapperClassName}
      content={
        <div className="text-xs fg-primary">{SHARED_WITH_TEAMMATES_LABEL}</div>
      }
    >
      <span
        className={glyphClassName}
        role="img"
        aria-label={SHARED_WITH_TEAMMATES_LABEL}
        data-testid={
          testIdSuffix
            ? `worktree-row-shared-badge${testIdSuffix}`
            : 'worktree-row-shared-badge'
        }
      >
        <ShareIcon size={12} />
      </span>
    </HoverCard>
  );
}
