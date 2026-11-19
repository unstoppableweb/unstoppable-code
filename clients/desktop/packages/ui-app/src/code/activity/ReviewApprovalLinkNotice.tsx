'use client';

import { useId, type JSX } from 'react';
import {
  FieldError,
  Notice,
  NoticeButton,
  TextLinkButton,
} from '@canopy/ui-shared/components';
import { parseStrictGitHubPullRequestReference } from '@canopy/protocol/portable-tasks/pull-request-reference';
import type { ReviewApprovalReadinessInput } from '@canopy/protocol/settings/github-review-approvals';
import type { PullRequestSectionPrState } from './PullRequestSectionBody';
import {
  useReviewApprovalLink,
  useReviewApprovalReadiness,
  useReviewApprovalReadinessList,
} from './review-approval-readiness';

// ---------------------------------------------------------------------------
// "Link GitHub to get review approvals" (CAN-7162).
//
// The organization approves a pull request only when the person whose review
// passed has linked GitHub in the product. This notice asks them to, in the
// PR section (`full`) and above the code review launch's Run (`compact`). It
// is informational (a missing link isn't a problem with the pull request),
// never dismissible, and never blocks a run; it disappears once the person
// links GitHub. Copy names the payoff, not the mechanism, and says "link".
// ---------------------------------------------------------------------------

/** The two readiness states that ask the person to link GitHub. */
export type ReviewApprovalLinkState = 'connect_github' | 'reconnect_github';

export function isReviewApprovalLinkState(
  state: string,
): state is ReviewApprovalLinkState {
  return state === 'connect_github' || state === 'reconnect_github';
}

export interface ReviewApprovalLinkNoticeProps {
  readonly state: ReviewApprovalLinkState;
  /** The organization's display name; null reads "Your organization". */
  readonly organizationName: string | null;
  /** The product name, from the host's brand helper. */
  readonly brandName: string;
  /** `full`: PR section; `compact`: the launch dialog, body only. */
  readonly variant: 'full' | 'compact';
  readonly busy: boolean;
  /** Fixed copy for a failed link. */
  readonly error: string | null;
  readonly onLink: () => void;
}

function noticeCopy(
  state: ReviewApprovalLinkState,
  organizationName: string | null,
  brandName: string,
  variant: 'full' | 'compact',
): { title?: string; body: string } {
  const relink = state === 'reconnect_github';
  if (variant === 'compact') {
    // The inline action right after it says what to do, so the sentence
    // states only the effect.
    return {
      body: relink
        ? `This review can't approve the pull request until GitHub is linked again.`
        : `This review can't approve the pull request yet.`,
    };
  }
  return relink
    ? {
        title: 'Link GitHub again to get review approvals',
        body: `${brandName} lost access to your linked GitHub account.`,
      }
    : {
        title: 'Link GitHub to get review approvals',
        body: `${organizationName ?? 'Your organization'} approves pull requests when your review passes, using the GitHub account you link in ${brandName}. Your local sign-in isn't shared.`,
      };
}

/** Pure display over the shared `Notice`. */
export function ReviewApprovalLinkNotice({
  state,
  organizationName,
  brandName,
  variant,
  busy,
  error,
  onLink,
}: ReviewApprovalLinkNoticeProps): JSX.Element {
  const errorId = useId();
  const copy = noticeCopy(state, organizationName, brandName, variant);
  const label = state === 'reconnect_github' ? 'Link again' : 'Link GitHub';
  if (variant === 'compact') {
    // A dialog footer hint, like the run-blocked line beside it: one quiet
    // line with the action inline, not a boxed notice competing with Run.
    return (
      <div
        className="flex flex-col gap-1 text-xs"
        data-testid="review-approval-link-notice-compact"
      >
        <p className="fg-tertiary text-pretty">
          {copy.body}{' '}
          <TextLinkButton
            data-testid="review-approval-link-action"
            // `aria-disabled`, not `disabled`: focus stays on the button.
            aria-disabled={busy ? true : undefined}
            aria-busy={busy ? true : undefined}
            aria-describedby={error === null ? undefined : errorId}
            onClick={() => {
              if (!busy) onLink();
            }}
          >
            {busy ? 'Linking…' : label}
          </TextLinkButton>
        </p>
        {error === null ? null : (
          <FieldError id={errorId} announce>
            {error}
          </FieldError>
        )}
      </div>
    );
  }
  return (
    <Notice
      intent="neutral"
      {...(copy.title === undefined ? {} : { title: copy.title })}
      data-testid={`review-approval-link-notice-${variant}`}
      detail={error ?? undefined}
      announceDetail
      actions={
        <NoticeButton
          variant="primary"
          data-testid="review-approval-link-action"
          // `aria-disabled`, not `disabled`: focus stays on the button.
          aria-disabled={busy ? true : undefined}
          busy={busy}
          busyLabel="Linking…"
          onClick={() => {
            if (!busy) onLink();
          }}
        >
          {label}
        </NoticeButton>
      }
    >
      {copy.body}
    </Notice>
  );
}

