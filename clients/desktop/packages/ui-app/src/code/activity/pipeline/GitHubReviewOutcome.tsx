import type { JSX } from 'react';
import {
  Badge,
  ExternalTextLink,
  TextLinkButton,
} from '@canopy/ui-shared/components';
import {
  REVIEW_APPROVAL_REASONS,
  type ReviewApprovalReason,
} from '@canopy/protocol/canopy-core/core';

// ---------------------------------------------------------------------------
// Where a packaged code review landed on GitHub: posted (and maybe approved)
// as the GitHub App, or posted with the person's own GitHub account. This is
// the only reason-to-copy map in TypeScript. The code review presets' report
// line repeats these strings by hand (`publish_review_report`); keep the two
// in step.
// ---------------------------------------------------------------------------

export interface GitHubReviewOutcomeProps {
  readonly publisher: 'app' | 'local';
  readonly approvalReason?: string;
  readonly minScore?: number;
  readonly reviewUrl?: string;
  /**
   * "Link GitHub" beside a `requester_not_connected` badge (CAN-7162). The
   * host passes it only while the viewer, who ran the review, still needs to
   * link GitHub; without it the badge shows no action.
   */
  readonly onLinkGitHub?: () => void;
  /** A link started from the action is running. */
  readonly linkBusy?: boolean;
}

const REASON_COPY: Readonly<
  Record<Exclude<ReviewApprovalReason, 'below_min_score'>, string>
> = {
  approved: 'Approved on GitHub',
  policy_off: 'Posted to GitHub',
  personal_repo_not_owned: 'Not approved · organization repo',
  repo_not_selected: 'Not approved · repository not selected',
  pr_not_open: "Not approved · pull request isn't open",
  not_pass: "Not approved · review didn't pass",
  incomplete: 'Not approved · review incomplete',
  uncommitted: 'Not approved · included uncommitted changes',
  head_moved: 'Not approved · new commits since the review',
  requester_not_writer: 'Not approved · write access not confirmed',
  github_refused: 'Not approved · GitHub refused the approval',
  requester_not_connected: 'Not approved · GitHub not linked',
};

/** The full reason, for the badge's title. */
const REASON_TITLE: Readonly<Record<ReviewApprovalReason, string>> = {
  approved:
    'The review passed the code review policy and approved the pull request.',
  policy_off: 'AI review approvals are off for this repository.',
  personal_repo_not_owned:
    "Personal approvals cover only repositories on your own GitHub account. This repository follows its organization's setting.",
  repo_not_selected:
    "This repository isn't one of the repositories selected for approvals.",
  pr_not_open: 'The pull request was closed or merged.',
  not_pass: "The review's verdict wasn't a pass.",
  below_min_score: "The review's score was below the policy's minimum score.",
  incomplete: "The review didn't finish every part of its checks.",
  uncommitted: 'The review included changes that were not committed.',
  head_moved: 'New commits were pushed after the reviewed commit.',
  requester_not_writer:
    "Approvals need the person who ran the review to have write access to this repository through their connected GitHub account. GitHub didn't confirm it: they don't have write access, their GitHub account isn't connected, or the check failed.",
  github_refused:
    'GitHub refused the approving review, so it posted as a comment.',
  requester_not_connected:
    "The person who ran this review hasn't linked GitHub, so the app couldn't confirm their access to this repository.",
};

/** A reason this build doesn't know (a newer server). */
const UNKNOWN_REASON_TITLE = 'The app posted the review to GitHub.';

/** Posted through `gh` with the person's own account. */
const LOCAL_COPY = 'Posted with your GitHub account';
const LOCAL_TITLE =
  "The review posted with your GitHub account because the app couldn't post it.";

function isApprovalReason(value: string): value is ReviewApprovalReason {
  return REVIEW_APPROVAL_REASONS.some((reason) => reason === value);
}

function outcomeCopy(
  reason: ReviewApprovalReason,
  minScore: number | undefined,
): string {
  if (reason === 'below_min_score') {
    return minScore === undefined
      ? 'Not approved · score below the minimum'
      : `Not approved · score below ${minScore}`;
  }
  return REASON_COPY[reason];
}

export function GitHubReviewOutcome({
  publisher,
  approvalReason,
  minScore,
  reviewUrl,
  onLinkGitHub,
  linkBusy = false,
}: GitHubReviewOutcomeProps): JSX.Element {
  let copy = LOCAL_COPY;
  let title = LOCAL_TITLE;
  let approved = false;
  let notConnected = false;
  if (publisher === 'app') {
    // An unknown reason (a newer server) reads as a plain post, with a title
    // that claims nothing about the policy.
    const known =
      approvalReason !== undefined && isApprovalReason(approvalReason);
    const reason: ReviewApprovalReason = known ? approvalReason : 'policy_off';
    copy = outcomeCopy(reason, minScore);
    title = known ? REASON_TITLE[reason] : UNKNOWN_REASON_TITLE;
    approved = reason === 'approved';
    notConnected = known && reason === 'requester_not_connected';
  }
  return (
    // `text-xs` sizes the "Link GitHub" link action like `ExternalTextLink`'s
    // "View review", which sets it for itself.
    <span
      className="inline-flex flex-wrap items-center gap-2 text-xs"
      data-testid="github-review-outcome"
    >
      <Badge
        tone={approved ? 'success' : 'neutral'}
        title={title}
        data-testid="github-review-outcome-badge"
      >
        {copy}
      </Badge>
      {notConnected && onLinkGitHub !== undefined ? (
        <TextLinkButton
          aria-disabled={linkBusy ? true : undefined}
          aria-busy={linkBusy ? true : undefined}
          onClick={(): void => {
            if (!linkBusy) onLinkGitHub();
          }}
          data-testid="github-review-outcome-link-github"
        >
          Link GitHub
        </TextLinkButton>
      ) : null}
      {reviewUrl ? (
        <ExternalTextLink href={reviewUrl} label="View review" />
      ) : null}
    </span>
  );
}

/** The job outputs a code review preset's posting job writes. */
type JobOutputs = Readonly<Record<string, string>> | undefined;

/**
 * The outcome of the last job whose outputs name a review publisher, or
 * `null` when no job posted a review. Pass jobs in run order.
 */
export function githubReviewOutcomeFromJobOutputs(
  jobs: Iterable<JobOutputs>,
): GitHubReviewOutcomeProps | null {
  let found: GitHubReviewOutcomeProps | null = null;
  for (const outputs of jobs) {
    const publisher = outputs?.github_review_publisher;
    if (publisher !== 'app' && publisher !== 'local') continue;
    const reason = outputs?.github_review_approval_reason ?? '';
    const score = Number.parseInt(
      outputs?.github_review_approval_min_score ?? '',
      10,
    );
    const url = outputs?.review_url ?? '';
    found = {
      publisher,
      ...(reason !== '' ? { approvalReason: reason } : {}),
      ...(Number.isInteger(score) ? { minScore: score } : {}),
      ...(url !== '' ? { reviewUrl: url } : {}),
    };
  }
  return found;
}
