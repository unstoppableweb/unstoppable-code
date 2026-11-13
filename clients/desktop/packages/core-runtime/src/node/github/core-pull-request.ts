import { isGitHubRepositoryName } from '@canopy/protocol/reference-previews';
import {
  CORE_PULL_REQUEST_STATES,
  GITHUB_INTEGRATION_ID,
  type CanopyInstructionHandler,
  type CanopyQueryHandler,
  type CorePullRequest,
  type CorePullRequestCreateParams,
  type CorePullRequestListResult,
  type CorePullRequestUpdateParams,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  canopyCapabilityUnavailableError,
} from '../../runtime/errors';
import {
  normalizePullRequestTitleQuery,
  PullRequestTitleQueryError,
} from '@canopy/protocol/pull-requests';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  createContinuations,
  gitHubFailure,
  keyedGitHubFailure,
} from './github-errors';
import {
  mintPullRequestId,
  mintRepositoryId,
  parsePullRequestId,
  parseRepositoryId,
  sameGitHubRepository,
  type RecordedRepositoryRef,
} from './pull-request-ids';
import {
  createPullRequestReceipts,
  type PullRequestReceipts,
} from './pull-request-receipts';
import {
  GitHubRequestError,
  type GitHubPullRequestLocator,
  type GitHubPullRequestRecord,
  type GitHubPullRequestUpdateInput,
  type GitHubRepositoryRef,
  type GitHubRequestHandle,
} from './request-handle';

/** `write` also refuses a repository of a read-only workspace. */
export type RecordedRepositoryAccess = 'read' | 'write';

/**
 * Host port for `core.pullRequest.*`: trusted workspace records locate a
 * repository, and its `origin` names the GitHub repository at call time.
 */
export interface CorePullRequestHost {
  readonly github: GitHubRequestHandle;
  /** Open-title search, bound by the trusted host; at most 20, no cursor. */
  searchPullRequests?(
    repository: RecordedRepositoryRef,
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    github: GitHubRepositoryRef;
    records: readonly GitHubPullRequestRecord[];
  }>;
  /**
   * The GitHub repository the recorded repository's `origin` names now, or
   * `null` when the record names no repository, `origin` is missing or not
   * a GitHub remote, or `write` access names a read-only workspace.
   */
  resolveRepository(
    repository: RecordedRepositoryRef,
    access: RecordedRepositoryAccess,
  ): Promise<GitHubRepositoryRef | null>;
}

/** What a create or update wrote, which a same-key retry reads again. */
export interface PullRequestWriteReceipt {
  readonly github: GitHubRepositoryRef;
  readonly number: number;
}

export interface CorePullRequestHandlerOptions {
  /** Defaults to one bounded in-memory store per handler set. */
  readonly receipts?: PullRequestReceipts<PullRequestWriteReceipt>;
}

export interface CorePullRequestHandlers {
  'core.pullRequest.mergeQueue.get': CanopyQueryHandler<
    'core.pullRequest.mergeQueue.get',
    CanopyHandlerContext
  >;
  'core.pullRequest.get': CanopyQueryHandler<
    'core.pullRequest.get',
    CanopyHandlerContext
  >;
  'core.pullRequest.list': CanopyQueryHandler<
    'core.pullRequest.list',
    CanopyHandlerContext
  >;
}

export interface CorePullRequestInstructionHandlers {
  'core.pullRequest.merge': CanopyInstructionHandler<
    'core.pullRequest.merge',
    CanopyHandlerContext
  >;
  'core.pullRequest.create': CanopyInstructionHandler<
    'core.pullRequest.create',
    CanopyHandlerContext
  >;
  'core.pullRequest.update': CanopyInstructionHandler<
    'core.pullRequest.update',
    CanopyHandlerContext
  >;
}

