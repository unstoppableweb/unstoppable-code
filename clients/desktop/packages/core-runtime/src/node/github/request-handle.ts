import {
  classifyError,
  readErrorClassification,
} from '@canopy/protocol/app-errors/classification';
import type {
  CorePullRequest,
  CorePullRequestMergeQueueGetParams,
  CorePullRequestMergeQueueGetResult,
  CorePullRequestMergeParams,
  CorePullRequestState,
  GITHUB_STORED_CREDENTIAL_STATES,
  GITHUB_TOKEN_SOURCES,
} from '@canopy/protocol/canopy-core';

/** Where Canopy's own GitHub credential comes from, as configured. */
export interface GitHubCredentialDescription {
  readonly tokenSource: (typeof GITHUB_TOKEN_SOURCES)[number];
  readonly storedCredential: (typeof GITHUB_STORED_CREDENTIAL_STATES)[number];
}

/** A GitHub repository by owner and name, as an `origin` remote names it. */
export interface GitHubRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export interface GitHubPullRequestRef extends GitHubRepositoryRef {
  readonly number: number;
}

/**
 * One pull request as GitHub reports it, already in the canonical field
 * shapes; core adds the identifiers and the revision.
 */
export type GitHubPullRequestRecord = Readonly<
  Omit<
    CorePullRequest,
    'pullRequestId' | 'integrationId' | 'repositoryId' | 'revision'
  >
>;

export interface GitHubPullRequestReadOptions {
  /** `true` reads GitHub; `false` may answer from the host's cache. */
  readonly refresh: boolean;
  readonly signal?: AbortSignal;
}

export interface GitHubPullRequestPageRequest {
  readonly states: readonly CorePullRequestState[];
  /** At most this many pull requests, most recently updated first. */
  readonly first: number;
  /** GitHub's continuation from the previous page, or `null` for the first. */
  readonly after: string | null;
}

export interface GitHubPullRequestPage {
  readonly pullRequests: readonly GitHubPullRequestRecord[];
  /** GitHub's continuation, `null` on the last page. */
  readonly endCursor: string | null;
}

export const GITHUB_REPOSITORY_PERMISSIONS = ['pull', 'push', 'admin'] as const;

/** One repository the credential can reach. */
export interface GitHubRepositoryRecord {
  /** `owner/name`. */
  readonly fullName: string;
  /** The repository's web page. */
  readonly webUrl: string;
  readonly permissions: readonly (typeof GITHUB_REPOSITORY_PERMISSIONS)[number][];
  /** GitHub's last update time; GitHub's listing types it as nullable. */
  readonly updatedAt: string | null;
}

/** One cached listing; `snapshotId` changes whenever the listing is re-read. */
export interface GitHubRepositorySnapshot {
  readonly snapshotId: string;
  readonly repositories: readonly GitHubRepositoryRecord[];
}

export interface GitHubCallOptions {
  readonly signal?: AbortSignal;
}

/** The commit a branch names on GitHub. */
export interface GitHubBranchHead {
  readonly sha: string;
}

/** A pull request GitHub created, adopted or updated. */
export interface GitHubPullRequestLocator {
  readonly number: number;
  readonly url: string;
}

export interface GitHubPullRequestCreateInput {
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

/** The members to change; an absent member is left unchanged. */
export interface GitHubPullRequestUpdateInput {
  readonly title?: string;
  readonly body?: string;
  readonly baseBranch?: string;
}

export const GITHUB_REQUEST_ERROR_CODES = [
  'not_authenticated',
  'not_found',
  'rate_limited',
  'timeout',
  'unavailable',
  'cancelled',
  'invalid_response',
  // The host read only what a compatibility projection returns, not a full
  // canonical record (CAN-4109: the legacy listing keeps its REST read).
  'projection_unavailable',
  // An open pull request already exists for the head branch.
  'duplicate',
  // GitHub refused the base branch.
  'base_rejected',
  'merge_queue_required',
  'head_mismatch',
  'not_mergeable',
] as const;

export type GitHubRequestErrorCode =
  (typeof GITHUB_REQUEST_ERROR_CODES)[number];

/**
 * A typed GitHub failure. `cause` keeps the host's own error, which the
 * in-process binding carries as the runtime cause so compatibility
 * projections rethrow it unchanged.
 */
export class GitHubRequestError extends Error {
  readonly code: GitHubRequestErrorCode;
  /** For `rate_limited`: how long until GitHub accepts a retry, when known. */
  readonly retryAfterMs?: number;
  // `declare`: only some programs' libs give Error a `cause`.
  declare readonly cause?: unknown;

