import type { JSX, ReactNode } from 'react';
import { DisclosureChevron, DisclosureToggle } from '../primitives/Disclosure';
import { SIDEBAR_ROW_TRAILING_CELL_CLASSNAME } from '../primitives/sidebar-item-classes';

export interface SidebarToggleRowProps {
  readonly label: ReactNode;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** Full description for assistive tech, e.g. `Show all 8 chats`. */
  readonly ariaLabel?: string;
  /** A 20px mark in the rows' leading column; empty keeps the column. */
  readonly leading?: ReactNode;
  /** Sits in the rows' trailing cell, on the sidebar's one right edge. */
  readonly count?: number;
  readonly testId?: string;
  readonly chevronTestId?: string;
  readonly countTestId?: string;
}

/**
 * A row at the foot of a sidebar list that opens more of it (`Show all`,
 * `Archived`). The leading column mirrors a row's, so the label stays on the
 * title line of the rows above. The chevron points right while the rest is
 * hidden and down once it shows, as the section headers do.
 */
export function SidebarToggleRow({
  label,
  expanded,
  onToggle,
  ariaLabel,
  leading,
  count,
  testId,
  chevronTestId,
  countTestId,
}: SidebarToggleRowProps): JSX.Element {
  return (
    <DisclosureToggle
      variant="sidebar-row"
      open={expanded}
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={onToggle}
    >
      {leading ? (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
          {leading}
        </span>
      ) : (
        <span className="w-5 shrink-0" aria-hidden="true" />
      )}
      <span className="inline-flex min-w-0 items-center gap-1">
        <span className="truncate">{label}</span>
        <DisclosureChevron
          direction={expanded ? 'down' : 'right'}
          dataTestId={chevronTestId}
        />
      </span>
      {count !== undefined && (
        <span
          className={SIDEBAR_ROW_TRAILING_CELL_CLASSNAME}
          data-testid={countTestId}
        >
          {count}
        </span>
      )}
    </DisclosureToggle>
  );
}