const FAILURE_CODES = {
  notAuthenticated: 'core.pullRequest.notAuthenticated',
  notFound: 'core.pullRequest.notFound',
} as const;
const LIST_FAILURE_CODES = {
  notAuthenticated: 'core.pullRequest.notAuthenticated',
} as const;
const CREATE_FAILURE_CODES = {
  notAuthenticated: 'core.pullRequest.notAuthenticated',
  baseRejected: 'core.pullRequest.create.baseRejected',
} as const;
const UPDATE_FAILURE_CODES = {
  notAuthenticated: 'core.pullRequest.notAuthenticated',
  notFound: 'core.pullRequest.notFound',
  baseRejected: 'core.pullRequest.update.baseRejected',
} as const;
// One GitHub page: each item carries its first page of checks and review
// threads, so a page this size keeps one query within GitHub's limits.
const MAX_GITHUB_PAGE = 25;

function invalidId(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    code: 'core.pullRequest.invalidId',
    message: 'The identifier was not minted by this host.',
    retry: { kind: 'never' },
  });
}

function repositoryUnavailable(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'core.pullRequest.repositoryUnavailable',
    message:
      "The repository record is gone, or its origin does not name the pull request's GitHub repository.",
    retry: { kind: 'after_refresh', resource: 'workspace-repository' },
  });
}

function invalidFilter(message: string, cause?: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'invalid_argument',
      code: 'core.pullRequest.list.invalidFilter',
      message,
      retry: { kind: 'never' },
    },
    cause,
  );
}

async function resolve(
  host: CorePullRequestHost,
  repository: RecordedRepositoryRef,
  access: RecordedRepositoryAccess = 'read',
): Promise<GitHubRepositoryRef> {
  let github: GitHubRepositoryRef | null;
  try {
    github = await host.resolveRepository(repository, access);
  } catch (error) {
    throw new CanopyOperationError(
      {
        kind: 'internal',
        message: 'The host could not read the repository record.',
        retry: { kind: 'never' },
      },
      error,
    );
  }
  if (!github) throw repositoryUnavailable();
  return github;
}

/** GitHub's updatedAt, in epoch milliseconds (to the second). */
function revisionOf(record: GitHubPullRequestRecord): number {
  return Date.parse(record.updatedAt);
}

function project(
  record: GitHubPullRequestRecord,
  ids: { pullRequestId: string; repositoryId: string },
): CorePullRequest {
  return {
    pullRequestId: ids.pullRequestId,
    integrationId: GITHUB_INTEGRATION_ID,
    repositoryId: ids.repositoryId,
    number: record.number,
    title: record.title,
    body: record.body,
    url: record.url,
    state: record.state,
    draft: record.draft,
    baseBranch: record.baseBranch,
    baseSha: record.baseSha,
    headBranch: record.headBranch,
    headSha: record.headSha,
    mergeable: record.mergeable,
    reviewDecision: record.reviewDecision,
    checks: record.checks.map((check) => ({ ...check })),
    reviewThreadCount: record.reviewThreadCount,
    unresolvedReviewThreadCount: record.unresolvedReviewThreadCount,
    commentCount: record.commentCount,
    updatedAt: record.updatedAt,
    revision: revisionOf(record),
  };
}

function pullRequestIds(
  repository: RecordedRepositoryRef,
  github: GitHubRepositoryRef,
  number: number,
): { pullRequestId: string; repositoryId: string } {
  const repositoryId = mintRepositoryId(repository);
  const pullRequestId = mintPullRequestId({ repository, github, number });
  if (repositoryId === null || pullRequestId === null)
    throw new CanopyOperationError({
      kind: 'internal',
      message: 'GitHub returned a pull request the host cannot identify.',
      retry: { kind: 'never' },
    });
  return { pullRequestId, repositoryId };
}

/**
 * `core.pullRequest.get` and `list` for the desktop host (CAN-4109): GitHub
 * through the results-only request handle, repositories through trusted
 * workspace records and their `origin` at call time.
 */
