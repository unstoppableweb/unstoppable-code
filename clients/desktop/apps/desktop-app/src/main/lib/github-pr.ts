import {
  GitHubRequestError,
  sameGitHubRepository,
  type GitHubRepositoryRef,
  type GitHubMergePolicy,
  type GitHubPullRequestRef,
} from '@canopy/core-runtime/node/github';
import { mapWithConcurrency } from './concurrency';
import { basename } from 'node:path';
import type { RestEndpointMethodTypes } from '@octokit/rest';
import type { ArchivedPullRequestMetadata } from '@canopy/desktop-shared/types';
import type {
  CheckDetail,
  CheckExecutionState,
  GitHubCheckSnapshot,
  CheckStatus,
  GitHubActorSnapshot,
  GitHubIssueCommentSnapshot,
  GitHubLabelSnapshot,
  GitHubMergeConflictSnapshot,
  GitHubReviewCommentSnapshot,
  GitHubReviewSnapshot,
  GitHubRateLimitEvent,
  MergePrRepoOutcome,
  PersistedPrSnapshotFileV1,
  PrLabel,
  PrMergeMethod,
  PrMergeQueueSnapshot,
  PrMergeQueueStatus,
  PrStatusData,
  RepoPrStatus,
  RepoPrTrackingData,
  ReviewStatus,
  ReviewerInfo,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import { toPrMergeQueuePhase } from '@canopy/desktop-shared/types/github';
import {
  readMergeQueueEstimatedSeconds,
  readPrMergeQueueMembership,
} from '@canopy/desktop-shared/lib/pr-merge-queue';
import {
  hasOnlyQueueEventsErrors,
  parseQueueTimelinePage,
  QUEUE_EVENT_ITEM_TYPES,
  QUEUE_EVENTS_FIELDS,
  QUEUE_EVENTS_PAGE_SIZE,
} from './github-broker/pull-requests';
import { getCurrentBranch, getRemoteUrl } from './git';
import { getGitHubBroker } from './github-broker';
import type { GitHubBrokerCredentialLease } from './github-broker/credential-port';
import { isGitHubRateLimitError } from './github-pr-sweep';
import {
  getGitHubClient,
  type GitHubClient,
  type GitHubClientEnqueueOptions,
} from './github-client';
import { invalidateGitHubPullRequest } from './github-pr-read-model';
import { isDuplicatePrError } from './github-pr-rejections';
import {
  createGitHubPullRequest,
  updateGitHubPullRequest,
} from './github-pr-writes';
import { resolveWorktreeCwd } from './resolve-worktree';
import { isRecord } from './type-guards';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import { isMultiRepoWorkspace } from './workspace-registry';

const INTERNAL_CHECK_PATTERNS: RegExp[] = [
  /^code[\s-_]?scanning/i,
  /^codeql/i,
  /^copilot/i,
  /^dependabot$/i,
  /^dependency[\s-_]?review/i,
  /^secret[\s-_]?scanning/i,
  /^lgtm/i,
  /^github[\s-_]?advanced[\s-_]?security/i,
  /^analyze/i,
  /^automerge/i,
  /^cleanup[\s-_]?artifacts?/i,
  /^upload[\s-_]?results?/i,
  /^agent$/i,
  /^prepare$/i,
];
const COMMENTS_FETCH_RATE_LIMIT_FLOOR = 10;
const PAGE_SIZE = 100;
export const PR_MERGE_RETRY_DELAYS_MS = [
  2000, 4000, 8000, 16000, 32000, 32000, 32000, 32000,
] as const;

interface GitHubPullRequestListItem {
  number: number;
  html_url: string;
  title: string;
  created_at: string;
  merged_at?: string | null;
  draft?: boolean | null;
  state?: string;
  base: { ref: string };
  head: { sha: string };
  updated_at: string;
}

type PullRequestListResponse =
  RestEndpointMethodTypes['pulls']['list']['response'];
type PullRequestDetailResponse =
  RestEndpointMethodTypes['pulls']['get']['response'];
type CheckRunsResponse =
  RestEndpointMethodTypes['checks']['listForRef']['response'];
type ReviewPageResponse =
  RestEndpointMethodTypes['pulls']['listReviews']['response'];
type IssueCommentPageResponse =
  RestEndpointMethodTypes['issues']['listComments']['response'];
type ReviewCommentPageResponse =
  RestEndpointMethodTypes['pulls']['listReviewComments']['response'];

function hasArrayData(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.data);
}

function isPullRequestListResponse(
  value: unknown,
): value is PullRequestListResponse {
  return hasArrayData(value);
}

function isPullRequestDetailResponse(
  value: unknown,
): value is PullRequestDetailResponse {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    typeof value.data.number === 'number'
  );
}

function isCheckRunsResponse(value: unknown): value is CheckRunsResponse {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    Array.isArray(value.data.check_runs)
  );
}

function isReviewPageResponse(value: unknown): value is ReviewPageResponse {
  return hasArrayData(value);
}

function isIssueCommentPageResponse(
  value: unknown,
): value is IssueCommentPageResponse {
  return hasArrayData(value);
}

function isReviewCommentPageResponse(
  value: unknown,
): value is ReviewCommentPageResponse {
  return hasArrayData(value);
}

/**
 * A safe read revalidated with the broker's ETag cache under `resourceKey`.
 * A `304` costs no rate-limit quota and resolves with the cached response.
 */
function conditionalRead<T>(
  resourceKey: string,
  isCachedData: (value: unknown) => value is T,
): GitHubClientEnqueueOptions<T> {
  return {
    operation: 'read',
    idempotency: 'safe',
    resourceKey,
    conditional: true,
    isCachedData,
  };
}

function repoResourceKey(remote: { owner: string; repo: string }): string {
  return `${remote.owner}/${remote.repo}`;
}

function isInternalCheck(name: string): boolean {
  return INTERNAL_CHECK_PATTERNS.some((pattern) => pattern.test(name));
}

interface MergeQueueEntryGraphQl {
  position: number;
  state: string;
}

// The merge queue fields ride on the first page of the review-thread query so
// open PRs pay for one GraphQL call. `isMergeQueueEnabled` reports whether the
// PR's base branch requires a merge queue; the entry id and timeline feed the
// merge queue hook triggers.
const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String, $withQueueEvents: Boolean!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        isMergeQueueEnabled
        isInMergeQueue
        mergeQueueEntry {
          id
          enqueuedAt
          position
          state
          estimatedTimeToMerge
        }
        queueEvents: timelineItems(itemTypes: ${QUEUE_EVENT_ITEM_TYPES}, last: ${QUEUE_EVENTS_PAGE_SIZE}) @include(if: $withQueueEvents) {${QUEUE_EVENTS_FIELDS}
        }
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            isResolved
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

function toMergeQueueStatus(
  pullRequest: Record<string, unknown>,
  observedAt: string,
): PrMergeQueueStatus | undefined {
  const required =
    typeof pullRequest.isMergeQueueEnabled === 'boolean'
      ? pullRequest.isMergeQueueEnabled
      : undefined;
  const entry = isRecord(pullRequest.mergeQueueEntry)
    ? pullRequest.mergeQueueEntry
    : null;
  // Any entry state counts as queued; GitHub removes unmergeable entries.
  const inQueue =
    entry !== null
      ? true
      : typeof pullRequest.isInMergeQueue === 'boolean'
        ? pullRequest.isInMergeQueue
        : undefined;
  if (required === undefined && inQueue === undefined) return undefined;
  return {
    ...(required !== undefined ? { required } : {}),
    ...(inQueue !== undefined ? { inQueue } : {}),
    ...(inQueue
      ? {
          position: typeof entry?.position === 'number' ? entry.position : null,
        }
      : {}),
    // Membership without an entry still means queued; the phase is just unknown.
    ...(inQueue && entry !== null
      ? { phase: toPrMergeQueuePhase(entry.state) }
      : {}),
    ...(inQueue ? mergeQueueEstimate(entry) : {}),
    // Every queued read is stamped, estimate or not, so the bar can tell it
    // from an older queue list read.
    ...(inQueue ? { observedAt } : {}),
  };
}

/** GitHub's estimate; empty when GitHub gave none. */
function mergeQueueEstimate(
  entry: Record<string, unknown> | null,
): Pick<PrMergeQueueStatus, 'estimatedSecondsToMerge'> {
  const estimatedSecondsToMerge = readMergeQueueEstimatedSeconds(
    entry?.estimatedTimeToMerge,
  );
  return estimatedSecondsToMerge === null ? {} : { estimatedSecondsToMerge };
}

