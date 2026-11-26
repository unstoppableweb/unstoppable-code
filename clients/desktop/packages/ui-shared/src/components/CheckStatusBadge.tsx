import type { JSX } from 'react';
import { Badge, type BadgeTone } from '../primitives/Badge';

/** Canonical check status — matches desktop's `CheckStatus` palette but
 * uses portable names instead of GitHub-specific verbs. */
export type CheckStatusBadgeStatus =
  | 'success'
  | 'failure'
  | 'pending'
  | 'neutral';

export interface CheckStatusBadgeProps {
  status: CheckStatusBadgeStatus;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

/**
 * Each status's tone and word. The words match the CI badge's plain-language
 * states (`getCheckStatusLabel`): a pending check is running.
 */
const CHECK_STATUS_BADGE: Readonly<
  Record<CheckStatusBadgeStatus, { tone: BadgeTone; label: string }>
> = {
  success: { tone: 'success', label: 'Passing' },
  failure: { tone: 'danger', label: 'Failing' },
  pending: { tone: 'info', label: 'Running' },
  neutral: { tone: 'neutral', label: 'Neutral' },
};

/**
 * A CI check's state as a `Badge`, for PR check rows and self-test feeds.
 */
export function CheckStatusBadge({
  status,
  dataTestId,
}: CheckStatusBadgeProps): JSX.Element {
  const { tone, label } = CHECK_STATUS_BADGE[status];
  return (
    <Badge tone={tone} data-testid={dataTestId}>
      {label}
    </Badge>
  );
}
