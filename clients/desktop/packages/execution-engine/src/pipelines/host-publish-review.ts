/**
 * Browser-safe contract for the `github-publish-review` host step: a packaged
 * code review posted to its pull request as the GitHub App, through
 * `core.pullRequest.review.publish` (desktop and daemon runs) or the web
 * core's publisher directly (cloud runs).
 *
 * The executor parses inputs with {@link parsePublishReviewInputs}, reads and
 * fits the review, and raises one request. A publish result is always a
 * successful host step: `published`, `unavailable` and `failed` all answer
 * with {@link publishReviewOutputs}, so a preset branches on
 * `steps.<id>.outputs.status`. `unavailable` means nothing was posted, so the
 * preset's `gh` step may post; `failed` never falls back. The Node fallback
 * (no host port, or the CLI, which opts out) answers `unavailable: no_host`.
 */
import {
  REVIEW_PUBLISH_PAYLOAD_MAX_BYTES,
  type ReviewPublishApprovalFacts,
  type ReviewPublishPayload,
} from '@canopy/protocol/canopy-core';
import { presentInput, type HostInputParse } from './host-actions';

/** The largest review JSON file the executor reads. */
export const PUBLISH_REVIEW_JSON_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** The largest diff file the executor reads; a larger one is no diff. */
export const PUBLISH_REVIEW_DIFF_FILE_MAX_BYTES = 10 * 1024 * 1024;
/**
 * The most a fitted review (body, comments and replies, as UTF-8 JSON) may
 * take. Below the daemon host's request limit, which the executor asserts.
 */
export const PUBLISH_REVIEW_PAYLOAD_MAX_BYTES =
  REVIEW_PUBLISH_PAYLOAD_MAX_BYTES;

export interface PublishReviewPullRequest {
  owner: string;
  repo: string;
  number: number;
}

/** What the executor parses from the step's inputs, before reading files. */
export interface PublishReviewParsedInputs {
  pr: PublishReviewPullRequest;
  reviewJsonFile: string;
  /** Absent when the step names none. */
  diffFile?: string;
  /** `''`, or a full 40- or 64-character SHA in lowercase. */
  reviewedHead: string;
  reviewedUncommitted: boolean;
  approvalFacts: ReviewPublishApprovalFacts;
}

/** The request the host settles: the fitted review and its facts. */
export interface PublishReviewRequestInputs {
  pr: PublishReviewPullRequest;
  reviewedHead: string;
  reviewedUncommitted: boolean;
  payload: ReviewPublishPayload;
  approvalFacts: ReviewPublishApprovalFacts;
}

export {
  emptyPublishReviewOutputs,
  PUBLISH_REVIEW_OUTPUTS,
  publishReviewOutputs,
} from '@canopy/pipeline-interop/github-publish-review-outputs';

const PR_URL_PATTERNS = [
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/,
  /^([^/]+)\/([^/]+)\/pull\/(\d+)$/,
  /^([^/]+)\/([^/]+)\/(\d+)$/,
  /^([^/]+)\/([^/#]+)#(\d+)$/,
  /^([^/]+)\/([^\s]+)\s+(\d+)$/,
];

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A pull request named the way `builtin/github-post-review-comment` takes
 * one (`parsePrIdentifier`): a GitHub PR URL or `owner/repo#123`.
 */
export function parsePublishReviewPrUrl(
  raw: string,
): PublishReviewPullRequest | null {
  const input = raw.trim();
  for (const pattern of PR_URL_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      const number = Number.parseInt(match[3], 10);
      if (
        !GITHUB_NAME.test(match[1]) ||
        !GITHUB_NAME.test(match[2]) ||
        !Number.isSafeInteger(number) ||
        number <= 0 ||
        number > 2_147_483_647
      )
        return null;
      return { owner: match[1], repo: match[2], number };
    }
  }
  return null;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A recorded full SHA in lowercase; anything else is no head (`''`). */
function reviewedHeadOf(raw: string | undefined): string {
  const value = raw?.trim().toLowerCase() ?? '';
  return FULL_SHA.test(value) ? value : '';
}

/** A finite number, or null for a missing or malformed score. */
function scoreOf(raw: string | undefined): number | null {
  const value = raw?.trim() ?? '';
  if (value === '') return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

/**
 * Parses the step's inputs. Only an unparseable `pr_url` or a missing
 * `review_json_file` is refused here; the approval facts are taken as
 * reported, read conservatively: `reviewed_uncommitted` is false only when it
 * says `false`, and `completeness_complete` is true only when it says `true`.
 */
export function parsePublishReviewInputs(
  inputs: Record<string, string | undefined>,
): HostInputParse<PublishReviewParsedInputs> {
  const prUrl = presentInput(inputs, 'pr_url');
  if (prUrl === undefined)
    return { ok: false, message: 'github-publish-review requires "pr_url"' };
  const pr = parsePublishReviewPrUrl(prUrl);
  if (pr === null)
    return {
      ok: false,
      message:
        'github-publish-review "pr_url" must be a GitHub pull request URL or owner/repo#123',
    };
  const reviewJsonFile = presentInput(inputs, 'review_json_file');
  if (reviewJsonFile === undefined)
    return {
      ok: false,
      message: 'github-publish-review requires "review_json_file"',
    };
  const diffFile = presentInput(inputs, 'diff_file');
  const uncommitted = presentInput(inputs, 'reviewed_uncommitted');
  return {
    ok: true,
    value: {
      pr,
      reviewJsonFile,
      ...(diffFile !== undefined ? { diffFile } : {}),
      reviewedHead: reviewedHeadOf(inputs.reviewed_head),
      reviewedUncommitted: uncommitted?.toLowerCase() !== 'false',
      approvalFacts: {
        verdict: (presentInput(inputs, 'verdict') ?? '').slice(0, 64),
        score: scoreOf(inputs.score),
        complete:
          presentInput(inputs, 'completeness_complete')?.toLowerCase() ===
          'true',
      },
    },
  };
}