/** Queue evidence for hooks; undefined unless membership was fully read. */
function toMergeQueueSnapshot(
  pullRequest: Record<string, unknown>,
  queueEventsFailed: boolean,
): PrMergeQueueSnapshot | undefined {
  if (
    typeof pullRequest.isMergeQueueEnabled !== 'boolean' ||
    typeof pullRequest.isInMergeQueue !== 'boolean' ||
    !(
      pullRequest.mergeQueueEntry === null ||
      isRecord(pullRequest.mergeQueueEntry)
    )
  ) {
    return undefined;
  }
  const page = queueEventsFailed
    ? null
    : parseQueueTimelinePage(pullRequest.queueEvents, QUEUE_EVENTS_PAGE_SIZE);
  return {
    required: pullRequest.isMergeQueueEnabled,
    membership: readPrMergeQueueMembership(pullRequest),
    history: page
      ? {
          status: 'complete',
          filteredCount: page.filteredCount,
          firstIndex: page.filteredCount - page.events.length,
          events: page.events,
        }
      : { status: 'unavailable' },
  };
}

/** A first-page read whose only GraphQL errors were on the queue timeline. */
class QueueEventsErrorRead {
  constructor(readonly data: unknown) {}
}

/**
 * `octokit.graphql` rejects on any GraphQL error. Errors confined to the
 * queue timeline must not cost the thread count or membership, so salvage
 * the partial data before the broker classifies the rejection.
 */
function salvageQueueEventsError(error: unknown): QueueEventsErrorRead | null {
  return isRecord(error) &&
    Array.isArray(error.errors) &&
    hasOnlyQueueEventsErrors({ errors: error.errors }) &&
    isRecord(error.data)
    ? new QueueEventsErrorRead(error.data)
    : null;
}

function readPullRequest(data: unknown): Record<string, unknown> | null {
  const repository = isRecord(data) ? data.repository : null;
  const pullRequest = isRecord(repository) ? repository.pullRequest : null;
  return isRecord(pullRequest) ? pullRequest : null;
}

export interface OpenPrGraphQlState {
  unresolvedReviewThreadCount: number | undefined;
  mergeQueue: PrMergeQueueStatus | undefined;
  mergeQueueSnapshot: PrMergeQueueSnapshot | undefined;
  /** The read failed or returned an unusable answer; retry it next sweep. */
  incomplete?: true;
}

/**
 * Count open (unresolved) review threads on a PR via GraphQL, and read the
 * merge queue state from the first page. The REST API only exposes a flat
 * comment count and has no resolved/unresolved notion, so the merge button's
 * warning treatment relies on this. Each value is `undefined` when it cannot
 * be fetched (token scope, GraphQL error) so callers can treat it as unknown
 * rather than zero or "no queue".
 */
async function fetchOpenPrGraphQlState(
  client: GitHubClient,
  remote: { owner: string; repo: string },
  prNumber: number,
): Promise<OpenPrGraphQlState> {
  let mergeQueue: PrMergeQueueStatus | undefined;
  let mergeQueueSnapshot: PrMergeQueueSnapshot | undefined;
  let queueHistoryFailed = false;
  const unknownCount = (): OpenPrGraphQlState => ({
    unresolvedReviewThreadCount: undefined,
    mergeQueue,
    mergeQueueSnapshot,
    incomplete: true,
  });
  try {
    let cursor: string | null = null;
    let unresolved = 0;
    let hasMorePages = false;
    // Defensive page cap; PRs almost never have more than a few hundred threads.
    for (let page = 0; page < 10; page += 1) {
      const withQueueEvents = page === 0;
      const response: unknown = await client.enqueue(
        (octokit) =>
          octokit
            .graphql<unknown>(REVIEW_THREADS_QUERY, {
              owner: remote.owner,
              repo: remote.repo,
              number: prNumber,
              cursor,
              withQueueEvents,
            })
            .catch((error: unknown) => {
              const salvaged = withQueueEvents
                ? salvageQueueEventsError(error)
                : null;
              if (!salvaged) throw error;
              return salvaged;
            }),
        'normal',
        { operation: 'read', idempotency: 'safe', resource: 'graphql' },
      );
      const queueEventsFailed = response instanceof QueueEventsErrorRead;
      const pullRequest = readPullRequest(
        response instanceof QueueEventsErrorRead ? response.data : response,
      );
      if (page === 0 && pullRequest) {
        queueHistoryFailed = queueEventsFailed;
        mergeQueue = toMergeQueueStatus(pullRequest, new Date().toISOString());
        mergeQueueSnapshot = toMergeQueueSnapshot(
          pullRequest,
          queueEventsFailed,
        );
      }
      const threads = pullRequest?.reviewThreads;
      if (
        !isRecord(threads) ||
        !Array.isArray(threads.nodes) ||
        !isRecord(threads.pageInfo) ||
        typeof threads.pageInfo.hasNextPage !== 'boolean' ||
        !threads.nodes.every(
          (node: unknown) =>
            isRecord(node) && typeof node.isResolved === 'boolean',
        )
      ) {
        return unknownCount();
      }
      unresolved += threads.nodes.filter(
        (node: unknown) => isRecord(node) && node.isResolved === false,
      ).length;
      hasMorePages = threads.pageInfo.hasNextPage;
      if (!hasMorePages) {
        break;
      }
      const { endCursor } = threads.pageInfo;
      cursor = typeof endCursor === 'string' ? endCursor : null;
    }
    return {
      unresolvedReviewThreadCount: hasMorePages ? undefined : unresolved,
      mergeQueue,
      mergeQueueSnapshot,
      ...(queueHistoryFailed ? { incomplete: true as const } : {}),
    };
  } catch (error) {
    if (isGitHubRateLimitError(error)) throw error;
    return unknownCount();
  }
}

interface MergeQueueStateGraphQlResponse {
  repository: {
    pullRequest: {
      id: string;
      isMergeQueueEnabled: boolean;
      isInMergeQueue: boolean;
      mergeQueueEntry: MergeQueueEntryGraphQl | null;
    } | null;
  } | null;
}

const MERGE_QUEUE_STATE_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
        isMergeQueueEnabled
        isInMergeQueue
        mergeQueueEntry {
          position
          state
        }
      }
    }
  }
`;

interface EnqueuePullRequestGraphQlResponse {
  enqueuePullRequest: {
    mergeQueueEntry: MergeQueueEntryGraphQl | null;
  } | null;
}

const ENQUEUE_PULL_REQUEST_MUTATION = `
  mutation ($pullRequestId: ID!, $expectedHeadOid: GitObjectID) {
    enqueuePullRequest(
      input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }
    ) {
      mergeQueueEntry {
        position
        state
      }
    }
  }
