import type { JSX } from 'react';
import { Badge } from '../primitives/Badge';
import { Lock } from '../icons/AppIcons';

/**
 * A settings row's label with the inline lock beside it when an organization
 * policy, not the member, sets the row's value ("Turned off by Acme",
 * "Required by Acme"). Shared by every locked row on the Privacy page (Usage
 * data and Activity sharing), so the reason is visible without hovering and
 * reads the same wherever it appears. The label and badge share one line and
 * wrap together on a narrow column; a reason wider than the column (a long
 * organization name) truncates inside the badge instead of overflowing it.
 */
export function SettingsLockedLabel({
  label,
  reason,
  dataTestId,
}: {
  readonly label: string;
  readonly reason: string | null;
  readonly dataTestId?: string;
}): JSX.Element {
  if (!reason) {
    return <>{label}</>;
  }
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1">
      <span>{label}</span>
      <Badge
        icon={Lock}
        muted
        className="min-w-0 max-w-full"
        data-testid={dataTestId}
      >
        <span className="min-w-0 truncate" title={reason}>
          {reason}
        </span>
      </Badge>
    </span>
  );
}
