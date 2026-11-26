import type { JSX } from 'react';
import { ComputerIcon } from '@canopy/ui-shared/icons/AppIcons';
import { ListRowStatic } from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface SidebarComputerStatusRowProps {
  /** The paired computer, as the person named it. */
  readonly computerName: string;
  /** Why its tasks aren't listed yet, as a sentence: `Connecting…`, `Needs an update`. */
  readonly status: string;
  readonly 'data-testid'?: string;
}

/**
 * The one row a paired computer shows in the sidebar while none of its tasks
 * have arrived and it can't be reached: connecting, or needing an update
 * (CAN-7766). It reads unavailable and says why; once the computer sends its
 * tasks, they list under their projects instead.
 */
export function SidebarComputerStatusRow({
  computerName,
  status,
  'data-testid': testId,
}: SidebarComputerStatusRowProps): JSX.Element {
  return (
    <ListRowStatic
      data-testid={testId}
      disabled
      icon={<ComputerIcon />}
      description={status}
    >
      {/* The computer's name is the person's own: replay masks it. */}
      <span className={REPLAY_MASK_CLASS}>{computerName}</span>
    </ListRowStatic>
  );
}