`;

interface MergeQueueState {
  queueRequired: boolean;
  pullRequestId: string;
  isInMergeQueue: boolean;
  position: number | null;
  state: string | null;
}

/**
 * Read whether a PR's base branch requires a merge queue and whether the PR is
 * already queued. Returns `undefined` on any GraphQL error so callers treat
 * the queue state as unknown.
 */
async function fetchMergeQueueState(
  client: GitHubClient,
  remote: { owner: string; repo: string },
  prNumber: number,
): Promise<MergeQueueState | undefined> {
  try {
    const response = await client.enqueue(
      (octokit) =>
        octokit.graphql<MergeQueueStateGraphQlResponse>(
          MERGE_QUEUE_STATE_QUERY,
          { owner: remote.owner, repo: remote.repo, number: prNumber },
        ),
      'high',
      { operation: 'read', idempotency: 'safe', resource: 'graphql' },
    );
    const pullRequest = response.repository?.pullRequest;
    if (!pullRequest || typeof pullRequest.id !== 'string') {
      return undefined;
    }
    const entry = pullRequest.mergeQueueEntry ?? null;
    return {
      queueRequired: pullRequest.isMergeQueueEnabled === true,
      pullRequestId: pullRequest.id,
      isInMergeQueue: readPrMergeQueueMembership(pullRequest).inQueue,
      position: typeof entry?.position === 'number' ? entry.position : null,
      state: typeof entry?.state === 'string' ? entry.state : null,
    };
  } catch {
    return undefined;
  }
}

// GitHub rejects a direct merge into a branch that requires a merge queue.
function isMergeQueueRequiredError(error: unknown): boolean {
  return /\bmerge queue\b/i.test(collectErrorText(error).join('\n'));
}

function isHeadChangedEnqueueError(error: unknown): boolean {
  const text = collectErrorText(error).join('\n');
  return (
    /\bexpected ?head ?(?:oid|sha)\b/i.test(text) ||
    /\bhead (?:oid|sha|commit)\b[^\n]*\b(?:match|changed|differ)/i.test(text)
  );
}

interface RepoMergeMethodCapabilities {
  allowMergeCommit: boolean;
  allowSquashMerge: boolean;
  allowRebaseMerge: boolean;
}

interface MergePrForRepoOptions {
  /** Pins compatibility fallbacks to the repository their dispatcher verified. */
  verifiedRepository?: GitHubRepositoryRef;
  retryDelaysMs?: readonly number[];
  strategy?: PrMergeMethod;
  allowEnqueue?: false;
  /** A direct canonical merge consumes the policy its handler just verified. */
  policy?: GitHubMergePolicy;
  /** Replaces the REST verification with the canonical full read, when available. */
  verify?: () => Promise<boolean | null>;
}

interface PullMergeResponse {
  data: {
    merged: boolean;
    message?: string | null;
    sha?: string | null;
  };
}

/**
 * Resolve the merge method to use for a repo, matching the repo's settings.
 * GitHub does not expose a single "default" method, so we mirror its own UI
 * preference order (merge commit → squash → rebase) among the allowed methods.
 * Defaults to a merge commit when capabilities cannot be read.
 */
function pickRepoDefaultMergeMethod(
  capabilities: RepoMergeMethodCapabilities,
): PrMergeMethod {
  if (capabilities.allowMergeCommit) return 'merge';
  if (capabilities.allowSquashMerge) return 'squash';
  if (capabilities.allowRebaseMerge) return 'rebase';
  return 'merge';
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function readRecordProperty(value: unknown, property: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return value[property];
}

function collectErrorText(value: unknown): string[] {
  const parts: string[] = [];
  const message = readRecordProperty(value, 'message');
  if (typeof message === 'string') {
    parts.push(message);
  }

  const response = readRecordProperty(value, 'response');
  const data = readRecordProperty(response, 'data');
  const dataMessage = readRecordProperty(data, 'message');
  if (typeof dataMessage === 'string') {
    parts.push(dataMessage);
  }

  const errors = readRecordProperty(data, 'errors');
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const entryMessage = readRecordProperty(entry, 'message');
      if (typeof entryMessage === 'string') {
        parts.push(entryMessage);
      }
    }
  }

  return parts;
}

function getErrorStatus(value: unknown): number | undefined {
  const status = readRecordProperty(value, 'status');
  if (typeof status === 'number') {
    return status;
  }

  const response = readRecordProperty(value, 'response');
  const responseStatus = readRecordProperty(response, 'status');
  return typeof responseStatus === 'number' ? responseStatus : undefined;
}

/** The writer's mergeability classes, also used by the desktop request handle. */
export function classifyPrMergeError(
  error: unknown,
): 'conflict' | 'retryable' | null {
  const status = getErrorStatus(error);
  const text = collectErrorText(error).join('\n').toLowerCase();
  if (/\bmerge conflicts?\b/.test(text)) {
    return 'conflict';
  }
  if (
    /\bnot mergeable\b/.test(text) ||
    /\bnot in a mergeable state\b/.test(text) ||
    /\bbase branch was modified\b/.test(text) ||
    /\breview and try the merge again\b/.test(text) ||
    /\btry the merge again\b/.test(text) ||
    /\bmerge commit cannot be cleanly created\b/.test(text)
  ) {
    return 'retryable';
  }

  return status === 405 || status === 409 ? 'retryable' : null;
}

function isRetryablePrMergeError(error: unknown): boolean {
  return classifyPrMergeError(error) === 'retryable';
}

function isDirtyMergeConflict(pr: {
  mergeable_state?: string | null;
}): boolean {
  return pr.mergeable_state?.toLowerCase() === 'dirty';
}

export function parseGitHubRemote(
  remoteUrl: string,
): { owner: string; repo: string } | null {
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const httpsMatch = remoteUrl.match(
    /https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

export async function hasGitHubPullRequestHistoryForBranch(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    return false;
  }

  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) {
    return false;
  }

  try {
    const client = getGitHubClient();
    const pulls = await client.enqueue(
      (octokit) =>
        octokit.pulls.list({
          owner: remote.owner,
          repo: remote.repo,
          head: `${remote.owner}:${branchName}`,
          state: 'all',
          per_page: 1,
        }),
      'normal',
      { operation: 'read', idempotency: 'safe' },
    );
    return pulls.data.length > 0;
  } catch {
    return false;
  }
}

function archivedPullRequestState(
  pullRequest: GitHubPullRequestListItem,
): ArchivedPullRequestMetadata['state'] {
  if (pullRequest.merged_at) return 'merged';
  if (pullRequest.state === 'closed') return 'closed';
  if (pullRequest.draft) return 'draft';
  if (pullRequest.state === 'open') return 'open';
  throw new Error('GitHub returned an invalid pull request state.');
}

/**
 * Fetch the narrow, renderer-safe pull-request projection captured with an
 * archived worktree. Open pull requests win over branch history, and both
 * list requests share one caller-controlled deadline.
 */
export async function fetchArchivedPullRequestMetadata(
  repoPath: string,
  branchName: string,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<ArchivedPullRequestMetadata | null> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Archived pull request lookup timed out.');
  }
  const deadline = Date.now() + timeoutMs;
  if (options?.signal?.aborted) {
    throw new Error('Archived pull request lookup was cancelled.');
  }

  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    throw new Error(`No remote URL found for repository at ${repoPath}`);
  }
  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) {
    throw new Error('The repository remote is not supported by GitHub.com.');
  }

  const client = getGitHubClient();
  const list = async (
    state: 'open' | 'all',
  ): Promise<GitHubPullRequestListItem | null> => {
    if (options?.signal?.aborted) {
      throw new Error('Archived pull request lookup was cancelled.');
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Archived pull request lookup timed out.');
    }
    const response = await client.enqueue(
      (octokit) =>
        octokit.pulls.list({
          owner: remote.owner,
          repo: remote.repo,
          head: `${remote.owner}:${branchName}`,
          state,
          sort: 'updated',
          direction: 'desc',
          per_page: 1,
        }),
      'normal',
      {
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: Math.max(1, remainingMs),
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    const pullRequest: GitHubPullRequestListItem | undefined = response.data[0];
    return pullRequest ?? null;
  };

  const openPullRequests = await list('open');
  const pullRequest = openPullRequests ?? (await list('all'));
  if (!pullRequest) return null;

  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    title: pullRequest.title,
    state: archivedPullRequestState(pullRequest),
    ...(pullRequest.base.ref ? { baseRefName: pullRequest.base.ref } : {}),
    updatedAt: new Date(pullRequest.updated_at).toISOString(),
  };
}

function mapCheckRunStatus(
  status: string,
  conclusion: string | null,
): CheckStatus {
  if (status !== 'completed') {
    return 'pending';
  }
  if (conclusion === 'success') {
    return 'passing';
  }
  if (
    conclusion === 'failure' ||
    conclusion === 'timed_out' ||
    conclusion === 'cancelled' ||
    conclusion === 'startup_failure'
  ) {
    return 'failing';
  }
  if (
    conclusion === 'neutral' ||
    conclusion === 'skipped' ||
    conclusion === 'action_required' ||
    conclusion === 'stale'
  ) {
    return 'neutral';
  }
  return 'pending';
}

/**
 * The GitHub state behind {@link mapCheckRunStatus}, kept apart where the
 * four-value status merges them. The raw status wins while the run has not
 * completed. Unrecognized input yields undefined so the optional field is
 * omitted rather than guessed.
 */
function mapCheckRunExecutionState(
  status: string,
  conclusion: string | null,
): CheckExecutionState | undefined {
  switch (status) {
    case 'queued':
    case 'requested':
    case 'waiting':
    case 'pending':
      return 'queued';
    case 'in_progress':
      return 'running';
    case 'completed':
      break;
    default:
      return undefined;
  }
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    case 'skipped':
      return 'skipped';
    case 'action_required':
      return 'action_required';
    case 'neutral':
    case 'stale':
      return 'neutral';
    default:
      return undefined;
  }
}

interface GitHubCheckRunRecord {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string | null;
  html_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: {
    slug?: string;
    name?: string;
  } | null;
}

function getCheckRunAppKey(checkRun: GitHubCheckRunRecord): string {
  return checkRun.app?.slug ?? checkRun.app?.name ?? '';
}

function getCheckRunIdentity(checkRun: GitHubCheckRunRecord): string {
  return `${getCheckRunAppKey(checkRun)}\0${checkRun.name}`;
}

function compareCheckRuns(
  left: GitHubCheckRunRecord,
  right: GitHubCheckRunRecord,
): number {
  return right.id - left.id;
}

function compareCheckRunNames(
  left: GitHubCheckRunRecord,
  right: GitHubCheckRunRecord,
): number {
  const nameComparison = left.name.localeCompare(right.name);
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return getCheckRunAppKey(left).localeCompare(getCheckRunAppKey(right));
}

function dedupeCheckRuns(
  checkRuns: GitHubCheckRunRecord[],
): GitHubCheckRunRecord[] {
  const latestByIdentity = new Map<string, GitHubCheckRunRecord>();

  for (const checkRun of [...checkRuns].sort(compareCheckRuns)) {
    const identity = getCheckRunIdentity(checkRun);
    if (!latestByIdentity.has(identity)) {
      latestByIdentity.set(identity, checkRun);
    }
  }

  return Array.from(latestByIdentity.values()).sort(compareCheckRunNames);
}

function mapCheckRunToDetail(checkRun: GitHubCheckRunRecord): CheckDetail {
  const executionState = mapCheckRunExecutionState(
    checkRun.status,
    checkRun.conclusion,
  );
  return {
    name: checkRun.name,
    status: mapCheckRunStatus(checkRun.status, checkRun.conclusion),
    ...(executionState === undefined ? {} : { executionState }),
    detailsUrl: checkRun.details_url ?? checkRun.html_url ?? null,
  };
}

function mapCheckRunToSnapshot(
  checkRun: GitHubCheckRunRecord,
): GitHubCheckSnapshot {
  return {
    id: checkRun.id,
    name: checkRun.name,
    appSlug: checkRun.app?.slug ?? null,
    appName: checkRun.app?.name ?? null,
    status: mapCheckRunStatus(checkRun.status, checkRun.conclusion),
    rawStatus: checkRun.status,
    conclusion: checkRun.conclusion,
    detailsUrl: checkRun.details_url ?? checkRun.html_url ?? null,
    startedAt: checkRun.started_at ?? null,
    completedAt: checkRun.completed_at ?? null,
  };
}

function deriveOverallCheckStatus(checks: CheckDetail[]): CheckStatus {
  if (checks.length === 0) {
    return 'none';
  }
  if (checks.some((check) => check.status === 'failing')) {
    return 'failing';
  }
  if (checks.some((check) => check.status === 'pending')) {
    return 'pending';
  }
  if (checks.every((check) => check.status === 'neutral')) {
    return 'neutral';
  }
  return 'passing';
}

function mapReviewState(
  state: string,
): 'approved' | 'changes_requested' | 'pending' | null {
  switch (state) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'PENDING':
      return 'pending';
    default:
      return null;
  }
}

function deriveOverallReviewStatus(reviewers: ReviewerInfo[]): ReviewStatus {
  if (reviewers.length === 0) {
    return 'none';
  }
  if (reviewers.some((reviewer) => reviewer.state === 'changes_requested')) {
    return 'changes_requested';
  }
  if (reviewers.every((reviewer) => reviewer.state === 'approved')) {
    return 'approved';
  }
  return 'pending';
}

function mapActor(
  user:
    | {
        login?: string;
        id?: number;
        node_id?: string;
        html_url?: string;
        url?: string;
      }
    | null
    | undefined,
): GitHubActorSnapshot | null {
  if (!user?.login) {
    return null;
  }

  return {
    login: user.login,
    id: typeof user.id === 'number' ? user.id : null,
    nodeId: typeof user.node_id === 'string' ? user.node_id : null,
    htmlUrl: typeof user.html_url === 'string' ? user.html_url : null,
    apiUrl: typeof user.url === 'string' ? user.url : null,
  };
}

function mapLabel(label: {
  id: number;
  node_id?: string;
  name?: string;
  color?: string;
  description?: string | null;
}): GitHubLabelSnapshot {
  return {
    id: label.id,
    nodeId: typeof label.node_id === 'string' ? label.node_id : null,
    name: typeof label.name === 'string' ? label.name : '',
    color: typeof label.color === 'string' ? label.color : '',
    description:
      typeof label.description === 'string' ? label.description : null,
  };
}

/**
 * Maps GitHub PR labels to the lightweight {@link PrLabel} shape rendered by the
 * activity panel. Labels without a usable name are dropped.
 */
function mapPrLabels(
  labels:
    | ReadonlyArray<{
        name?: string;
        color?: string | null;
        description?: string | null;
      }>
    | null
    | undefined,
): PrLabel[] {
  return (labels ?? [])
    .map((label) => ({
      name: typeof label.name === 'string' ? label.name : '',
      color: typeof label.color === 'string' ? label.color : '',
      description:
        typeof label.description === 'string' ? label.description : null,
    }))
    .filter((label) => label.name.length > 0);
}

function getPrState(pr: {
  merged_at?: string | null;
  draft?: boolean | null;
  state?: string;
}): PersistedPrSnapshotFileV1['pr']['state'] {
  if (pr.merged_at) {
    return 'merged';
  }
  if (pr.state === 'closed') {
    return 'closed';
  }
  if (pr.draft) {
    return 'draft';
  }
  return 'open';
}

async function paginate<T>(args: {
  fetchPage: (page: number) => Promise<T[]>;
}): Promise<T[]> {
  const items: T[] = [];
  let page = 1;

  while (true) {
    const pageItems = await args.fetchPage(page);
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) {
      return items;
    }
    page += 1;
  }
}

interface GitHubReviewListItem {
  state: string;
  user?: { login?: string } | null;
}

/**
 * Fetch every review event used to derive the lightweight PR review status.
 * GitHub returns reviews oldest-first, so an approval can fall beyond the first
 * 100 events on active PRs with many comment-only reviews.
 */
async function fetchAllPullRequestReviews(
  client: GitHubClient,
  remote: { owner: string; repo: string },
  prNumber: number,
): Promise<GitHubReviewListItem[]> {
  return paginate({
    fetchPage: (page) => fetchReviewPage(client, remote, prNumber, page),
  });
}

/**
 * Each page revalidates under its own key, so a `304` page reuses its cached
 * items and a short page ends the list without reading further.
 */
async function fetchReviewPage(
  client: GitHubClient,
  remote: { owner: string; repo: string },
  prNumber: number,
  page: number,
): Promise<ReviewPageResponse['data']> {
  const response = await client.enqueue(
    (octokit, conditionalHeaders) =>
      octokit.pulls.listReviews({
        owner: remote.owner,
        repo: remote.repo,
        pull_number: prNumber,
        per_page: PAGE_SIZE,
        page,
        headers: conditionalHeaders,
      }),
    'normal',
    conditionalRead(
      `pulls.listReviews:${repoResourceKey(remote)}#${prNumber}:${page}`,
      isReviewPageResponse,
    ),
  );
  return response.data;
}