export function createCorePullRequestHandlers(
  host: CorePullRequestHost,
): CorePullRequestHandlers {
  const continuations = createContinuations();
  return {
    'core.pullRequest.mergeQueue.get': async (params, context) => {
      const [owner = '', repo = '', extra] = params.repository.split('/');
      if (
        extra !== undefined ||
        !isGitHubRepositoryName(owner.toLowerCase(), repo.toLowerCase()) ||
        params.baseBranch.startsWith('-') ||
        /[\s~^:?*[\\]/.test(params.baseBranch) ||
        params.baseBranch.includes('..')
      )
        throw new CanopyOperationError({
          kind: 'invalid_argument',
          message: 'The merge queue reference is malformed.',
          retry: { kind: 'never' },
        });
      try {
        return await host.github.getMergeQueue(params, {
          signal: context.signal,
        });
      } catch (error) {
        throw gitHubFailure(error, FAILURE_CODES);
      }
    },
    'core.pullRequest.get': async ({ pullRequestId, refresh }, context) => {
      const identity = parsePullRequestId(pullRequestId);
      if (!identity) throw invalidId();
      const github = await resolve(host, identity.repository);
      // `origin` names another repository now: never read the same number there.
      if (!sameGitHubRepository(github, identity.github))
        throw repositoryUnavailable();
      let record: GitHubPullRequestRecord;
      try {
        record = await host.github.getPullRequest(
          { ...identity.github, number: identity.number },
          { refresh, signal: context.signal },
        );
      } catch (error) {
        throw gitHubFailure(error, FAILURE_CODES);
      }
      return project(record, {
        pullRequestId,
        repositoryId: pullRequestIds(
          identity.repository,
          identity.github,
          identity.number,
        ).repositoryId,
      });
    },
    'core.pullRequest.list': async (
      { integrationId, repositoryId, states, cursor, limit, query },
      context,
    ): Promise<CorePullRequestListResult> => {
      if (integrationId !== null && integrationId !== GITHUB_INTEGRATION_ID)
        throw new CanopyOperationError({
          kind: 'capability_unavailable',
          code: 'core.pullRequest.integrationUnavailable',
          message: 'The host serves pull requests through GitHub only.',
          retry: { kind: 'never' },
        });
      if (repositoryId === null)
        throw new CanopyOperationError({
          kind: 'capability_unavailable',
          code: 'core.pullRequest.list.scopeUnsupported',
          message: 'The host lists the pull requests of one repository.',
          retry: { kind: 'never' },
        });
      if (states.length === 0)
        throw invalidFilter('Select at least one pull request state.');
      const repository = parseRepositoryId(repositoryId);
      if (!repository) throw invalidId();
      const selected = CORE_PULL_REQUEST_STATES.filter((state) =>
        states.includes(state),
      );
      if (query !== undefined) {
        try {
          normalizePullRequestTitleQuery(query);
        } catch (error) {
          if (error instanceof PullRequestTitleQueryError)
            throw invalidFilter(error.message, error);
          throw error;
        }
        if (
          !host.searchPullRequests ||
          selected.length !== 1 ||
          selected[0] !== 'open' ||
          cursor !== null
        )
          throw new CanopyOperationError({
            kind: 'capability_unavailable',
            message:
              'The host supports title search of open pull requests without a cursor only.',
            retry: { kind: 'never' },
          });
        try {
          const { github, records } = await host.searchPullRequests(
            repository,
            query,
            Math.min(limit, 20),
            context.signal,
          );
          return {
            pullRequests: records.map((record) =>
              project(
                record,
                pullRequestIds(repository, github, record.number),
              ),
            ),
            nextCursor: null,
          };
        } catch (error) {
          if (error instanceof PullRequestTitleQueryError)
            throw invalidFilter(error.message, error);
          throw gitHubFailure(error, LIST_FAILURE_CODES);
        }
      }
      const github = await resolve(host, repository);
      // A continuation is GitHub's, for this repository as `origin` names it.
      const binding = JSON.stringify([
        repositoryId,
        selected,
        github.owner.toLowerCase(),
        github.repo.toLowerCase(),
      ]);
      const after =
        cursor === null ? null : continuations.read(cursor, binding);
      if (cursor !== null && (after === null || after === ''))
        throw invalidFilter(
          'The cursor was not minted by this host for these params.',
        );
      let page: Awaited<ReturnType<GitHubRequestHandle['listPullRequests']>>;
      try {
        page = await host.github.listPullRequests(
          github,
          { states: selected, first: Math.min(limit, MAX_GITHUB_PAGE), after },
          { signal: context.signal },
        );
      } catch (error) {
        throw gitHubFailure(error, LIST_FAILURE_CODES);
      }
      return {
        pullRequests: page.pullRequests.map((record) =>
          project(record, pullRequestIds(repository, github, record.number)),
        ),
        nextCursor:
          page.endCursor === null || page.endCursor === ''
            ? null
            : continuations.mint(page.endCursor, binding),
      };
    },
  };
}

function failure(
  kind: 'invalid_argument' | 'failed_precondition' | 'conflict' | 'cancelled',
  code: CorePullRequestWriteCode | null,
  message: string,
  resource?: string,
): CanopyOperationError {
  return new CanopyOperationError({
    kind,
    ...(code === null ? {} : { code }),
    message,
    retry:
      resource === undefined
        ? { kind: 'never' }
        : { kind: 'after_refresh', resource },
  });
}

type CorePullRequestWriteCode =
  | 'core.pullRequest.create.invalidBranch'
  | 'core.pullRequest.create.headMissing'
  | 'core.pullRequest.create.headMismatch'
  | 'core.pullRequest.update.invalidPatch'
  | 'core.pullRequest.update.revisionConflict'
  | 'core.pullRequest.merge.headMismatch'
  | 'core.pullRequest.merge.revisionConflict'
  | 'core.pullRequest.merge.notMergeable'
  | 'core.pullRequest.merge.mergeQueueRequired';

function integrationUnavailable(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    code: 'core.pullRequest.integrationUnavailable',
    message: 'The host serves pull requests through GitHub only.',
    retry: { kind: 'never' },
  });
}

