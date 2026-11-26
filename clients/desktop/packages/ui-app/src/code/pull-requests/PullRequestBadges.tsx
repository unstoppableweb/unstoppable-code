'use client';

import {
  Badge,
  Button,
  PullRequestHeaderLink,
  PullRequestHeaderStatus,
} from '@canopy/ui-shared/components';
import { Dot, type DotTone } from '@canopy/ui-shared/primitives/Badge';
import type { JSX } from 'react';
import {
  PrBadgeTooltipContent,
  HoverCard,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  GitDraftIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import type {
  PullRequestSectionCheckDetail,
  PullRequestSectionCheckStatus,
  PullRequestSectionPrState,
} from '../activity/PullRequestSectionBody';
import { CheckDetailsList } from './CheckDetailsList';
import { getCheckStatusLabel } from './pull-request-actions-copy';
import type {
  PullRequestActionsPr,
  PullRequestActionsRepo,
} from './pull-request-actions-plan';

/**
 * Header PR + CI badges (REG-3025, moved from the desktop `PrStatusBar`).
 *
 * Both read as one line of status: STATE lives in the colour of a small
 * leading glyph, and the text stays `fg-primary` so it is legible rather than
 * tinted. The PR badge dropped its pill and the redundant "PR" word — the
 * icon already says what it is — leaving just `#1234`.
 */

interface PrStateBadgeProps {
  readonly state: PullRequestSectionPrState;
  readonly prNumber: number;
  readonly prUrl?: string | null;
}

/** Per-state glyph + tint. The glyph carries the state, not the label. */
const PR_STATE_ICON: Record<
  PullRequestSectionPrState,
  { Icon: typeof GitPullRequestIcon; className: string; label: string }
> = {
  open: {
    Icon: GitPullRequestIcon,
    className: OPERATIONAL_STATUS_COLORS.success.foreground,
    label: 'open',
  },
  merged: {
    Icon: GitMergeIcon,
    className: OPERATIONAL_STATUS_COLORS.merged.foreground,
    label: 'merged',
  },
  closed: {
    Icon: GitPullRequestClosedIcon,
    className: OPERATIONAL_STATUS_COLORS.failed.foreground,
    label: 'closed',
  },
  draft: { Icon: GitDraftIcon, className: 'fg-secondary', label: 'draft' },
};

export function PrStateIndicator({
  state,
  prNumber,
  prUrl,
}: PrStateBadgeProps): JSX.Element {
  const { Icon, className: iconClassName, label } = PR_STATE_ICON[state];
  const content = (
    <>
      <Icon size={16} className={`shrink-0 ${iconClassName}`} />#{prNumber}
    </>
  );

  if (prUrl) {
    return (
      <PullRequestHeaderLink
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Pull request #${prNumber} (${label})`}
      >
        {content}
      </PullRequestHeaderLink>
    );
  }

  return (
    <PullRequestHeaderStatus
      aria-label={`Pull request #${prNumber} (${label})`}
    >
      {content}
    </PullRequestHeaderStatus>
  );
}

interface CiStatusBadgeProps {
  readonly status: PullRequestSectionCheckStatus;
}

/**
 * CI state as a filled dot, the same vocabulary — and the same 6px size — the
 * app's other indicator dots use (the filter-active dots on the Projects
 * header menu / `FileLabelFilterDropdown`), with the label left
 * plain (`CI`, no colon) in `fg-primary`.
 */
const CI_STATUS_DOT: Record<PullRequestSectionCheckStatus, DotTone> = {
  passing: 'success',
  failing: 'danger',
  // Grey, but pulsing: colour is reserved for OUTCOMES (green/red), so a
  // check still running says so through motion instead — the same
  // status pulse used elsewhere for work in progress.
  pending: 'filter',
  neutral: 'filter',
  none: 'filter',
};

export function CiStatusIndicator({ status }: CiStatusBadgeProps): JSX.Element {
  return (
    <PullRequestHeaderStatus
      // The dot carries the state and the visible text is just `CI`, so the
      // badge is announced as one labelled image rather than a bare "CI".
      role="img"
      aria-label={getCheckStatusLabel(status)}
      // Same hover affordance as the PR badge beside it: both open something
      // on hover, so both have to look reachable.
      // Same `px-2.5` shell as the PR badge and every header action button:
      // one padding value across the whole row beats per-control optical
      // nudges (an earlier `pr-1.5` here balanced this badge's own ink but
      // made it the odd one out in the container).
      hover
    >
      <Dot tone={CI_STATUS_DOT[status]} pulse={status === 'pending'} />
      CI
    </PullRequestHeaderStatus>
  );
}

// ---------------------------------------------------------------------------
// Hover cards – the per-check CI list and the multi-repo PR list. Both are
// interactive HoverCards, so the cursor can travel into the card (and
// scroll a long list) and into the cards nested inside it without it closing.
// ---------------------------------------------------------------------------

interface CiStatusBadgeWithPopoverProps {
  readonly status: PullRequestSectionCheckStatus;
  readonly checkDetails: readonly PullRequestSectionCheckDetail[];
  readonly badgeTestId?: string;
  readonly popoverTestId?: string;
}

export function CiStatusBadgeWithPopover({
  status,
  checkDetails,
  badgeTestId = 'pr-status-bar-ci-badge',
  popoverTestId = 'pr-status-bar-ci-popover',
}: CiStatusBadgeWithPopoverProps): JSX.Element {
  const badge = (
    <span className="electron-no-drag inline-flex" data-testid={badgeTestId}>
      <CiStatusIndicator status={status} />
    </span>
  );
  // The rich check list is the real preview, but it only exists when the
  // provider actually returned per-check details. Without this fallback the
  // badge is silent on hover in exactly the states where the dot alone is
  // least self-explanatory (neutral, not run, a status with no detail
  // payload).
  if (checkDetails.length === 0) {
    return <Tooltip label={getCheckStatusLabel(status)}>{badge}</Tooltip>;
  }
  return (
    <HoverCard
      interactive
      placement="below-start"
      elevation="menu"
      surfacePadding="card"
      surfaceClassName="min-w-65 max-w-105"
      dataTestId={popoverTestId}
      content={<CheckDetailsList checkDetails={checkDetails} scrollable />}
    >
      {badge}
    </HoverCard>
  );
}

/** The single repository's PR badge, with its rich hover card. */
export function PullRequestStateBadgeWithTooltip({
  pr,
  dataTestId = 'pr-status-bar-pr-tooltip',
}: {
  readonly pr: PullRequestActionsPr;
  readonly dataTestId?: string;
}): JSX.Element {
  return (
    <HoverCard
      dataTestId={dataTestId}
      surfaceClassName="min-w-65 max-w-85"
      surfacePadding="card"
      disabled={!pr.tooltip}
      content={pr.tooltip ? <PrBadgeTooltipContent pr={pr.tooltip} /> : null}
    >
      <PrStateIndicator state={pr.state} prNumber={pr.number} prUrl={pr.url} />
    </HoverCard>
  );
}

function RepoPrStatusRow({
  repo,
  pr,
}: {
  readonly repo: PullRequestActionsRepo;
  readonly pr: PullRequestActionsPr;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate fg-primary">
        {repo.repoName}
      </span>
      <PullRequestStateBadgeWithTooltip
        pr={pr}
        dataTestId={`pr-status-bar-repo-pr-tooltip-${repo.repoId}`}
      />
      <CiStatusBadgeWithPopover
        status={pr.checkStatus}
        checkDetails={pr.checkDetails}
        badgeTestId={`pr-status-bar-repo-ci-badge-${repo.repoId}`}
        popoverTestId={`pr-status-bar-repo-ci-popover-${repo.repoId}`}
      />
    </div>
  );
}

/**
 * The multi-repo `N PRs` badge: hovering lists each repository's PR and CI;
 * clicking opens the host's PR details.
 */
export function MultiRepoPrControl({
  openRepos,
  onOpen,
}: {
  readonly openRepos: readonly PullRequestActionsRepo[];
  readonly onOpen: () => void;
}): JSX.Element {
  return (
    <HoverCard
      interactive
      // Enter and Space open the PR details; ArrowDown opens the list.
      triggerOpenKeys={['ArrowDown']}
      disabled={openRepos.length === 0}
      placement="below-start"
      elevation="menu"
      surfacePadding="card"
      surfaceClassName="min-w-70 max-w-120"
      dataTestId="pr-status-bar-repo-popover"
      content={
        <div className="flex flex-col gap-1.5">
          <div className="text-3xs font-semibold fg-secondary">
            Pull requests
          </div>
          {openRepos.map((repo) =>
            repo.pr === null ? null : (
              <RepoPrStatusRow key={repo.repoId} repo={repo} pr={repo.pr} />
            ),
          )}
        </div>
      }
    >
      <Button
        variant="ghost"
        size="compact"
        onClick={onOpen}
        className="electron-no-drag"
      >
        <Badge
          tone={
            openRepos.every((repo) => repo.pr?.state === 'merged')
              ? 'special'
              : 'success'
          }
        >
          {openRepos.length} {openRepos.length === 1 ? 'PR' : 'PRs'}
        </Badge>
      </Button>
    </HoverCard>
  );
}