async function fetchPaginatedSnapshotCollection<T>(args: {
  enabled: boolean;
  fetchPage: (page: number) => Promise<T[]>;
}): Promise<{ items: T[]; isComplete: boolean }> {
  if (!args.enabled) {
    return {
      items: [],
      isComplete: false,
    };
  }

  try {
    return {
      items: await paginate({ fetchPage: args.fetchPage }),
      isComplete: true,
    };
  } catch (error) {
    if (isGitHubRateLimitError(error)) throw error;
    return {
      items: [],
      isComplete: false,
    };
  }
}

function sortByNumericId<T extends { id: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.id - right.id);
}

/**
 * Caps the persisted PR body. The worktree-row tooltip only shows the first
 * ~100 characters, so a modest cap keeps `lastKnownPrStatus` small while
 * leaving room for whitespace collapsing on the renderer.
 */
const PR_BODY_MAX_LENGTH = 240;

function truncatePrBody(body: string): string {
  return body.length > PR_BODY_MAX_LENGTH
    ? body.slice(0, PR_BODY_MAX_LENGTH)
    : body;
}

function buildStatus(args: {
  pr: {
    number: number;
    html_url: string;
    head?: {
      sha?: string | null;
    } | null;
    base?: {
      ref?: string | null;
    } | null;
    title: string;
    body?: string | null;
    created_at: string;
    merged_at?: string | null;
    draft?: boolean | null;
    state?: string;
    mergeable?: boolean | null;
    mergeable_state?: string | null;
    comments: number;
    review_comments: number;
    updated_at: string;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    labels?: Array<{
      name?: string;
      color?: string | null;
      description?: string | null;
    }> | null;
  };
  checkDetails: CheckDetail[];
  reviewers: ReviewerInfo[];
}): PrStatusData {
  const labels = mapPrLabels(args.pr.labels);
  const status: PrStatusData = {
    prNumber: args.pr.number,
    prUrl: args.pr.html_url,
    ...(args.pr.head?.sha ? { headSha: args.pr.head.sha } : {}),
    ...(args.pr.base?.ref ? { baseRefName: args.pr.base.ref } : {}),
    state: getPrState(args.pr),
    title: args.pr.title,
    ...(args.pr.body ? { body: truncatePrBody(args.pr.body) } : {}),
    checkStatus: deriveOverallCheckStatus(args.checkDetails),
    checkDetails: args.checkDetails,
    reviewStatus: deriveOverallReviewStatus(args.reviewers),
    reviewers: args.reviewers,
    ...(labels.length > 0 ? { labels } : {}),
    hasConflicts: hasMergeConflicts(args.pr),
    mergeable: args.pr.mergeable ?? null,
    mergeableState: args.pr.mergeable_state ?? null,
    commentCount: args.pr.comments + args.pr.review_comments,
    updatedAt: args.pr.updated_at,
    openedAt: args.pr.created_at,
  };
  if (args.pr.merged_at) {
    status.mergedAt = args.pr.merged_at;
  }
  if (typeof args.pr.additions === 'number') {
    status.additions = args.pr.additions;
  }
  if (typeof args.pr.deletions === 'number') {
    status.deletions = args.pr.deletions;
  }
  if (typeof args.pr.changed_files === 'number') {
    status.changedFiles = args.pr.changed_files;
  }
  return status;
}

