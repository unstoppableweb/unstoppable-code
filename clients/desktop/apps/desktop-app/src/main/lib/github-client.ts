import type { Octokit } from '@octokit/rest';
import {
  getGitHubBroker,
  type GitHubBrokerRequestOptions,
  type GitHubRawResponse,
} from './github-broker';
import type { GitHubHeaders } from './github-broker/rate-limit';
import type { GitHubBrokerCredentialLease } from './github-broker/credential-port';

type RateLimitCallback = (message: string, retryAfterSeconds: number) => void;

export interface GitHubClientEnqueueOptions<T = unknown> {
  operation?: GitHubBrokerRequestOptions['operation'];
  idempotency?: GitHubBrokerRequestOptions['idempotency'];
  timeoutMs?: number;
  signal?: AbortSignal;
  resourceKey?: string;
  conditional?: boolean;
  /**
   * Recognizes a cached result of `fn`. A safe conditional read with a
   * `resourceKey` and this guard sends the cached ETag as `If-None-Match`, and
   * a `304` resolves with the cached result.
   */
  isCachedData?: (value: unknown) => value is T;
  /** Pin this request to a credential lease from the credential port. */
  credential?: GitHubBrokerCredentialLease;
  /** Quota bucket: `core` (default) for REST, `graphql` for `octokit.graphql`. */
  resource?: GitHubBrokerRequestOptions['resource'];
  /** Spend-summary label for the broker. */
  caller?: string;
}

export interface GitHubClient {
  /**
   * `conditionalHeaders` carries the broker's `If-None-Match` for a
   * conditional read; pass it as the request's `headers`.
   */
  enqueue<T>(
    fn: (
      octokit: Octokit,
      conditionalHeaders: Record<string, string>,
    ) => Promise<T>,
    priority?: 'high' | 'normal',
    options?: GitHubClientEnqueueOptions<T>,
  ): Promise<T>;
}

function responseMetadata(value: unknown): {
  status: number;
  headers?: GitHubHeaders;
} {
  if (!value || typeof value !== 'object') return { status: 200 };
  const status = 'status' in value ? value.status : undefined;
  const headers = 'headers' in value ? value.headers : undefined;
  return {
    status: typeof status === 'number' ? status : 200,
    ...(isGitHubHeaders(headers) ? { headers } : {}),
  };
}

function isGitHubHeaders(value: unknown): value is GitHubHeaders {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) =>
        entry === undefined ||
        typeof entry === 'string' ||
        typeof entry === 'number' ||
        (Array.isArray(entry) &&
          entry.every((item) => typeof item === 'string')),
    )
  );
}

/** Clear the broker's credential generation and all credential-scoped caches. */
export function resetGitHubClient(): void {
  getGitHubBroker().resetCredentials();
}

/**
 * Compatibility facade for existing Octokit consumers.
 *
 * All scheduling, authentication, retry, rate-limit, timeout, and shutdown
 * behavior is owned by the singleton broker. Conditional reads cache what `fn`
 * returns, so return the Octokit response (or a trimmed `{ status, headers,
 * data }`) and keep the guard in step with that shape.
 */
export function getGitHubClient(
  rateLimitCallback?: RateLimitCallback,
): GitHubClient {
  const broker = getGitHubBroker();
  if (rateLimitCallback) {
    broker.subscribeRateLimits((state) => {
      rateLimitCallback(
        state.kind === 'primary'
          ? `GitHub API rate limit reached. Requests will resume at ${state.retryAt}.`
          : `GitHub is temporarily throttling API requests. Retrying in ${state.retryAfterSeconds}s.`,
        state.retryAfterSeconds,
      );
    });
  }

  return {
    async enqueue<T>(
      fn: (
        octokit: Octokit,
        conditionalHeaders: Record<string, string>,
      ) => Promise<T>,
      priority: 'high' | 'normal' = 'normal',
      options: GitHubClientEnqueueOptions<T> = {},
    ): Promise<T> {
      const operation = options.operation ?? 'read';
      const result = await broker.execute<T>(
        async (octokit, conditionalHeaders): Promise<GitHubRawResponse<T>> => {
          const value = await fn(octokit, conditionalHeaders);
          const metadata = responseMetadata(value);
          return { ...metadata, data: value };
        },
        {
          priority: priority === 'high' ? 'interactive' : 'background',
          operation,
          idempotency: options.idempotency ?? 'safe',
          timeoutMs: options.timeoutMs ?? 30_000,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.resourceKey ? { resourceKey: options.resourceKey } : {}),
          ...(options.conditional !== undefined
            ? { conditional: options.conditional }
            : {}),
          ...(options.isCachedData
            ? { isCachedData: options.isCachedData }
            : {}),
          ...(options.credential ? { credential: options.credential } : {}),
          ...(options.resource ? { resource: options.resource } : {}),
          ...(options.caller ? { caller: options.caller } : {}),
        },
      );
      return result.data;
    },
  };
}
