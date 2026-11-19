import type { Octokit } from '@octokit/rest';
import {
  GITHUB_TITLE_MAX_CODE_POINTS,
  gitHubPreviewTargetKey,
  isGitHubAvatarUrl,
  isGitHubRepositoryName,
  parseGitHubPullPreviewFacts,
  type GitHubItemPreview,
  type GitHubItemState,
  type GitHubOriginRepository,
  type GitHubPreviewResult,
  type GitHubPreviewScope,
  type GitHubPreviewTarget,
  type GitHubPullPreviewFacts,
  type GitHubReferenceOrigin,
  type GitHubRepositoryPreview,
} from '@canopy/protocol/reference-previews';
import {
  getGitHubBrokerCredentialPort,
  type GitHubBrokerCredentialLease,
} from './github-broker/credential-port';
import {
  getGitHubBroker,
  isGitHubBrokerError,
  type GitHubRawResponse,
} from './github-broker';
import { githubErrorHeaders, githubErrorStatus } from './github-broker/errors';
import {
  normalizeGitHubHeaders,
  retryAfterMs as parseRetryAfterMs,
} from './github-broker/rate-limit';
import {
  getGitHubPullRequestStatus,
  type GitHubPullRequestStatusView,
} from './github-pr-read-model';
import { resolveUnambiguousGitHubRepository } from './github-repository-context';
import { validateWorktreeChatScope } from './validation';
import { isCoworkWorkspace } from './workspace-registry';
import {
  getCloudAccountIdentityGeneration,
  readGitHubPreviewAccountIdentity,
} from './github-preview-credential';

const READ_TIMEOUT_MS = 15_000;
const REVOKED_WINDOW_MS = 5 * 60 * 1000;
const MAX_DESCRIPTION_SOURCE = 4_000;
const MAX_DESCRIPTION_EXCERPT = 280;
const MAX_FIELD = 200;
const MAX_URL_LENGTH = 2_048;
const MAX_TIMESTAMP_LENGTH = 64;