function buildFallbackStatus(args: {
  pr: {
    number: number;
    html_url: string;
    head?: {
      sha?: string | null;
    } | null;
    base?: {
      ref?: string | null;
    } | null;
    title: string;
    merged_at?: string | null;
    draft?: boolean | null;
    state?: string;
    updated_at: string;
  };
  checkDetails: CheckDetail[];
  reviewers: ReviewerInfo[];
}): PrStatusData {
  return {
    prNumber: args.pr.number,
    prUrl: args.pr.html_url,
    ...(args.pr.head?.sha ? { headSha: args.pr.head.sha } : {}),
    ...(args.pr.base?.ref ? { baseRefName: args.pr.base.ref } : {}),
    state: getPrState(args.pr),
    title: args.pr.title,
    checkStatus: deriveOverallCheckStatus(args.checkDetails),
    checkDetails: args.checkDetails,
    reviewStatus: deriveOverallReviewStatus(args.reviewers),
    reviewers: args.reviewers,
    hasConflicts: false,
    mergeable: null,
    mergeableState: null,
    commentCount: 0,
    updatedAt: args.pr.updated_at,
  };
}

function hasMergeConflicts(pr: {
  mergeable?: boolean | null;
  mergeable_state?: string | null;
}): boolean {
  return pr.mergeable === false || pr.mergeable_state === 'dirty';
}

function buildMergeConflictSnapshot(pr: {
  mergeable?: boolean | null;
  mergeable_state?: string | null;
}): GitHubMergeConflictSnapshot {
  return {
    hasConflicts: hasMergeConflicts(pr),
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? null,
  };
}

/**
 * Runs every request of one logical read in the same broker lane, under the
 * caller's spend-summary label.
 */
function withRequestPriority(
  client: GitHubClient,
  priority: 'high' | 'normal',
  caller?: string,
  credential?: GitHubBrokerCredentialLease,
): GitHubClient {
  return {
    enqueue: (fn, _priority, requestOptions) =>
      client.enqueue(fn, priority, {
        ...requestOptions,
        ...(caller ? { caller } : {}),
        ...(credential ? { credential } : {}),
      }),
  };
}

interface PrTrackingReadOptions {
  includeCommentCollections?: boolean;
  onCommentFetchSkipped?: (
    message: string,
    rateLimit?: Omit<GitHubRateLimitEvent, 'message'>,
  ) => void;
  /**
   * `high` for a read the user is waiting on, such as a Merge click. The
   * broker runs one request at a time, so a default-priority read queues
   * behind every poll and sweep already waiting.
   */
  priority?: 'high' | 'normal';
  /** Pin all reads to the credential lease sampled by the tracking owner. */
  credential?: GitHubBrokerCredentialLease;
  /** Spend-summary label for the broker. */
  caller?: string;
}

/** The GitHub.com repository behind a checkout's remote, if any. */
export async function resolveGitHubRemoteForRepo(
  repoPath: string,
): Promise<{ owner: string; repo: string } | null> {
  const remoteUrl = await getRemoteUrl(repoPath);
  return remoteUrl ? parseGitHubRemote(remoteUrl) : null;
}

export async function fetchRepoPrTrackingData(
  repoPath: string,
  branchName: string,
  options?: PrTrackingReadOptions,
): Promise<RepoPrTrackingData> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    return {
      status: null,
      snapshot: null,
      branchName,
      remote: null,
    };
  }

  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) {
    return {
      status: null,
      snapshot: null,
      branchName,
      remote: null,
    };
  }

  return fetchRepoPrTrackingDataForRemote(remote, branchName, options);
}

export async function fetchRepoPrTrackingDataForRemote(
  remote: GitHubRepositoryRef,
  branchName: string,
  options?: PrTrackingReadOptions,
): Promise<RepoPrTrackingData> {
  const client = withRequestPriority(
    getGitHubClient(),
    options?.priority ?? 'normal',
    options?.caller,
    options?.credential,
  );
  const listPulls = (state: 'open' | 'all'): Promise<PullRequestListResponse> =>
    client.enqueue(
      (octokit, conditionalHeaders) =>
        octokit.pulls.list({
          owner: remote.owner,
          repo: remote.repo,
          head: `${remote.owner}:${branchName}`,
          state,
          per_page: 1,
          headers: conditionalHeaders,
        }),
      'normal',
      conditionalRead(
        `pulls.list:${repoResourceKey(remote)}:${state}:${branchName}`,
        isPullRequestListResponse,
      ),
    );
  const openPulls = await listPulls('open');
  const pulls = openPulls.data.length > 0 ? openPulls : await listPulls('all');
  if (pulls.data.length === 0) {
    return {
      status: null,
      snapshot: null,
      branchName,
      remote,
    };
  }

  const pr: GitHubPullRequestListItem = pulls.data[0];
  const read = await readTrackedPullRequest(
    client,
    remote,
    branchName,
    pr,
    options,
  );
  return read.trackingData;
}

/**
 * `complete` is false when a part of the read failed and the result fell back
 * to partial data, so a sweep reads the pull request again next time.
 */
export interface TrackedPullRequestRead {
  trackingData: RepoPrTrackingData;
  complete: boolean;
}

/** Merge queue and review-thread state from a previous read of the same PR. */
export function reusablePrGraphQlState(
  previous: RepoPrTrackingData,
): OpenPrGraphQlState {
  return {
    unresolvedReviewThreadCount: previous.status?.unresolvedReviewThreadCount,
    mergeQueue: previous.status?.mergeQueue,
    mergeQueueSnapshot: previous.snapshot?.mergeQueue,
  };
}

/**
 * Read a pull request a sweep already found, skipping the branch lookup.
 * `reuseGraphQlState` skips the review-thread and merge queue query when the
 * sweep's fingerprint shows neither moved.
 */
export async function fetchTrackedPullRequestData(args: {
  remote: { owner: string; repo: string };
  branchName: string;
  pullRequest: {
    number: number;
    url: string;
    title: string;
    state: 'open' | 'closed' | 'merged';
    isDraft: boolean;
    headSha: string;
    baseRefName: string;
    createdAt: string;
    updatedAt: string;
    mergedAt: string | null;
  };
  options?: PrTrackingReadOptions;
  reuseGraphQlState?: OpenPrGraphQlState;
}): Promise<TrackedPullRequestRead> {
  const { pullRequest } = args;
  const client = withRequestPriority(
    getGitHubClient(),
    args.options?.priority ?? 'normal',
    args.options?.caller,
    args.options?.credential,
  );
  return readTrackedPullRequest(
    client,
    args.remote,
    args.branchName,
    {
      number: pullRequest.number,
      html_url: pullRequest.url,
      title: pullRequest.title,
      created_at: pullRequest.createdAt,
      merged_at: pullRequest.mergedAt,
      draft: pullRequest.isDraft,
      state: pullRequest.state === 'open' ? 'open' : 'closed',
      base: { ref: pullRequest.baseRefName },
      head: { sha: pullRequest.headSha },
      updated_at: pullRequest.updatedAt,
    },
    args.options,
    args.reuseGraphQlState,
  );
}