  constructor(
    code: GitHubRequestErrorCode,
    message: string,
    options: { cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'GitHubRequestError';
    this.code = code;
    if (readErrorClassification(options.cause)) {
      // The more specific adapter evidence wins over this wrapper's category.
    } else if (code === 'not_authenticated')
      classifyError(this, 'external.sign_in_required');
    else if (code === 'timeout' || code === 'unavailable')
      classifyError(this, 'external.service_unavailable');
    else if (code === 'rate_limited') {
      const delay = options.retryAfterMs;
      const retryAt =
        typeof delay === 'number' && Number.isFinite(delay) && delay >= 0
          ? Math.round(Date.now() + delay)
          : undefined;
      classifyError(this, 'external.rate_limited', {
        retryAt:
          retryAt !== undefined && Number.isSafeInteger(retryAt)
            ? retryAt
            : undefined,
      });
    }
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.retryAfterMs !== undefined)
      this.retryAfterMs = options.retryAfterMs;
  }
}

export interface GitHubMergePolicy {
  readonly allowedStrategies: readonly NonNullable<
    CorePullRequestMergeParams['strategy']
  >[];
  readonly preferredStrategy: NonNullable<
    CorePullRequestMergeParams['strategy']
  >;
  readonly queueRequired: boolean;
}

export interface GitHubMergeResult {
  /** The writer's verification read; null when only legacy verification succeeded. */
  readonly projection?: GitHubPullRequestRecord | null;
  readonly outcome: 'merged' | 'enqueued';
  readonly newlyMerged?: boolean;
  readonly mergeMethod: NonNullable<CorePullRequestMergeParams['strategy']>;
  readonly mergeCommitSha: string | null;
  readonly queuePosition?: number | null;
}

/**
 * Results-only use of Canopy's GitHub credential (CAN-4109, after CAN-4960's
 * recipient handle). No member returns or accepts a token, header, client,
 * lease, token callback or credentialed URL. The desktop host implements it
 * over today's secure store, broker and read models; the daemon vault
 * (CAN-4415) later supplies the credential beneath the same interface.
 * Failures are {@link GitHubRequestError}s. The write members take no abort
 * signal: a GitHub mutation is never aborted once sent.
 */
export interface GitHubRequestHandle {
  /** Configured state only (CAN-3745 D-1); never proves GitHub accepts it. */
  describe(): Promise<GitHubCredentialDescription>;
  getMergeQueue(
    params: CorePullRequestMergeQueueGetParams,
    options: GitHubCallOptions,
  ): Promise<CorePullRequestMergeQueueGetResult>;
  getMergePolicy(
    ref: GitHubPullRequestRef,
    options: GitHubCallOptions,
  ): Promise<GitHubMergePolicy>;
  /** Exact-head direct merge only; a queue-required base refuses, never enqueues. */
  mergePullRequest(
    ref: GitHubPullRequestRef,
    input: Pick<CorePullRequestMergeParams, 'expectedHeadSha' | 'strategy'>,
    /** Fresh policy read by this instruction, consumed once by the writer. */
    policy: GitHubMergePolicy,
  ): Promise<GitHubMergeResult>;
  /** One pull request with every check and review thread. */
  getPullRequest(
    ref: GitHubPullRequestRef,
    options: GitHubPullRequestReadOptions,
  ): Promise<GitHubPullRequestRecord>;
  /** One page of a repository's pull requests in the given states. */
  listPullRequests(
    repository: GitHubRepositoryRef,
    page: GitHubPullRequestPageRequest,
    options: GitHubCallOptions,
  ): Promise<GitHubPullRequestPage>;
  /** The repositories the credential can reach, as one cached snapshot. */
  listRepositories(
    options: GitHubCallOptions,
  ): Promise<GitHubRepositorySnapshot>;
  /** The branch's commit on GitHub, or `null` when GitHub has no such branch. */
  getBranchHead(
    repository: GitHubRepositoryRef,
    branch: string,
    options: GitHubCallOptions,
  ): Promise<GitHubBranchHead | null>;
  /**
   * Creates a pull request. Fails with `duplicate` when GitHub reports an
   * open pull request for the head branch, `base_rejected` when GitHub
   * refuses the base.
   */
  createPullRequest(
    repository: GitHubRepositoryRef,
    input: GitHubPullRequestCreateInput,
  ): Promise<GitHubPullRequestLocator>;
  /** The open pull request of a head branch in the repository, or `null`. */
  findOpenPullRequest(
    repository: GitHubRepositoryRef,
    headBranch: string,
    options: GitHubCallOptions,
  ): Promise<GitHubPullRequestLocator | null>;
  /**
   * Applies the members in one update and discards the host's cached
   * projection of the pull request. Fails with `base_rejected` when GitHub
   * refuses the base.
   */
  updatePullRequest(
    ref: GitHubPullRequestRef,
    input: GitHubPullRequestUpdateInput,
  ): Promise<GitHubPullRequestLocator>;
}