export interface GitHubItemRequest {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

export interface GitHubRepositoryRequest {
  readonly owner: string;
  readonly repository: string;
}

export interface GitHubPullState {
  readonly merged: boolean;
  readonly draft: boolean;
}

export interface GitHubReferencePreviewDeps {
  /** A lease on the resolved GitHub credential; null when there is none. */
  resolveCredential: () => Promise<GitHubBrokerCredentialLease | null>;
  /** The lease's preview scope for this account; never contains the credential. */
  credentialScope: (
    credential: GitHubBrokerCredentialLease,
    accountId: string,
  ) => Promise<string>;
  resolveAccountId: () => Promise<string>;
  /** `GET /repos/{owner}/{repo}/issues/{number}`: issues and pull requests. */
  requestItem: (
    credential: GitHubBrokerCredentialLease,
    item: GitHubItemRequest,
  ) => Promise<unknown>;
  /** The shared pull request read model, only when the issue omits PR state. */
  readPullState: (item: GitHubItemRequest) => Promise<GitHubPullState | null>;
  requestRepository: (
    credential: GitHubBrokerCredentialLease,
    repository: GitHubRepositoryRequest,
  ) => Promise<unknown>;
  /** The worktree's single GitHub `owner/repo`; `null` or a throw means none. */
  resolveOriginRepository: (origin: {
    projectId: string;
    worktreeId: string;
  }) => Promise<string | null>;
  isCoworkProject: (projectId: string) => boolean;
  readTrackedPull?: (
    target: GitHubItemRequest,
    scope: string,
  ) => Promise<TrackedPullFacts | null>;
  /**
   * A pull request's size and readiness for its card; best effort, so a
   * rejection or `null` leaves them off.
   */
  readPullFacts?: (
    credential: GitHubBrokerCredentialLease,
    item: GitHubItemRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
  now: () => number;
}

export interface TrackedPullFacts {
  readonly scope: string;
  readonly capturedAt: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly state: 'open' | 'closed' | 'merged' | 'draft';
  readonly author: string | null;
  readonly updatedAt: string;
}

// The pinned lease goes to the broker so the read uses the credential that
// produced the result's scope, while the broker keeps its scheduling,
// rate-limit pauses, and safe-read retries.
async function brokerRead(
  credential: GitHubBrokerCredentialLease,
  request: (octokit: Octokit) => Promise<GitHubRawResponse<unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await getGitHubBroker().execute<unknown>(request, {
    priority: 'interactive',
    operation: 'read',
    idempotency: 'safe',
    timeoutMs: READ_TIMEOUT_MS,
    credential,
    caller: 'reference-preview',
    ...(signal ? { signal } : {}),
  });
  return result.data;
}

/** How long a preview waits for its pull request facts before going without. */
export const PULL_FACTS_TIMEOUT_MS = 1_500;

const CHECKS_STATE = {
  success: 'passing',
  failure: 'failing',
  pending: 'pending',
  none: 'none',
} as const satisfies Record<
  GitHubPullRequestStatusView['checks']['state'],
  GitHubPullPreviewFacts['checks']
>;

const defaultDeps: GitHubReferencePreviewDeps = {
  resolveCredential: async () =>
    (await getGitHubBrokerCredentialPort().lease('resolved'))?.lease ?? null,
  credentialScope: (credential, accountId) =>
    getGitHubBrokerCredentialPort().derivedScope(credential, {
      kind: 'reference-preview',
      accountIdentity: accountId,
    }),
  resolveAccountId: readGitHubPreviewAccountIdentity,
  requestItem: (credential, item) =>
    brokerRead(credential, (octokit) =>
      octokit.rest.issues.get({
        owner: item.owner,
        repo: item.repository,
        issue_number: item.number,
      }),
    ),
  readPullState: async (item) => {
    const view = await getGitHubPullRequestStatus(
      { owner: item.owner, repo: item.repository, number: item.number },
      { priority: 'interactive', caller: 'reference-preview' },
    );
    return { merged: view.state === 'merged', draft: view.isDraft };
  },
  readPullFacts: async (credential, item, options) => {
    const signal = options?.signal;
    const [pull, status] = await Promise.all([
      brokerRead(
        credential,
        (octokit) =>
          octokit.rest.pulls.get({
            owner: item.owner,
            repo: item.repository,
            pull_number: item.number,
          }),
        signal,
      ),
      getGitHubPullRequestStatus(
        { owner: item.owner, repo: item.repository, number: item.number },
        {
          priority: 'interactive',
          caller: 'reference-preview',
          ...(signal ? { signal } : {}),
        },
      ),
    ]);
    if (!isRecord(pull)) return null;
    return {
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changed_files,
      mergeable: status.mergeable,
      checks: status.checks.available
        ? CHECKS_STATE[status.checks.state]
        : 'none',
      reviewDecision:
        status.reviewDecision === 'review_required'
          ? null
          : status.reviewDecision,
      inMergeQueue: status.mergeQueue.inQueue,
    };
  },
  requestRepository: (credential, repository) =>
    brokerRead(credential, (octokit) =>
      octokit.rest.repos.get({
        owner: repository.owner,
        repo: repository.repository,
      }),
    ),
  resolveOriginRepository: (origin) =>
    resolveUnambiguousGitHubRepository({
      projectId: origin.projectId,
      worktreeId: origin.worktreeId,
    }),
  isCoworkProject: isCoworkWorkspace,
  readTrackedPull: async (target, scope) => {
    // Defer the poller/owner cycle until a PR reference needs the projection;
    // both imports are bundled into the packaged main build.
    const [{ findTrackedPrSnapshot }, { getTrackedPrSnapshotLocations }] =
      await Promise.all([
        import('./github-pr-hook-state'),
        import('./github-poller'),
      ]);
    const snapshot = await findTrackedPrSnapshot(
      target,
      scope,
      getTrackedPrSnapshotLocations(),
    );
    return snapshot
      ? {
          scope,
          capturedAt: Date.parse(snapshot.capturedAt),
          title: snapshot.pr.title,
          body: snapshot.pr.body,
          url: snapshot.pr.htmlUrl,
          state: snapshot.pr.state,
          author: snapshot.pr.author?.login ?? null,
          updatedAt: snapshot.pr.updatedAt,
        }
      : null;
  },
  now: () => Date.now(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collapses whitespace and bounds by code point; a cut ends with `…`. */
function boundedText(value: unknown, max = MAX_FIELD): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const codePoints = Array.from(text);
  return codePoints.length > max
    ? `${codePoints
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

/** Markdown to a short plain-text excerpt; never rendered as HTML. */
function plainText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  return boundedText(
    value
      .slice(0, MAX_DESCRIPTION_SOURCE)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[`*_~#>|]/g, ''),
    max,
  );
}

function descriptionExcerpt(value: unknown): string | null {
  return plainText(value, MAX_DESCRIPTION_EXCERPT);
}

function trackedPullPreview(
  facts: TrackedPullFacts,
  target: GitHubItemRequest,
): GitHubItemPreview | null {
  if (
    typeof facts.title !== 'string' ||
    typeof facts.body !== 'string' ||
    (facts.author !== null && typeof facts.author !== 'string')
  )
    return null;
  const url = gitHubUrl(facts.url);
  if (!url) return null;
  const parsed = new URL(url);
  if (
    parsed.pathname.toLowerCase() !==
      `/${target.owner}/${target.repository}/pull/${target.number}` ||
    parsed.search ||
    parsed.hash
  )
    return null;
  const title = boundedText(facts.title, GITHUB_TITLE_MAX_CODE_POINTS);
  const updatedAt = timestamp(facts.updatedAt);
  if (
    !title ||
    !updatedAt ||
    (facts.state !== 'open' &&
      facts.state !== 'closed' &&
      facts.state !== 'merged' &&
      facts.state !== 'draft')
  )
    return null;
  return {
    kind: 'item',
    owner: target.owner,
    repository: target.repository,
    number: target.number,
    itemType: 'pull',
    title,
    url,
    description: descriptionExcerpt(facts.body),
    state:
      facts.state === 'merged'
        ? 'merged'
        : facts.state === 'draft'
          ? 'open'
          : facts.state,
    draft: facts.state === 'draft',
    author: boundedText(facts.author),
    updatedAt,
  };
}

/** GitHub's returned page URL, or `null` unless it is a plain github.com https URL. */
function gitHubUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > MAX_URL_LENGTH ||
    !value.startsWith('https://github.com/')
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
      ? value
      : null;
  } catch {
    return null;
  }
}