async function readTrackedPullRequest(
  client: GitHubClient,
  remote: { owner: string; repo: string },
  branchName: string,
  pr: GitHubPullRequestListItem,
  options?: PrTrackingReadOptions,
  reuseGraphQlState?: OpenPrGraphQlState,
): Promise<TrackedPullRequestRead> {
  const [prDetailsResult, checkRunsResult, reviewStatusResult] =
    await Promise.allSettled([
      client.enqueue(
        (octokit, conditionalHeaders) =>
          octokit.pulls.get({
            owner: remote.owner,
            repo: remote.repo,
            pull_number: pr.number,
            headers: conditionalHeaders,
          }),
        'normal',
        conditionalRead(
          `pulls.get:${repoResourceKey(remote)}#${pr.number}`,
          isPullRequestDetailResponse,
        ),
      ),
      client.enqueue(
        (octokit, conditionalHeaders) =>
          octokit.checks.listForRef({
            owner: remote.owner,
            repo: remote.repo,
            ref: pr.head.sha,
            per_page: PAGE_SIZE,
            headers: conditionalHeaders,
          }),
        'normal',
        conditionalRead(
          `checks.listForRef:${repoResourceKey(remote)}@${pr.head.sha}`,
          isCheckRunsResponse,
        ),
      ),
      fetchAllPullRequestReviews(client, remote, pr.number),
    ]);

  // A refused part would degrade the status and drop the snapshot, and the
  // next good read would then report the pull request as newly created.
  for (const result of [prDetailsResult, checkRunsResult, reviewStatusResult]) {
    if (result.status === 'rejected' && isGitHubRateLimitError(result.reason)) {
      throw result.reason;
    }
  }
  const prDetails =
    prDetailsResult.status === 'fulfilled' ? prDetailsResult.value : null;
  const checkRuns =
    checkRunsResult.status === 'fulfilled'
      ? checkRunsResult.value.data.check_runs
      : [];
  const reviews =
    reviewStatusResult.status === 'fulfilled' ? reviewStatusResult.value : [];
  const filteredCheckRuns = dedupeCheckRuns(
    checkRuns.filter((checkRun) => !isInternalCheck(checkRun.name)),
  );
  const checkDetails: CheckDetail[] =
    filteredCheckRuns.map(mapCheckRunToDetail);

  const reviewerMap = new Map<string, ReviewerInfo>();
  for (const review of reviews) {
    if (!review.user?.login) {
      continue;
    }
    if (review.state === 'DISMISSED') {
      reviewerMap.delete(review.user.login);
      continue;
    }
    const state = mapReviewState(review.state);
    if (!state) {
      continue;
    }
    reviewerMap.set(review.user.login, {
      login: review.user.login,
      state,
    });
  }
  const reviewers = Array.from(reviewerMap.values()).sort((left, right) =>
    left.login.localeCompare(right.login),
  );

  const status =
    prDetails === null
      ? buildFallbackStatus({
          pr,
          checkDetails,
          reviewers,
        })
      : buildStatus({
          pr: prDetails.data,
          checkDetails,
          reviewers,
        });

  if (prDetails === null) {
    return {
      trackingData: {
        status,
        snapshot: null,
        branchName,
        remote,
      },
      complete: false,
    };
  }

  const shouldFetchComments = options?.includeCommentCollections === true;
  // A 304 replays the cached response's headers, so read GitHub's latest
  // count from the broker rather than from the details response.
  const quota = getGitHubBroker().currentQuota(undefined, options?.credential);
  const canFetchComments =
    shouldFetchComments &&
    (quota === undefined || quota.remaining > COMMENTS_FETCH_RATE_LIMIT_FLOOR);

  if (shouldFetchComments && !canFetchComments && quota) {
    const now = Date.now();
    const retryAtMs = Math.max(now, quota.resetAtMs + 1000);
    const rateLimit = {
      kind: 'primary' as const,
      retryAt: new Date(retryAtMs).toISOString(),
      retryAfterSeconds: Math.ceil((retryAtMs - now) / 1000),
      resource: quota.resource,
    };
    options?.onCommentFetchSkipped?.(
      `Skipped GitHub comment fetches for ${remote.owner}/${remote.repo}#${pr.number} because the API rate-limit budget is low.`,
      rateLimit,
    );
  }

  const [pagedReviews, issueComments, reviewComments] = await Promise.all([
    fetchPaginatedSnapshotCollection({
      enabled: canFetchComments,
      fetchPage: (page) => fetchReviewPage(client, remote, pr.number, page),
    }),
    fetchPaginatedSnapshotCollection({
      enabled: canFetchComments,
      fetchPage: async (page) => {
        const response = await client.enqueue(
          (octokit, conditionalHeaders) =>
            octokit.issues.listComments({
              owner: remote.owner,
              repo: remote.repo,
              issue_number: pr.number,
              per_page: PAGE_SIZE,
              page,
              headers: conditionalHeaders,
            }),
          'normal',
          conditionalRead(
            `issues.listComments:${repoResourceKey(remote)}#${pr.number}:${page}`,
            isIssueCommentPageResponse,
          ),
        );
        return response.data;
      },
    }),
    fetchPaginatedSnapshotCollection({
      enabled: canFetchComments,
      fetchPage: async (page) => {
        const response = await client.enqueue(
          (octokit, conditionalHeaders) =>
            octokit.pulls.listReviewComments({
              owner: remote.owner,
              repo: remote.repo,
              pull_number: pr.number,
              per_page: PAGE_SIZE,
              page,
              headers: conditionalHeaders,
            }),
          'normal',
          conditionalRead(
            `pulls.listReviewComments:${repoResourceKey(remote)}#${pr.number}:${page}`,
            isReviewCommentPageResponse,
          ),
        );
        return response.data;
      },
    }),
  ]);

  const snapshot: PersistedPrSnapshotFileV1 = {
    version: 1,
    provider: 'github',
    capturedAt: new Date().toISOString(),
    includesComments: issueComments.isComplete,
    includesReviews: pagedReviews.isComplete,
    includesReviewComments: reviewComments.isComplete,
    repository: {
      owner: remote.owner,
      name: remote.repo,
      fullName: `${remote.owner}/${remote.repo}`,
    },
    branch: {
      currentName: branchName,
      headRefName: prDetails.data.head?.ref ?? branchName,
      baseRefName: prDetails.data.base?.ref ?? '',
      headSha: prDetails.data.head?.sha ?? pr.head.sha,
      baseSha: prDetails.data.base?.sha ?? null,
    },
    pr: {
      id: prDetails.data.id,
      number: prDetails.data.number,
      nodeId: prDetails.data.node_id ?? null,
      htmlUrl: prDetails.data.html_url,
      apiUrl: prDetails.data.url ?? null,
      state: getPrState(prDetails.data),
      isDraft: prDetails.data.draft ?? false,
      title: prDetails.data.title,
      body: prDetails.data.body ?? '',
      author: mapActor(prDetails.data.user),
      createdAt: prDetails.data.created_at,
      updatedAt: prDetails.data.updated_at,
      mergedAt: prDetails.data.merged_at ?? null,
      closedAt: prDetails.data.closed_at ?? null,
      mergeCommitSha: prDetails.data.merge_commit_sha ?? null,
      mergedBy: mapActor(prDetails.data.merged_by),
      isCrossRepository:
        prDetails.data.head?.repo?.full_name !==
        prDetails.data.base?.repo?.full_name,
      labels: sortByNumericId((prDetails.data.labels ?? []).map(mapLabel)),
      assignees: (prDetails.data.assignees ?? [])
        .map((assignee) => mapActor(assignee))
        .filter((actor): actor is GitHubActorSnapshot => actor !== null),
      requestedReviewers: (prDetails.data.requested_reviewers ?? [])
        .map((reviewer) => mapActor(reviewer))
        .filter((actor): actor is GitHubActorSnapshot => actor !== null),
    },
    issueComments: sortByNumericId(
      issueComments.items.map(
        (comment): GitHubIssueCommentSnapshot => ({
          id: comment.id,
          nodeId: comment.node_id ?? null,
          htmlUrl: comment.html_url ?? null,
          apiUrl: comment.url ?? null,
          author: mapActor(comment.user),
          authorAssociation: comment.author_association ?? null,
          body: comment.body ?? '',
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
        }),
      ),
    ),
    reviews: sortByNumericId(
      pagedReviews.items.map(
        (review): GitHubReviewSnapshot => ({
          id: review.id,
          nodeId: review.node_id ?? null,
          htmlUrl: review.html_url ?? null,
          apiUrl: null,
          author: mapActor(review.user),
          state: review.state,
          body: review.body ?? '',
          commitId: review.commit_id ?? null,
          submittedAt: review.submitted_at ?? null,
        }),
      ),
    ),
    reviewComments: sortByNumericId(
      reviewComments.items.map(
        (comment): GitHubReviewCommentSnapshot => ({
          id: comment.id,
          nodeId: comment.node_id ?? null,
          htmlUrl: comment.html_url ?? null,
          apiUrl: comment.url ?? null,
          pullRequestReviewId: comment.pull_request_review_id ?? null,
          inReplyToId: comment.in_reply_to_id ?? null,
          author: mapActor(comment.user),
          authorAssociation: comment.author_association ?? null,
          body: comment.body ?? '',
          path: comment.path,
          commitId: comment.commit_id ?? null,
          originalCommitId: comment.original_commit_id ?? null,
          diffHunk: comment.diff_hunk ?? null,
          line: comment.line ?? null,
          originalLine: comment.original_line ?? null,
          startLine: comment.start_line ?? null,
          originalStartLine: comment.original_start_line ?? null,
          side: comment.side ?? null,
          startSide: comment.start_side ?? null,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
        }),
      ),
    ),
    checks: {
      headSha: prDetails.data.head?.sha ?? pr.head.sha,
      items: filteredCheckRuns.map(mapCheckRunToSnapshot),
    },
    mergeConflicts: buildMergeConflictSnapshot(prDetails.data),
  };

  // Fetched last so it never shifts the ordered REST/comment requests above.
  // Closed/merged PRs skip the GraphQL call. Drafts read it for queue hooks
  // only (a draft conversion dequeues); their status output stays unchanged.
  let graphQlComplete = true;
  if (status.state === 'open' || status.state === 'draft') {
    const graphQlState =
      reuseGraphQlState ??
      (await fetchOpenPrGraphQlState(client, remote, pr.number));
    graphQlComplete = graphQlState.incomplete !== true;
    if (status.state === 'open') {
      status.unresolvedReviewThreadCount =
        graphQlState.unresolvedReviewThreadCount;
      if (graphQlState.mergeQueue) {
        status.mergeQueue = graphQlState.mergeQueue;
      }
    }
    if (graphQlState.mergeQueueSnapshot) {
      snapshot.mergeQueue = graphQlState.mergeQueueSnapshot;
    }
  }

  return {
    trackingData: {
      status,
      snapshot,
      branchName,
      remote,
    },
    complete:
      graphQlComplete &&
      checkRunsResult.status === 'fulfilled' &&
      reviewStatusResult.status === 'fulfilled' &&
      (!shouldFetchComments ||
        (pagedReviews.isComplete &&
          issueComments.isComplete &&
          reviewComments.isComplete)),
  };
}

export async function fetchPrStatusForRepo(
  repoPath: string,
  branchName: string,
): Promise<PrStatusData | null> {
  const trackingData = await fetchRepoPrTrackingData(repoPath, branchName, {
    priority: 'high',
  });
  return trackingData.status;
}

