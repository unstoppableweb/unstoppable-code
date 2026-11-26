import type { JSX } from 'react';
import {
  CheckStatusBadge,
  LoadingSpinner,
  type CheckStatusBadgeStatus,
} from '@canopy/ui-shared/components';
export type PullRequestSectionCheckStatus =
  | 'passing'
  | 'failing'
  | 'pending'
  | 'neutral'
  | 'none';

function toCheckStatusBadgeStatus(
  status: PullRequestSectionCheckStatus,
): CheckStatusBadgeStatus | null {
  switch (status) {
    case 'passing':
      return 'success';
    case 'failing':
      return 'failure';
    case 'neutral':
      return 'neutral';
    case 'pending':
      return 'pending';
    default:
      return null;
  }
}

export function PullRequestCheckStatusMarker({
  status,
}: {
  status: PullRequestSectionCheckStatus;
}): JSX.Element {
  const mapped = toCheckStatusBadgeStatus(status);
  if (mapped === null) {
    return <LoadingSpinner tone="warning" />;
  }
  return <CheckStatusBadge status={mapped} />;
}