function notSent(): CanopyOperationError {
  return failure(
    'cancelled',
    null,
    'The call was cancelled before GitHub was asked to change anything.',
  );
}

function idempotencyKeyOf(context: CanopyHandlerContext): string {
  const key = context.metadata.idempotencyKey;
  // The dispatcher refuses a keyed instruction without one first.
  if (!key)
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'An idempotency key is required.',
      retry: { kind: 'never' },
    });
  return key;
}

/**
 * Whether GitHub's head commit is the expected one: a full commit compares
 * whole, a 7 to 39 character value as a prefix; GitHub's hex is lower case.
 */
export function isExpectedHead(actual: string, expected: string): boolean {
  const head = actual.toLowerCase();
  const want = expected.toLowerCase();
  return head === want || (want.length < 40 && head.startsWith(want));
}

function isBlank(value: string): boolean {
  return value.trim() === '';
}

function isGitHubRequestError(
  error: unknown,
  code: GitHubRequestError['code'],
): error is GitHubRequestError {
  return error instanceof GitHubRequestError && error.code === code;
}

/**
 * `core.pullRequest.create` and `update` for the desktop host (CAN-4109).
 * Installing them exposes both to every caller holding
 * `core.pullRequest.write`, the main renderer's relay included (D7), so each
 * enforces its own guards: identifiers this host minted, a writable
 * workspace record whose `origin` names the GitHub repository now, the
 * expected head or revision against a fresh GitHub read, and keyed receipts.
 * A GitHub mutation never receives an abort signal: a cancel observed before
 * it is sent stops the call, one after it settles the call as usual.
 */