export async function fetchPrStatusForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<WorktreePrStatus | null> {
  const cwd = resolveWorktreeCwd(projectId, worktreeId);

  if (isMultiRepoWorkspace(projectId)) {
    const repoEntries = await listWorkspaceWorktreeRepoEntries(
      projectId,
      cwd,
    ).catch(() => []);
    if (repoEntries.length === 0) {
      return null;
    }

    const repos: RepoPrStatus[] = await mapWithConcurrency(
      repoEntries,
      4,
      async (entry) => {
        const branch = await getCurrentBranch(entry.repoPath).catch(() => '');
        const trackingData = branch
          ? await fetchRepoPrTrackingData(entry.repoPath, branch, {
              priority: 'high',
            }).catch(() => null)
          : null;
        return {
          repoId: entry.repoId,
          repoName: entry.repoName,
          status: trackingData?.status ?? null,
          prLookupAvailable:
            trackingData != null && trackingData.remote !== null,
        };
      },
    );

    return {
      repos,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  const branch = await getCurrentBranch(cwd).catch(() => '');
  if (!branch) {
    return null;
  }

  const trackingData = await fetchRepoPrTrackingData(cwd, branch, {
    priority: 'high',
  }).catch(() => null);

  return {
    repos: [
      {
        repoId: basename(cwd),
        repoName: basename(cwd),
        status: trackingData?.status ?? null,
        prLookupAvailable: trackingData != null && trackingData.remote !== null,
      },
    ],
    lastCheckedAt: new Date().toISOString(),
  };
}

async function resolvePullRequestWriteRepository(
  repoPath: string,
  verifiedRepository?: GitHubRepositoryRef,
): Promise<GitHubRepositoryRef> {
  const remoteUrl = await getRemoteUrl(repoPath);
  const checkout = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
  if (
    verifiedRepository !== undefined &&
    (checkout === null || !sameGitHubRepository(checkout, verifiedRepository))
  )
    throw new Error('PR state changed. Refresh and try again.');
  if (!remoteUrl) {
    throw new Error(`No remote URL found for repository at ${repoPath}`);
  }
  if (!checkout) {
    throw new Error(
      `Could not parse GitHub remote URL: "${remoteUrl}" (repoPath: ${repoPath})`,
    );
  }
  return verifiedRepository ?? checkout;
}

export async function updatePrBaseBranchForRepo(
  repoPath: string,
  prNumber: number,
  newBaseBranch: string,
  verifiedRepository?: GitHubRepositoryRef,
): Promise<{ prUrl: string }> {
  const remote = await resolvePullRequestWriteRepository(
    repoPath,
    verifiedRepository,
  );

  const { url } = await updateGitHubPullRequest(
    { ...remote, number: prNumber },
    { base: newBaseBranch },
  );
  return { prUrl: url };
}

/** A minimal reference to a PR discovered by base-branch lookup. */
export interface DependentPrRef {
  prNumber: number;
  prUrl: string;
  headBranch: string;
}

/**
 * List open PRs in this repo whose base branch is `baseBranch`. Used by the
 * split-PR finalize step to find PRs that were stacked on the original PR's
 * head branch: when a split retargets that branch to the new integration
 * branch (or closes the original PR entirely), any sibling PR still based on
 * it needs to be retargeted too, which matters for a nested/mid-stack split.
 *
 * Pagination is intentionally skipped (`per_page: 100`, no follow-up pages):
 * more than 100 open PRs based on a single branch is not a real case.
 */
export async function listOpenPrsBasedOnBranchForRepo(
  repoPath: string,
  baseBranch: string,
): Promise<DependentPrRef[]> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    throw new Error(`No remote URL found for repository at ${repoPath}`);
  }

  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) {
    throw new Error(
      `Could not parse GitHub remote URL: "${remoteUrl}" (repoPath: ${repoPath})`,
    );
  }

  const client = getGitHubClient();
  const result = await client.enqueue(
    (octokit) =>
      octokit.pulls.list({
        owner: remote.owner,
        repo: remote.repo,
        base: baseBranch,
        state: 'open',
        per_page: 100,
      }),
    'normal',
    { operation: 'read', idempotency: 'safe' },
  );

  return result.data.map((pr) => ({
    prNumber: pr.number,
    prUrl: pr.html_url,
    headBranch: pr.head.ref,
  }));
}

/**
 * Close a PR via the GitHub API. When `comment` is provided, posts it as an
 * issue comment before closing so the reason for closing is recorded on the
 * PR timeline.
 */
export async function closePrForRepo(
  repoPath: string,
  prNumber: number,
  comment?: string,
): Promise<void> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    throw new Error(`No remote URL found for repository at ${repoPath}`);
  }

  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) {
    throw new Error(
      `Could not parse GitHub remote URL: "${remoteUrl}" (repoPath: ${repoPath})`,
    );
  }

  const client = getGitHubClient();

  if (comment) {
    await client.enqueue(
      (octokit) =>
        octokit.issues.createComment({
          owner: remote.owner,
          repo: remote.repo,
          issue_number: prNumber,
          body: comment,
        }),
      'high',
      { operation: 'mutation', idempotency: 'unsafe' },
    );
  }

  await client.enqueue(
    (octokit) =>
      octokit.pulls.update({
        owner: remote.owner,
        repo: remote.repo,
        pull_number: prNumber,
        state: 'closed',
      }),
    'high',
    { operation: 'mutation', idempotency: 'unsafe' },
  );
  invalidateGitHubPullRequest({ ...remote, number: prNumber });
}

/**
 * Replace a PR's body via the GitHub API.
 */
export async function updatePrBodyForRepo(
  repoPath: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    throw new Error(`No remote URL found for repository at ${repoPath}`);
  }

  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) {
    throw new Error(
      `Could not parse GitHub remote URL: "${remoteUrl}" (repoPath: ${repoPath})`,
    );
  }

  const client = getGitHubClient();
  await client.enqueue(
    (octokit) =>
      octokit.pulls.update({
        owner: remote.owner,
        repo: remote.repo,
        pull_number: prNumber,
        body,
      }),
    'high',
    { operation: 'mutation', idempotency: 'unsafe' },
  );
  invalidateGitHubPullRequest({ ...remote, number: prNumber });
}

export interface MergePrForRepoResult {
  /** True only after this mutation merged the PR and a read confirmed it.
   * False when retry reconciliation discovers a merge with unknown origin. */
  newlyMerged?: boolean;
  /** `enqueued` when the base branch requires a merge queue. */
  outcome: MergePrRepoOutcome;
  /**
   * The repo's preferred method. Informational for `enqueued` results: the
   * merge queue's configuration decides how the PR lands, so do not display it.
   */
  mergeMethod: PrMergeMethod;
  /** Null for `enqueued` results. */
  mergeCommitSha: string | null;
  /** 1-based merge queue position for `enqueued` results, when known. */
  queuePosition?: number | null;
}

export async function readGitHubPullRequestMergePolicy(
  ref: GitHubPullRequestRef,
): Promise<GitHubMergePolicy> {
  const client = getGitHubClient();
  const settings = await client.enqueue(
    (octokit) => octokit.repos.get({ owner: ref.owner, repo: ref.repo }),
    'high',
    { operation: 'read', idempotency: 'safe' },
  );
  const capabilities = {
    allowMergeCommit: settings.data.allow_merge_commit ?? true,
    allowSquashMerge: settings.data.allow_squash_merge ?? true,
    allowRebaseMerge: settings.data.allow_rebase_merge ?? true,
  };
  const allowedStrategies: GitHubMergePolicy['preferredStrategy'][] = [];
  if (capabilities.allowMergeCommit) allowedStrategies.push('merge');
  if (capabilities.allowSquashMerge) allowedStrategies.push('squash');
  if (capabilities.allowRebaseMerge) allowedStrategies.push('rebase');
  const queue = await fetchMergeQueueState(client, ref, ref.number);
  return {
    allowedStrategies,
    preferredStrategy: pickRepoDefaultMergeMethod(capabilities),
    queueRequired: queue?.queueRequired === true,
  };
}

/**
 * Merge an open PR via the GitHub API using the repo's preferred merge method.
 * After the merge, re-fetches the PR and confirms GitHub reports it merged so
 * callers only update Canopy tracking on a verified merge.
 *
 * When the PR's base branch requires a merge queue, adds the PR to the queue
 * instead (GitHub's direct-merge API rejects such PRs) and returns
 * `outcome: 'enqueued'`. A PR that is already queued is returned as enqueued
 * without another mutation.
 */
export async function mergePrForRepo(
  repoPath: string,
  prNumber: number,
  expectedHeadSha: string,
  options: MergePrForRepoOptions = {},
): Promise<MergePrForRepoResult> {
  const remote = await resolvePullRequestWriteRepository(
    repoPath,
    options.verifiedRepository,
  );

  try {
    return await mergePrForRemote(remote, prNumber, expectedHeadSha, options);
  } finally {
    invalidateGitHubPullRequest({ ...remote, number: prNumber });
  }
}