/** `owner`/`name` of a github.com pull request URL, or null. */
export function gitHubRepositoryOfPullRequestUrl(
  prUrl: string,
): { owner: string; name: string } | null {
  const parsed = parseStrictGitHubPullRequestReference(prUrl);
  if (!parsed.ok) return null;
  const [owner, name, ...rest] = parsed.value.repository.split('/');
  return owner && name && rest.length === 0 ? { owner, name } : null;
}

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `owner`/`name` of a github.com git remote (HTTPS, SSH or scp form), or
 * null for any other host or shape.
 */
export function gitHubRepositoryOfRemoteUrl(
  remoteUrl: string,
): { owner: string; name: string } | null {
  const trimmed = remoteUrl.trim();
  const match =
    /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    ) ??
    /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const owner = match?.[1];
  const name = match?.[2];
  return owner &&
    name &&
    GITHUB_NAME.test(owner) &&
    GITHUB_NAME.test(name) &&
    name !== '.' &&
    name !== '..'
    ? { owner, name }
    : null;
}

/** `owner`/`name` of a posted review's URL (its pull request), or null. */
export function gitHubRepositoryOfReviewUrl(
  reviewUrl: string,
): { owner: string; name: string } | null {
  if (!URL.canParse(reviewUrl)) return null;
  const url = new URL(reviewUrl);
  return gitHubRepositoryOfPullRequestUrl(`${url.origin}${url.pathname}`);
}

/**
 * A run owner from a project's owning organization: `org:<uuid>`, or
 * `personal` without one (the work owner, never the navigation context).
 */
export function reviewApprovalRunOwnerOf(
  organizationId: string | null | undefined,
): string {
  return organizationId ? `org:${organizationId}` : 'personal';
}

/** The readiness input for a run owner and repository, or null. */
export function reviewApprovalReadinessInput(
  runOwner: string | null | undefined,
  repository: { owner: string; name: string } | null,
): ReviewApprovalReadinessInput | null {
  if (!runOwner || repository === null) return null;
  return {
    runOwner,
    repoOwner: repository.owner,
    repoName: repository.name,
  };
}

export interface PullRequestReviewApprovalNoticeProps {
  /** `personal` or `org:<uuid>`: the work owner; null shows nothing. */
  readonly runOwner: string | null | undefined;
  readonly prUrl: string;
  readonly prState: PullRequestSectionPrState;
  readonly brandName: string;
}

/**
 * The PR section's notice: shows for an open or draft github.com pull request
 * when the person's reviews can't approve until they link GitHub.
 */
export function PullRequestReviewApprovalNotice({
  runOwner,
  prUrl,
  prState,
  brandName,
}: PullRequestReviewApprovalNoticeProps): JSX.Element | null {
  // A merged or closed pull request can't be approved.
  const approvable = prState === 'open' || prState === 'draft';
  const input = approvable
    ? reviewApprovalReadinessInput(
        runOwner,
        gitHubRepositoryOfPullRequestUrl(prUrl),
      )
    : null;
  const readiness = useReviewApprovalReadiness(input);
  const { link, busy, error } = useReviewApprovalLink();
  if (readiness === null || !isReviewApprovalLinkState(readiness.state)) {
    return null;
  }
  return (
    <ReviewApprovalLinkNotice
      state={readiness.state}
      organizationName={readiness.organizationName}
      brandName={brandName}
      variant="full"
      busy={busy}
      error={error}
      onLink={link}
    />
  );
}

export interface ReviewApprovalLaunchNoticeProps {
  /** Each repository the review may publish to, under the launch's run owner. */
  readonly inputs: readonly ReviewApprovalReadinessInput[];
  readonly brandName: string;
}

/**
 * The code review launch's compact notice, above Run. One notice for all the
 * repositories: it shows when any needs a link, preferring the first-link
 * copy when both states occur. It never disables or delays Run.
 */
export function ReviewApprovalLaunchNotice({
  inputs,
  brandName,
}: ReviewApprovalLaunchNoticeProps): JSX.Element | null {
  const values = useReviewApprovalReadinessList(inputs);
  const { link, busy, error } = useReviewApprovalLink();
  let chosen: {
    state: ReviewApprovalLinkState;
    organizationName: string | null;
  } | null = null;
  for (const value of values) {
    if (value === null || !isReviewApprovalLinkState(value.state)) continue;
    if (chosen === null || value.state === 'connect_github') {
      chosen = {
        state: value.state,
        organizationName: value.organizationName,
      };
    }
    if (chosen.state === 'connect_github') break;
  }
  if (chosen === null) return null;
  return (
    <ReviewApprovalLinkNotice
      state={chosen.state}
      organizationName={chosen.organizationName}
      brandName={brandName}
      variant="compact"
      busy={busy}
      error={error}
      onLink={link}
    />
  );
}
