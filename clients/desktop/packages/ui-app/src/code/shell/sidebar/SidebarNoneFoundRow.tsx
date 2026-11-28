import type { JSX } from 'react';
import {
  SIDEBAR_ROW_GRID_CLASSNAME,
  SIDEBAR_ROW_LEADING_SLOT_CLASSNAME,
} from '@canopy/ui-shared/components';

export interface SidebarNoneFoundRowProps {
  readonly 'data-testid'?: string;
  /** The label alone, for automation that measures where it starts. */
  readonly labelTestId?: string;
  /**
   * The row's one line. `None found` is the organization reading (CAN-3550);
   * a host whose empty section means something else (a guest's own Chats,
   * CAN-2989) names it, in the same row geometry.
   */
  readonly label?: string;
}

/**
 * The single row an empty sidebar section lists under its header: Chats and
 * Projects read the same when they have nothing to show (CAN-3550). The
 * section's header "+" is the way to add to it, so the row carries no action.
 *
 * It takes a row's geometry (a 6px inset, a 20px leading slot, a 6px gap) so
 * its label starts where a chat title or a project name does, 32px from the
 * row edge.
 */
export function SidebarNoneFoundRow({
  'data-testid': testId,
  labelTestId,
  label = 'None found',
}: SidebarNoneFoundRowProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      className={`flex h-8 items-center pr-1.5 ${SIDEBAR_ROW_GRID_CLASSNAME} pointer-coarse:min-h-11`}
    >
      {/* Where a row draws its badge or status: alignment only. */}
      <span aria-hidden="true" className={SIDEBAR_ROW_LEADING_SLOT_CLASSNAME} />
      <span
        data-testid={labelTestId}
        className="min-w-0 flex-1 truncate text-s font-normal fg-quaternary"
      >
        {label}
      </span>
    </div>
  );
}