export async function mergePrForRemote(
  remote: { owner: string; repo: string },
  prNumber: number,
  expectedHeadSha: string,
  options: MergePrForRepoOptions,
): Promise<MergePrForRepoResult> {
  const client = getGitHubClient();

  const policy = options.allowEnqueue === false ? options.policy : undefined;
  const mergeMethod = policy
    ? (options.strategy ?? policy.preferredStrategy)
    : await (async (): Promise<PrMergeMethod> => {
        const repoSettings = await client.enqueue(
          (octokit) =>
            octokit.repos.get({ owner: remote.owner, repo: remote.repo }),
          'high',
          { operation: 'read', idempotency: 'safe' },
        );
        return (
          options.strategy ??
          pickRepoDefaultMergeMethod({
            allowMergeCommit: repoSettings.data.allow_merge_commit ?? true,
            allowSquashMerge: repoSettings.data.allow_squash_merge ?? true,
            allowRebaseMerge: repoSettings.data.allow_rebase_merge ?? true,
          })
        );
      })();

  const enqueuedResult = (
    queuePosition: number | null,
  ): MergePrForRepoResult => ({
    outcome: 'enqueued',
    mergeMethod,
    mergeCommitSha: null,
    queuePosition,
  });

  const enqueue = async (
    queueState: MergeQueueState,
  ): Promise<MergePrForRepoResult> => {
    if (queueState.isInMergeQueue) {
      return enqueuedResult(queueState.position);
    }
    try {
      const response = await client.enqueue(
        (octokit) =>
          octokit.graphql<EnqueuePullRequestGraphQlResponse>(
            ENQUEUE_PULL_REQUEST_MUTATION,
            {
              pullRequestId: queueState.pullRequestId,
              expectedHeadOid: expectedHeadSha,
            },
          ),
        'high',
        { operation: 'mutation', idempotency: 'unsafe', resource: 'graphql' },
      );
      const position = response.enqueuePullRequest?.mergeQueueEntry?.position;
      return enqueuedResult(typeof position === 'number' ? position : null);
    } catch (error) {
      // "Already queued" (for example a second click before the status bar
      // refreshed) is success. Re-read instead of matching GitHub's message.
      const latest = await fetchMergeQueueState(client, remote, prNumber);
      if (latest?.isInMergeQueue) {
        return enqueuedResult(latest.position);
      }
      // The caller verified a head sha that is now stale; retrying cannot help.
      if (isHeadChangedEnqueueError(error)) {
        throw new Error(
          'Cannot add the pull request to the merge queue because the PR head commit changed. Refresh and try again.',
        );
      }
      throw error;
    }
  };

  const queueState = policy
    ? null
    : await fetchMergeQueueState(client, remote, prNumber);
  if (policy?.queueRequired || queueState?.queueRequired) {
    if (options.allowEnqueue === false)
      throw new GitHubRequestError(
        'merge_queue_required',
        'The base branch requires a merge queue.',
      );
    if (queueState) return enqueue(queueState);
  }

  // The queue state was unknown or stale (a ruleset enabled after the read) and
  // GitHub refused a direct merge because the base branch requires a merge
  // queue: re-read the state and enqueue instead. If that fails too,
  // surface GitHub's original merge error.
  const enqueueAfterQueueRejection = async (
    mergeError: unknown,
  ): Promise<MergePrForRepoResult> => {
    if (options.allowEnqueue === false)
      throw new GitHubRequestError(
        'merge_queue_required',
        'The base branch requires a merge queue.',
        { cause: mergeError },
      );
    const latest = await fetchMergeQueueState(client, remote, prNumber);
    if (!latest) {
      throw mergeError;
    }
    try {
      return await enqueue(latest);
    } catch {
      throw mergeError;
    }
  };

  const retryDelaysMs = options.retryDelaysMs ?? PR_MERGE_RETRY_DELAYS_MS;
  let attempt = 0;
  const verifyPrCanStillBeRetried = async (
    mergeError: unknown,
  ): Promise<MergePrForRepoResult | null> => {
    const latest = await client.enqueue(
      (octokit) =>
        octokit.pulls.get({
          owner: remote.owner,
          repo: remote.repo,
          pull_number: prNumber,
        }),
      'high',
      { operation: 'read', idempotency: 'safe' },
    );
    if (latest.data.merged) {
      return {
        outcome: 'merged',
        newlyMerged: false,
        mergeMethod,
        mergeCommitSha: latest.data.merge_commit_sha ?? null,
      };
    }
    if (latest.data.state !== 'open') {
      throw mergeError;
    }
    const latestHeadSha =
      typeof latest.data.head?.sha === 'string' ? latest.data.head.sha : null;
    if (latestHeadSha && latestHeadSha !== expectedHeadSha) {
      throw new Error(
        'Cannot retry the pull request merge because the PR head commit changed.',
      );
    }
    if (isDirtyMergeConflict(latest.data)) {
      throw mergeError;
    }

    return null;
  };

  while (true) {
    let mergeResult: PullMergeResponse;
    try {
      mergeResult = await client.enqueue(
        (octokit) =>
          octokit.pulls.merge({
            owner: remote.owner,
            repo: remote.repo,
            pull_number: prNumber,
            merge_method: mergeMethod,
            sha: expectedHeadSha,
          }),
        'high',
        { operation: 'mutation', idempotency: 'unsafe' },
      );
    } catch (error) {
      // Checked before the retryable branch, which treats 405/409 as transient
      // and would otherwise spend every retry delay on a permanent refusal.
      if (isMergeQueueRequiredError(error)) {
        return enqueueAfterQueueRejection(error);
      }
      if (!isRetryablePrMergeError(error) || attempt >= retryDelaysMs.length) {
        throw error;
      }

      const existingMerge = await verifyPrCanStillBeRetried(error);
      if (existingMerge) {
        return existingMerge;
      }

      const delayMs = retryDelaysMs[attempt];
      attempt += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[github-pr] GitHub reported PR #${prNumber} as temporarily not mergeable; retrying merge in ${delayMs}ms.`,
      );
      await delay(delayMs);
      continue;
    }

    if (!mergeResult.data.merged) {
      const error = new Error(
        mergeResult.data.message || 'GitHub did not merge the pull request.',
      );
      if (isMergeQueueRequiredError(error)) {
        return enqueueAfterQueueRejection(error);
      }
      if (!isRetryablePrMergeError(error) || attempt >= retryDelaysMs.length) {
        throw error;
      }
      const existingMerge = await verifyPrCanStillBeRetried(error);
      if (existingMerge) {
        return existingMerge;
      }
      const delayMs = retryDelaysMs[attempt];
      attempt += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[github-pr] GitHub did not merge PR #${prNumber} yet; retrying merge in ${delayMs}ms.`,
      );
      await delay(delayMs);
      continue;
    }

    // Verify GitHub now reports the PR as merged before we update Canopy tracking.
    const projection = await options.verify?.();
    const merged =
      projection ??
      (
        await client.enqueue(
          (octokit) =>
            octokit.pulls.get({
              owner: remote.owner,
              repo: remote.repo,
              pull_number: prNumber,
            }),
          'high',
          { operation: 'read', idempotency: 'safe' },
        )
      ).data.merged;
    if (!merged) {
      throw new Error(
        'Merge request succeeded but GitHub still reports the PR as open.',
      );
    }

    return {
      outcome: 'merged',
      newlyMerged: true,
      mergeMethod,
      mergeCommitSha: mergeResult.data.sha ?? null,
    };
  }
}

export async function createPrForRepo(
  repoPath: string,
  branchName: string,
  title: string,
  body: string,
  baseBranch: string,
  draft = false,
  verifiedRepository?: GitHubRepositoryRef,
): Promise<{ prNumber: number; prUrl: string; created: boolean }> {
  const remote = await resolvePullRequestWriteRepository(
    repoPath,
    verifiedRepository,
  );

  try {
    const { number, url } = await createGitHubPullRequest(remote, {
      title,
      body,
      head: branchName,
      base: baseBranch,
      draft,
    });

    return { prNumber: number, prUrl: url, created: true };
  } catch (error: unknown) {
    if (!isDuplicatePrError(error)) {
      throw error;
    }

    // Refuse drift before reconciliation reads, and keep those reads bound
    // across awaits just as the attempted create was.
    const reconciliationRemote =
      verifiedRepository === undefined
        ? undefined
        : await resolvePullRequestWriteRepository(repoPath, verifiedRepository);
    const existing = await (
      reconciliationRemote === undefined
        ? fetchRepoPrTrackingData(repoPath, branchName, { priority: 'high' })
        : fetchRepoPrTrackingDataForRemote(reconciliationRemote, branchName, {
            priority: 'high',
          })
    ).catch(() => null);
    const prNumber = existing?.status?.prNumber;
    const prUrl = existing?.status?.prUrl;
    if (typeof prNumber === 'number' && typeof prUrl === 'string' && prUrl) {
      return { prNumber, prUrl, created: false };
    }

    throw error;
  }
}
