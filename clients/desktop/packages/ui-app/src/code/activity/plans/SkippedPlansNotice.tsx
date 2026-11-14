import type { JSX } from 'react';
import { Notice } from '@canopy/ui-shared/components';

/**
 * Plans stored for a worktree that couldn't be read, so the list leaves them
 * out (CAN-6695). Their records stay on disk as they were. Shared by the
 * desktop and Portal Plans sections; nothing renders without a count.
 */
export function SkippedPlansNotice({
  count,
}: {
  readonly count: number | undefined;
}): JSX.Element | null {
  if (count === undefined || count <= 0) return null;
  return (
    <Notice intent="attention" data-testid="activity-plans-skipped">
      {count === 1
        ? "1 plan in this worktree couldn't be read, so it isn't shown."
        : `${String(count)} plans in this worktree couldn't be read, so they aren't shown.`}
    </Notice>
  );
}
