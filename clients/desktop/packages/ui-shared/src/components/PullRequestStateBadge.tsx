import type { JSX } from 'react';
import {
  GitDraftIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  type AppIcon,
} from '../icons/AppIcons';
import type { BadgeTone } from '../lib/badge';
import { Badge } from '../primitives/Badge';

export type PullRequestStateBadgeState = 'open' | 'merged' | 'closed' | 'draft';

export interface PullRequestStateBadgeProps {
  state: PullRequestStateBadgeState;
  dataTestId?: string;
}

const STATE_BADGE: Record<
  PullRequestStateBadgeState,
  { label: string; tone: BadgeTone; icon: AppIcon }
> = {
  open: { label: 'Open', tone: 'success', icon: GitPullRequestIcon },
  draft: { label: 'Draft', tone: 'neutral', icon: GitDraftIcon },
  merged: { label: 'Merged', tone: 'special', icon: GitMergeIcon },
  closed: { label: 'Closed', tone: 'danger', icon: GitPullRequestClosedIcon },
};

/**
 * Pull request state badge (Open / Draft / Merged / Closed): the shared
 * Badge with the state's glyph. Open is success, draft neutral, merged
 * special and closed danger.
 */
export function PullRequestStateBadge({
  state,
  dataTestId,
}: PullRequestStateBadgeProps): JSX.Element {
  const { label, tone, icon } = STATE_BADGE[state];
  return (
    <Badge tone={tone} icon={icon} data-testid={dataTestId}>
      {label}
    </Badge>
  );
}
