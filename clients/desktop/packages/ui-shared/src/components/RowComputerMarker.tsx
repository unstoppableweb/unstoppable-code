import type { JSX } from 'react';
import { ComputerIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { Tooltip } from '../primitives/Tooltip';

export interface RowComputerMarkerProps {
  /** The computer the row's work runs on, as the person named it. */
  readonly computerName: string;
  /**
   * Why the computer's work can't be reached right now, in a few plain
   * words (`connecting`, `needs an update`); absent while it can be.
   */
  readonly unavailableReason?: string;
  readonly testId?: string;
}

/** The marker's accessible name and tooltip: where the work runs, and why it can't be reached. */
export function rowComputerMarkerLabel(
  computerName: string,
  unavailableReason?: string,
): string {
  return unavailableReason === undefined
    ? `On ${computerName}`
    : `On ${computerName}, ${unavailableReason}`;
}

/**
 * The trailing icon on a sidebar row whose work runs on another computer
 * (CAN-7766), for `WorktreeRow`'s `trailingIconSlot`. No text on the row: the
 * computer's name, and why its work is unavailable, are the icon's accessible
 * name and its tooltip, shown on hover and on keyboard focus. Rows on this
 * computer carry no marker. The name is the person's own, so session replay
 * masks it, as it masks project and task titles.
 */
export function RowComputerMarker({
  computerName,
  unavailableReason,
  testId,
}: RowComputerMarkerProps): JSX.Element {
  const label = rowComputerMarkerLabel(computerName, unavailableReason);
  return (
    <Tooltip label={<span className={REPLAY_MASK_CLASS}>{label}</span>}>
      <span
        role="img"
        aria-label={label}
        tabIndex={0}
        data-testid={testId}
        className={`${REPLAY_MASK_CLASS} focus-ring inline-flex size-4 items-center justify-center rounded-sm outline-none fg-tertiary`}
      >
        <ComputerIcon size="sm" aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
