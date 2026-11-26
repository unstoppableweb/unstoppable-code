import type { JSX } from 'react';
import { formatCompactAge } from '../lib/format-relative-time';
import { useMinuteClock } from '../lib/useMinuteClock';
import { SIDEBAR_ROW_TRAILING_CELL_CLASSNAME } from '../primitives/sidebar-item-classes';

export interface SidebarRowAgeProps {
  /** When the row last had activity (epoch ms or ISO string). */
  readonly lastActivityAt: string | number;
  /**
   * The row has hover actions in this spot. The age leaves while they are
   * revealed (always, on a coarse pointer) so they take its place.
   */
  readonly hidesForActions: boolean;
  readonly testId: string;
}

// The row's trailing cell (see `SIDEBAR_ROW_TRAILING_CELL_CLASSNAME`), so the
// row keeps its height whether it shows the age, a status, or (on hover) its
// actions, and the age matches every count in the sidebar.
const SIDEBAR_ROW_AGE_CLASSNAME = SIDEBAR_ROW_TRAILING_CELL_CLASSNAME;

/**
 * A sidebar row's compact last-activity age (`5m`, `3h`, `2d`, `3w`, `2mo`),
 * in the quiet `fg-quaternary` ink, the idle dot's grey, so it stays
 * background information beside the title. It is right-aligned so ages of
 * different widths share one edge: the right edge of the last hover button. A
 * row with a trailing status (the classic placement) gives that status the
 * spot instead.
 */
export function SidebarRowAge({
  lastActivityAt,
  hidesForActions,
  testId,
}: SidebarRowAgeProps): JSX.Element {
  const now = useMinuteClock();
  return (
    <span
      className={`${SIDEBAR_ROW_AGE_CLASSNAME} ${
        hidesForActions
          ? 'group-hover/sidebar-item:hidden group-focus-within/sidebar-item:hidden pointer-coarse:hidden'
          : ''
      }`}
      data-testid={testId}
    >
      {formatCompactAge(lastActivityAt, now)}
    </span>
  );
}
