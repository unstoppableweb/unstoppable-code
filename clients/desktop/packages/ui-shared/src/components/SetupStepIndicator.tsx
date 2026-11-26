import type { JSX } from 'react';
import { CircleCheckIcon } from '../icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import { LoadingSpinner } from '../primitives/LoadingSpinner';

export type SetupStepStatus = 'completed' | 'active' | 'pending';

/** Visual progress cue for a setup step. The caller supplies its state label. */
export function SetupStepIndicator({
  status,
}: {
  readonly status: SetupStepStatus;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center"
    >
      {status === 'completed' ? (
        <CircleCheckIcon
          size="xl"
          className={OPERATIONAL_STATUS_COLORS.success.foreground}
        />
      ) : status === 'active' ? (
        <LoadingSpinner tone="active" sizePx={16} decorative />
      ) : (
        <span className="h-4 w-4 rounded-full ring-2 ring-fg-quaternary ring-inset" />
      )}
    </span>
  );
}
