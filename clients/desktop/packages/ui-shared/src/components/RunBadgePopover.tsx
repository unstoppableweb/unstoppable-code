import type { JSX } from 'react';
import { Dot, type DotTone } from '../primitives/Badge';
import { BADGE_HOVER_CARD_SURFACE } from './ChatPreviewPopover';
import { RichHoverCard } from '../primitives/RichHoverTooltip';
import { Stack } from '../primitives/Stack';

export interface RunBadgeRow {
  id: string;
  label: string;
  /** Status text rendered on the right of the row. */
  statusText: string;
  /** Tailwind text-* class applied to `statusText`. */
  statusClass: string;
  /** The leading dot's tone. */
  dotTone: DotTone;
}

export interface RunBadgePopoverProps {
  anchorRect: DOMRect;
  rows: RunBadgeRow[];
  heading: string;
  emptyText: string;
  /** Lets the badge that opened it name it in `aria-describedby`. */
  id?: string;
}

/**
 * Shared popover body for the script (rocket) and hook badges. Both list the
 * currently-active runs for a worktree with a label, a colored dot, and a
 * status word, so they reuse one component differentiated only by `heading`
 * and the empty-state copy.
 */
export function RunBadgePopover({
  anchorRect,
  rows,
  heading,
  emptyText,
  id,
}: RunBadgePopoverProps): JSX.Element | null {
  return (
    <RichHoverCard
      anchorRect={anchorRect}
      id={id}
      role="tooltip"
      dataTestId="worktree-row-script-popover"
      {...BADGE_HOVER_CARD_SURFACE}
      surfaceClassName="min-w-40 max-w-65"
    >
      <Stack gap="tight">
        <div className="text-3xs font-semibold fg-secondary">{heading}</div>
        {rows.length === 0 ? (
          <div className="text-xs fg-secondary">{emptyText}</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <div key={row.id} className="flex items-center gap-1.5 text-xs">
                <Dot tone={row.dotTone} />
                <span className="truncate fg-primary" title={row.label}>
                  {row.label}
                </span>
                <span className={`ml-auto shrink-0 ${row.statusClass}`}>
                  {row.statusText}
                </span>
              </div>
            ))}
          </div>
        )}
      </Stack>
    </RichHoverCard>
  );
}
