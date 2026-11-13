import type { AgentActionCall } from '../surface/family';

/** A GitHub.com pull request, by repository owner, name, and number. */
export interface AgentPullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export interface AgentPullRequestChecksSummary {
  state: 'success' | 'failure' | 'pending' | 'none';
  total: number;
  passed: number;
  failed: number;
  pending: number;
  failedNames: string[];
  /** False when GitHub withheld the checks from the credential. */
  available: boolean;
}

/** One pull request's current status, as GetGitHubPullRequestStatus returns it. */
export interface AgentPullRequestStatus {
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  /** `owner/name` the head branch lives in; null when that fork is gone. */
  headRepository: string | null;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  checks: AgentPullRequestChecksSummary;
  mergeQueue: { inQueue: boolean; position: number | null };
  /** When GitHub was read; a cached answer keeps its original time. */
  fetchedAt: string;
}

export type AgentPullRequestStatusFailureCode =
  | 'invalid_input'
  | 'invalid_reference'
  | 'rate_limited'
  | 'not_found'
  | 'permission_denied'
  | 'not_authenticated'
  | 'unavailable';

/**
 * A refused pull request read with its agent-facing message. `retryAt` is
 * when GitHub reads resume, for `rate_limited`.
 */
export class AgentPullRequestStatusError extends Error {
  readonly code: AgentPullRequestStatusFailureCode;
  readonly retryAt: Date | undefined;
  constructor(
    code: AgentPullRequestStatusFailureCode,
    message: string,
    options: { retryAt?: Date } = {},
  ) {
    super(message);
    this.name = 'AgentPullRequestStatusError';
    this.code = code;
    this.retryAt = options.retryAt;
  }
}

/**
 * Host-side read of a pull request's status with the calling chat owner's
 * GitHub credential. Repeated and concurrent reads of one pull request
 * should share one GitHub request. Throws `AgentPullRequestStatusError`.
 */
export interface AgentPullRequestStatusPort<H> {
  read(
    ref: AgentPullRequestRef,
    call: AgentActionCall<H>,
  ): Promise<AgentPullRequestStatus>;
}