/** A provider timestamp, or `null` unless it is a parseable date. */
function timestamp(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TIMESTAMP_LENGTH &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/** Draft and merge state when the payload carries both, else `null`. */
function pullStateOf(
  draft: unknown,
  mergedAt: unknown,
): GitHubPullState | null {
  if (typeof draft !== 'boolean') return null;
  if (mergedAt !== null && typeof mergedAt !== 'string') return null;
  return { merged: mergedAt !== null, draft };
}

function toItemPreview(
  data: Record<string, unknown>,
  item: GitHubItemRequest,
  pull: GitHubPullState | null,
): GitHubItemPreview | null {
  const title = boundedText(data.title, GITHUB_TITLE_MAX_CODE_POINTS);
  const url = gitHubUrl(data.html_url);
  const updatedAt = timestamp(data.updated_at);
  const rawState = data.state;
  if (
    !title ||
    !url ||
    !updatedAt ||
    (rawState !== 'open' && rawState !== 'closed')
  ) {
    return null;
  }
  const state: GitHubItemState = pull?.merged ? 'merged' : rawState;
  return {
    kind: 'item',
    owner: item.owner,
    repository: item.repository,
    number: item.number,
    itemType: pull ? 'pull' : 'issue',
    title,
    url,
    description: descriptionExcerpt(data.body),
    state,
    draft: pull?.draft ?? false,
    author: isRecord(data.user) ? boundedText(data.user.login) : null,
    authorAvatarUrl:
      isRecord(data.user) && isGitHubAvatarUrl(data.user.avatar_url)
        ? data.user.avatar_url
        : null,
    updatedAt,
  };
}

function toRepositoryPreview(
  data: unknown,
  repository: GitHubRepositoryRequest,
): GitHubRepositoryPreview | null {
  if (!isRecord(data)) return null;
  const fullName = boundedText(data.full_name);
  const url = gitHubUrl(data.html_url);
  const updatedAt = timestamp(data.updated_at);
  if (
    !fullName ||
    !url ||
    !updatedAt ||
    typeof data.private !== 'boolean' ||
    typeof data.archived !== 'boolean'
  ) {
    return null;
  }
  return {
    kind: 'repository',
    owner: repository.owner,
    repository: repository.repository,
    fullName,
    url,
    description: boundedText(data.description, MAX_DESCRIPTION_EXCERPT),
    private: data.private,
    archived: data.archived,
    updatedAt,
  };
}

/** The provider's retry hint in ms, or `null` when it gave none. */
function rateLimitRetryAfterMs(error: unknown, now: number): number | null {
  const cause: unknown = isGitHubBrokerError(error) ? error.cause : error;
  const headers = normalizeGitHubHeaders(githubErrorHeaders(cause));
  const retryAfter = parseRetryAfterMs(headers['retry-after'], now);
  if (retryAfter !== undefined) return retryAfter;
  const reset = Number(headers['x-ratelimit-reset']);
  if (
    headers['x-ratelimit-remaining'] === '0' &&
    headers['x-ratelimit-reset'] !== undefined &&
    Number.isFinite(reset)
  ) {
    return Math.max(0, reset * 1_000 - now);
  }
  // A request the broker held back never reached GitHub, so only the broker
  // knows when it will send it again.
  return isGitHubBrokerError(error) && error.retryAt !== undefined
    ? Math.max(0, error.retryAt - now)
    : null;
}

type FailureResult = Exclude<GitHubPreviewResult, { status: 'ok' }>;

function failureResult(
  error: unknown,
  scope: string,
  now: number,
): FailureResult {
  if (!isGitHubBrokerError(error)) {
    // The broker passes some statuses through unwrapped: 410 is a deleted
    // issue or disabled issue tracker, 451 a legal takedown.
    const status = githubErrorStatus(error);
    return status === 410 || status === 451
      ? { status: 'unavailable', scope }
      : { status: 'failed' };
  }
  switch (error.code) {
    case 'not_authenticated':
      return { status: 'disconnected' };
    case 'not_found':
    case 'permission_denied':
      return { status: 'unavailable', scope };
    case 'rate_limited':
      return {
        status: 'rate-limited',
        retryAfterMs: rateLimitRetryAfterMs(error, now),
      };
    default:
      return { status: 'failed' };
  }
}

export function createGitHubReferencePreviewReader(
  deps: GitHubReferencePreviewDeps = defaultDeps,
): {
  readScope: () => Promise<GitHubPreviewScope>;
  readOrigin: (
    origin: GitHubReferenceOrigin,
  ) => Promise<GitHubOriginRepository>;
  read: (target: GitHubPreviewTarget) => Promise<GitHubPreviewResult>;
} {
  // A credential GitHub rejected reads as disconnected for five minutes, so no
  // window keeps calling GitHub with it until the credential changes or time
  // passes.
  const revokedUntil = new Map<string, number>();

  // The credential's identity, and how long it stays rejected (0 when usable).
  const currentCredential = async (): Promise<{
    credential: GitHubBrokerCredentialLease;
    scope: string;
    revokedForMs: number;
  } | null> => {
    const credential = await deps.resolveCredential().catch(() => null);
    if (!credential) return null;
    const accountId = await deps.resolveAccountId();
    const scope = await deps
      .credentialScope(credential, accountId)
      .catch(() => null);
    if (scope === null) return null;
    const until = revokedUntil.get(scope);
    if (until !== undefined && deps.now() >= until) revokedUntil.delete(scope);
    const revokedForMs =
      until !== undefined && deps.now() < until ? until - deps.now() : 0;
    return { credential, scope, revokedForMs };
  };

  const resolveScope = async (): Promise<{
    credential: GitHubBrokerCredentialLease;
    scope: string;
  } | null> => {
    const current = await currentCredential();
    return current && current.revokedForMs === 0
      ? { credential: current.credential, scope: current.scope }
      : null;
  };

  // Size and readiness ride along on a pull request's card; a failed,
  // malformed or slow read keeps the card without them. The reads are capped
  // and cancelled once settled, so a held read (a rate-limit pause) never
  // keeps the preview loading or runs on after it.
  const withPullFacts = async (
    credential: GitHubBrokerCredentialLease,
    preview: GitHubItemPreview,
  ): Promise<GitHubItemPreview> => {
    const readPullFacts = deps.readPullFacts;
    if (preview.itemType !== 'pull' || !readPullFacts) return preview;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, PULL_FACTS_TIMEOUT_MS);
    });
    const read = readPullFacts(
      credential,
      {
        owner: preview.owner,
        repository: preview.repository,
        number: preview.number,
      },
      { signal: controller.signal },
    ).catch(() => null);
    try {
      const facts = parseGitHubPullPreviewFacts(
        await Promise.race([read, timedOut]),
      );
      return facts ? { ...preview, pull: facts } : preview;
    } finally {
      clearTimeout(timer);
      // Settled either way: cancel whichever read is still going, such as
      // the other half of a pair that failed early.
      controller.abort();
    }
  };

  const fetchPreview = async (
    credential: GitHubBrokerCredentialLease,
    target: GitHubPreviewTarget,
  ): Promise<GitHubItemPreview | GitHubRepositoryPreview | null> => {
    if (target.kind === 'repository') {
      return toRepositoryPreview(
        await deps.requestRepository(credential, {
          owner: target.owner,
          repository: target.repository,
        }),
        target,
      );
    }
    const item: GitHubItemRequest = {
      owner: target.owner,
      repository: target.repository,
      number: target.number,
    };
    const data = await deps.requestItem(credential, item);
    if (!isRecord(data)) return null;
    // GitHub numbers issues and pull requests together; a PR carries `pull_request`.
    if (!isRecord(data.pull_request)) return toItemPreview(data, item, null);
    const pull =
      pullStateOf(data.draft, data.pull_request.merged_at) ??
      (await deps.readPullState(item));
    return pull ? toItemPreview(data, item, pull) : null;
  };

  // Shared by every window: identical concurrent reads make one request. The
  // key carries the scope, so a read pinned to one credential never answers
  // a caller that resolved another.
  const reads = new Map<string, Promise<GitHubPreviewResult>>();

  return {
    // Local only. A rejected credential reports when the host will try it
    // again, so every window can check back then.
    readScope: async (): Promise<GitHubPreviewScope> => {
      const current = await currentCredential();
      if (!current) return { scope: null };
      return current.revokedForMs > 0
        ? { scope: null, retryAfterMs: current.revokedForMs }
        : { scope: current.scope };
    },
    readOrigin: async (origin): Promise<GitHubOriginRepository> => {
      if (origin.kind !== 'worktree') return { repository: null };
      try {
        // Reject unsafe ids before the host builds a path.
        validateWorktreeChatScope(origin.projectId, origin.worktreeId);
      } catch {
        return { repository: null };
      }
      if (deps.isCoworkProject(origin.projectId)) return { repository: null };
      // Operational failures reject so restored origins keep their original deadline.
      const found = await deps.resolveOriginRepository({
        projectId: origin.projectId,
        worktreeId: origin.worktreeId,
      });
      if (found === null) return { repository: null };
      const parts = found.split('/');
      if (parts.length !== 2) return { repository: null };
      const [owner, repository] = parts;
      return isGitHubRepositoryName(owner, repository)
        ? { repository: { owner, repository } }
        : { repository: null };
    },
    read: async (target): Promise<GitHubPreviewResult> => {
      let identity: Awaited<ReturnType<typeof resolveScope>>;
      try {
        identity = await resolveScope();
      } catch {
        return { status: 'failed' };
      }
      if (!identity) return { status: 'disconnected' };
      const brokerGeneration = getGitHubBroker().getCredentialGeneration();
      const cloudGeneration = getCloudAccountIdentityGeneration();
      const key = `${brokerGeneration}\0${cloudGeneration}\0${identity.scope}\0${gitHubPreviewTargetKey(target)}`;
      const existing = reads.get(key);
      if (existing) return existing;
      const read = (async (): Promise<GitHubPreviewResult> => {
        try {
          if (target.kind === 'item' && deps.readTrackedPull) {
            const facts = await deps
              .readTrackedPull(target, identity.scope)
              .catch(() => null);
            const capturedAt = facts?.capturedAt ?? NaN;
            if (
              facts?.scope === identity.scope &&
              Number.isFinite(capturedAt) &&
              capturedAt <= deps.now() &&
              deps.now() - capturedAt <= 5 * 60 * 1000
            ) {
              const preview = trackedPullPreview(facts, target);
              if (preview) {
                return {
                  status: 'ok',
                  scope: identity.scope,
                  preview: await withPullFacts(identity.credential, preview),
                  fetchedAt: capturedAt,
                };
              }
            }
          }
          const fetched = await fetchPreview(identity.credential, target);
          const preview =
            fetched?.kind === 'item'
              ? await withPullFacts(identity.credential, fetched)
              : fetched;
          return preview
            ? { status: 'ok', scope: identity.scope, preview }
            : { status: 'unavailable', scope: identity.scope };
        } catch (error: unknown) {
          const result = failureResult(error, identity.scope, deps.now());
          if (result.status === 'disconnected') {
            revokedUntil.set(identity.scope, deps.now() + REVOKED_WINDOW_MS);
          }
          return result;
        }
      })()
        .then(async (result): Promise<GitHubPreviewResult> => {
          if (
            brokerGeneration !== getGitHubBroker().getCredentialGeneration() ||
            cloudGeneration !== getCloudAccountIdentityGeneration()
          )
            return { status: 'disconnected' };
          let current: Awaited<ReturnType<typeof resolveScope>>;
          try {
            current = await resolveScope();
          } catch {
            return { status: 'failed' };
          }
          if (
            current?.scope !== identity.scope ||
            brokerGeneration !== getGitHubBroker().getCredentialGeneration() ||
            cloudGeneration !== getCloudAccountIdentityGeneration()
          )
            return { status: 'disconnected' };
          return result;
        })
        .finally(() => reads.delete(key));
      reads.set(key, read);
      return read;
    },
  };
}
