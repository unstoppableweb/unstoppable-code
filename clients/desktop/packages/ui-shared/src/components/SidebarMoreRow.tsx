import { ControlButton } from '../primitives/Button';
import type { JSX } from 'react';

export interface SidebarMoreRowProps {
  /** Whether the rest of the list is shown; the row then reads `Less`. */
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** Full description for assistive tech, e.g. `Show all 8 chats`. */
  readonly ariaLabel: string;
  readonly testId?: string;
  /** Raises the row to the 44px touch minimum, like the rows above it. */
  readonly touchTarget?: boolean;
}

/**
 * The `More` / `Less` row under a capped sidebar list. It is drawn as one
 * more list row, with the Work Entry row's frame (height, inset, leading
 * column, radius, ink, hover), so it lines up with the rows above it and
 * keeps their rhythm: the caller places it 1px below the last row, the same
 * gap the rows keep between each other. No chevron and no count.
 */
export function SidebarMoreRow({
  expanded,
  onToggle,
  ariaLabel,
  testId,
  touchTarget = false,
}: SidebarMoreRowProps): JSX.Element {
  return (
    <ControlButton
      type="button"
      presentation="sidebar-more-row"
      appearance={{ touchTarget: !!touchTarget }}
      aria-expanded={expanded}
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={onToggle}
    >
      {/* The rows' leading column, so the label starts on their title line. */}
      <span className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate leading-snug">
        {expanded ? 'Less' : 'More'}
      </span>
    </ControlButton>
  );
}