export function createCorePullRequestInstructionHandlers(
  host: CorePullRequestHost,
  options: CorePullRequestHandlerOptions = {},
): CorePullRequestInstructionHandlers {
  const receipts =
    options.receipts ?? createPullRequestReceipts<PullRequestWriteReceipt>();

  /**
   * The write's receipt; one this call did not write (a same-key retry, or a
   * call that joined one in flight) is answered only while the record is
   * still writable and its `origin` still names the receipt's repository.
   */
  const runKeyed = async (
    key: Parameters<typeof receipts.run>[0],
    fingerprint: string,
    repository: RecordedRepositoryRef,
    write: () => Promise<PullRequestWriteReceipt>,
  ): Promise<PullRequestWriteReceipt> => {
    let wrote = false;
    const written = await receipts.run(key, fingerprint, () => {
      wrote = true;
      return write();
    });
    if (!wrote) {
      const github = await resolve(host, repository, 'write');
      if (!sameGitHubRepository(github, written.github))
        throw repositoryUnavailable();
    }
    return written;
  };

  /** The full projection after a write; the write itself already landed. */
  const projectWritten = async (
    repository: RecordedRepositoryRef,
    written: PullRequestWriteReceipt,
    context: CanopyHandlerContext,
  ): Promise<CorePullRequest> => {
    let record: GitHubPullRequestRecord;
    try {
      record = await host.github.getPullRequest(
        { ...written.github, number: written.number },
        { refresh: true, signal: context.signal },
      );
    } catch (error) {
      throw new CanopyOperationError(
        {
          kind: 'unavailable',
          code: 'core.pullRequest.projectionUnavailable',
          message:
            'GitHub applied the change, but the pull request could not be read.',
          retry: { kind: 'same_idempotency_key' },
        },
        error instanceof CanopyOperationError ? error.runtimeCause : error,
      );
    }
    return project(
      record,
      pullRequestIds(repository, written.github, written.number),
    );
  };

  const create = async (
    params: CorePullRequestCreateParams & {
      readonly title: string;
      readonly body: string;
    },
    repository: RecordedRepositoryRef,
    context: CanopyHandlerContext,
  ): Promise<PullRequestWriteReceipt> => {
    const github = await resolve(host, repository, 'write');
    let head: Awaited<ReturnType<GitHubRequestHandle['getBranchHead']>>;
    try {
      head = await host.github.getBranchHead(github, params.headBranch, {
        signal: context.signal,
      });
    } catch (error) {
      throw keyedGitHubFailure(error, CREATE_FAILURE_CODES);
    }
    if (head === null)
      throw failure(
        'failed_precondition',
        'core.pullRequest.create.headMissing',
        'GitHub has no such head branch.',
        'github-branch',
      );
    if (!isExpectedHead(head.sha, params.expectedHeadSha))
      throw failure(
        'conflict',
        'core.pullRequest.create.headMismatch',
        'The head branch is not at the expected commit.',
        'github-branch',
      );
    if (context.signal.aborted) throw notSent();
    let located: GitHubPullRequestLocator;
    try {
      located = await host.github.createPullRequest(github, {
        headBranch: params.headBranch,
        baseBranch: params.baseBranch,
        title: params.title,
        body: params.body,
        draft: params.draft,
      });
    } catch (error) {
      if (!isGitHubRequestError(error, 'duplicate'))
        throw keyedGitHubFailure(error, CREATE_FAILURE_CODES);
      // GitHub's open-pull-request rule: adopt the head branch's pull request.
      let existing: GitHubPullRequestLocator | null;
      try {
        existing = await host.github.findOpenPullRequest(
          github,
          params.headBranch,
          {},
        );
      } catch {
        existing = null;
      }
      if (existing === null)
        throw keyedGitHubFailure(error, CREATE_FAILURE_CODES);
      located = existing;
    }
    return { github, number: located.number };
  };

  const update = async (
    params: CorePullRequestUpdateParams,
    identity: NonNullable<ReturnType<typeof parsePullRequestId>>,
    patch: GitHubPullRequestUpdateInput,
    context: CanopyHandlerContext,
  ): Promise<PullRequestWriteReceipt> => {
    const github = await resolve(host, identity.repository, 'write');
    // `origin` names another repository now: never write the same number there.
    if (!sameGitHubRepository(github, identity.github))
      throw repositoryUnavailable();
    const ref = { ...identity.github, number: identity.number };
    let current: GitHubPullRequestRecord;
    try {
      current = await host.github.getPullRequest(ref, {
        refresh: true,
        signal: context.signal,
      });
    } catch (error) {
      throw keyedGitHubFailure(error, UPDATE_FAILURE_CODES);
    }
    if (revisionOf(current) !== params.expectedRevision)
      throw failure(
        'conflict',
        'core.pullRequest.update.revisionConflict',
        'The pull request changed since the expected revision.',
        'pull-request',
      );
    if (context.signal.aborted) throw notSent();
    try {
      await host.github.updatePullRequest(ref, patch);
    } catch (error) {
      throw keyedGitHubFailure(error, UPDATE_FAILURE_CODES);
    }
    return { github: identity.github, number: identity.number };
  };

  return {
    'core.pullRequest.merge': async (params, context) => {
      const identity = parsePullRequestId(params.pullRequestId);
      if (!identity) throw invalidId();
      const verification: { record?: GitHubPullRequestRecord | null } = {};
      const written = await runKeyed(
        {
          principalId: context.caller.principalId,
          operation: 'core.pullRequest.merge',
          idempotencyKey: idempotencyKeyOf(context),
        },
        JSON.stringify([
          params.pullRequestId,
          params.expectedRevision,
          params.expectedHeadSha,
          params.strategy,
        ]),
        identity.repository,
        async () => {
          const github = await resolve(host, identity.repository, 'write');
          if (!sameGitHubRepository(github, identity.github))
            throw repositoryUnavailable();
          const ref = { ...identity.github, number: identity.number };
          let current: GitHubPullRequestRecord;
          try {
            current = await host.github.getPullRequest(ref, {
              refresh: true,
              signal: context.signal,
            });
          } catch (error) {
            throw keyedGitHubFailure(error, FAILURE_CODES);
          }
          if (
            current.headSha.toLowerCase() !==
            params.expectedHeadSha.toLowerCase()
          )
            throw failure(
              'conflict',
              'core.pullRequest.merge.headMismatch',
              'The pull request head changed.',
              'pull-request',
            );
          // A lost answer is success even if GitHub changed updatedAt at merge time.
          if (current.state === 'merged')
            return { github, number: identity.number };
          if (revisionOf(current) !== params.expectedRevision)
            throw failure(
              'conflict',
              'core.pullRequest.merge.revisionConflict',
              'The pull request changed since the expected revision.',
              'pull-request',
            );
          let policy: Awaited<
            ReturnType<GitHubRequestHandle['getMergePolicy']>
          >;
          try {
            policy = await host.github.getMergePolicy(ref, {
              signal: context.signal,
            });
          } catch (error) {
            throw keyedGitHubFailure(error, FAILURE_CODES);
          }
          if (policy.queueRequired)
            throw failure(
              'failed_precondition',
              'core.pullRequest.merge.mergeQueueRequired',
              'The base branch requires a merge queue.',
              'pull-request',
            );
          const strategy = params.strategy ?? policy.preferredStrategy;
          if (!policy.allowedStrategies.includes(strategy))
            throw new CanopyOperationError({
              kind: 'capability_unavailable',
              message: 'The repository does not allow that merge strategy.',
              retry: { kind: 'after_refresh', resource: 'pull-request' },
            });
          if (
            current.state !== 'open' ||
            current.draft ||
            current.mergeable !== 'mergeable' ||
            current.reviewDecision === 'changes_requested' ||
            current.reviewDecision === 'review_required' ||
            current.checks.some(
              (check) =>
                check.status !== 'completed' ||
                (check.conclusion !== 'success' &&
                  check.conclusion !== 'neutral' &&
                  check.conclusion !== 'skipped'),
            )
          )
            throw failure(
              'failed_precondition',
              'core.pullRequest.merge.notMergeable',
              'The pull request is not mergeable.',
              'pull-request',
            );
          // Reads above may yield while a workspace record or origin changes.
          const writable = await resolve(host, identity.repository, 'write');
          if (!sameGitHubRepository(writable, github))
            throw repositoryUnavailable();
          if (context.signal.aborted) throw notSent();
          try {
            const result = await host.github.mergePullRequest(
              ref,
              {
                expectedHeadSha: params.expectedHeadSha,
                strategy,
              },
              policy,
            );
            verification.record = result.projection;
          } catch (error) {
            if (
              isGitHubRequestError(error, 'head_mismatch') ||
              isGitHubRequestError(error, 'merge_queue_required') ||
              isGitHubRequestError(error, 'not_mergeable')
            ) {
              const code =
                error.code === 'head_mismatch'
                  ? 'core.pullRequest.merge.headMismatch'
                  : error.code === 'merge_queue_required'
                    ? 'core.pullRequest.merge.mergeQueueRequired'
                    : 'core.pullRequest.merge.notMergeable';
              throw new CanopyOperationError(
                {
                  kind:
                    error.code === 'head_mismatch'
                      ? 'conflict'
                      : 'failed_precondition',
                  code,
                  message:
                    error.code === 'head_mismatch'
                      ? 'The pull request head changed.'
                      : 'GitHub refused the direct merge.',
                  retry: { kind: 'after_refresh', resource: 'pull-request' },
                },
                error.cause,
              );
            }
            throw keyedGitHubFailure(error, FAILURE_CODES);
          }
          return { github, number: identity.number };
        },
      );
      if (verification.record === null)
        throw new CanopyOperationError({
          kind: 'unavailable',
          code: 'core.pullRequest.projectionUnavailable',
          message:
            'GitHub applied the merge, but the pull request could not be read.',
          retry: { kind: 'same_idempotency_key' },
        });
      const merged =
        verification.record === undefined
          ? await projectWritten(identity.repository, written, context)
          : project(
              verification.record,
              pullRequestIds(
                identity.repository,
                written.github,
                written.number,
              ),
            );
      if (
        merged.state !== 'merged' ||
        merged.headSha.toLowerCase() !== params.expectedHeadSha.toLowerCase()
      )
        throw new CanopyOperationError({
          kind: 'unavailable',
          code: 'core.pullRequest.projectionUnavailable',
          message:
            'GitHub applied the merge, but its merged projection is not available yet.',
          retry: { kind: 'same_idempotency_key' },
        });
      return merged;
    },
    'core.pullRequest.create': async (params, context) => {
      if (params.integrationId !== GITHUB_INTEGRATION_ID)
        throw integrationUnavailable();
      const { title } = params;
      // Only the web core generates a title and body.
      if (title === undefined)
        throw canopyCapabilityUnavailableError(
          "This core opens a pull request with the caller's title only.",
        );
      const repository = parseRepositoryId(params.repositoryId);
      if (!repository) throw invalidId();
      if (isBlank(params.headBranch) || isBlank(params.baseBranch))
        throw failure(
          'invalid_argument',
          'core.pullRequest.create.invalidBranch',
          'Name a head and a base branch.',
        );
      const written = await runKeyed(
        {
          principalId: context.caller.principalId,
          operation: 'core.pullRequest.create',
          idempotencyKey: idempotencyKeyOf(context),
        },
        JSON.stringify([
          params.integrationId,
          params.repositoryId,
          params.title,
          params.body,
          params.baseBranch,
          params.headBranch,
          params.expectedHeadSha,
          params.draft,
        ]),
        repository,
        () =>
          create(
            { ...params, title, body: params.body ?? '' },
            repository,
            context,
          ),
      );
      return projectWritten(repository, written, context);
    },
    'core.pullRequest.update': async (params, context) => {
      const identity = parsePullRequestId(params.pullRequestId);
      if (!identity) throw invalidId();
      const { title, body, baseBranch, draft } = params.patch;
      if (
        (title === null &&
          body === null &&
          baseBranch === null &&
          draft === null) ||
        (title !== null && isBlank(title)) ||
        (baseBranch !== null &&
          (isBlank(baseBranch) || baseBranch.trim() === 'HEAD'))
      )
        throw failure(
          'invalid_argument',
          'core.pullRequest.update.invalidPatch',
          'The patch changes nothing, or names a blank title or an invalid base branch.',
        );
      // Recorded desktop debt: GitHub changes draft status only through
      // separate GraphQL mutations the host does not make.
      if (draft !== null)
        throw new CanopyOperationError({
          kind: 'capability_unavailable',
          code: 'core.pullRequest.update.draftUnsupported',
          message: 'This host cannot change draft status.',
          retry: { kind: 'never' },
        });
      const patch: GitHubPullRequestUpdateInput = {
        ...(title === null ? {} : { title }),
        ...(body === null ? {} : { body }),
        ...(baseBranch === null ? {} : { baseBranch }),
      };
      const written = await runKeyed(
        {
          principalId: context.caller.principalId,
          operation: 'core.pullRequest.update',
          idempotencyKey: idempotencyKeyOf(context),
        },
        JSON.stringify([
          params.pullRequestId,
          params.expectedRevision,
          title,
          body,
          baseBranch,
          draft,
        ]),
        identity.repository,
        () => update(params, identity, patch, context),
      );
      return projectWritten(identity.repository, written, context);
    },
  };
}
