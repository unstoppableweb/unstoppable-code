import { classifyError } from '@canopy/protocol/app-errors/classification';
import { validRetryAt } from '@canopy/protocol/app-errors/classification';
import type { GitHubHeaders } from './rate-limit';

export type GitHubBrokerErrorCode =
  | 'not_authenticated'
  | 'permission_denied'
  | 'not_found'
  | 'timeout'
  | 'cancelled'
  | 'shutdown'
  | 'network'
  | 'server_error'
  | 'rate_limited'
  | 'credential_reset'
  | 'invalid_response';

export class GitHubBrokerError extends Error {
  readonly code: GitHubBrokerErrorCode;
  readonly retriable: boolean;
  readonly status?: number;
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;
  /** For `rate_limited`: when the broker will send this request again (epoch ms). */
  readonly retryAt?: number;
  /** For `rate_limited`: the quota bucket that is paused or reserved. */
  readonly resource?: string;

  constructor(
    code: GitHubBrokerErrorCode,
    message: string,
    options: {
      retriable?: boolean;
      status?: number;
      cause?: unknown;
      retryAt?: number;
      resource?: string;
    } = {},
  ) {
    super(message);
    this.name = 'GitHubBrokerError';
    this.code = code;
    if (code === 'not_authenticated')
      classifyError(this, 'external.sign_in_required');
    if (code === 'network') classifyError(this, 'external.offline');
    if (code === 'server_error' || code === 'timeout')
      classifyError(this, 'external.service_unavailable');
    if (code === 'rate_limited')
      classifyError(this, 'external.rate_limited', {
        retryAt: validRetryAt(options.retryAt),
      });
    this.retriable = options.retriable ?? false;
    this.status = options.status;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options.retryAt !== undefined && Number.isFinite(options.retryAt)) {
      this.retryAt = options.retryAt;
    }
    if (options.resource !== undefined) {
      this.resource = options.resource;
    }
  }
}

export class GitHubBrokerTimeoutError extends GitHubBrokerError {
  constructor(message = 'GitHub request timed out.') {
    super('timeout', message, { retriable: true });
    this.name = 'GitHubBrokerTimeoutError';
  }
}

/**
 * The reason an attempt's signal is aborted once the attempt has settled, so
 * a call it left running can no longer be authorized or sent.
 */
export class GitHubBrokerAttemptSettledError extends GitHubBrokerError {
  constructor() {
    super('cancelled', 'The GitHub request attempt has already settled.');
    this.name = 'GitHubBrokerAttemptSettledError';
  }
}

/**
 * A pinned credential lease used past its lifetime. It is refused as
 * `not_authenticated` and never retried on the same lease: the holder mints
 * a fresh lease.
 */
export class GitHubBrokerLeaseExpiredError extends GitHubBrokerError {
  readonly reason = 'lease_expired';

  constructor() {
    super('not_authenticated', 'The GitHub credential lease has expired.');
    this.name = 'GitHubBrokerLeaseExpiredError';
  }
}

export class GitHubBrokerCredentialResetError extends GitHubBrokerError {
  readonly reason: 'credential_reset' | 'authentication_refresh';

  constructor(reason: 'credential_reset' | 'authentication_refresh') {
    super(
      'credential_reset',
      'GitHub credentials changed during the request.',
      {
        retriable: true,
      },
    );
    this.name = 'GitHubBrokerCredentialResetError';
    this.reason = reason;
  }
}

export function isGitHubBrokerError(
  error: unknown,
): error is GitHubBrokerError {
  return error instanceof GitHubBrokerError;
}

function githubErrorResponse(error: unknown): unknown {
  if (!error || typeof error !== 'object' || !('response' in error)) {
    return undefined;
  }
  return error.response;
}

function objectStatus(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('status' in value)) {
    return undefined;
  }
  return value.status;
}

function objectHeaders(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('headers' in value)) {
    return undefined;
  }
  return value.headers;
}

function objectData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('data' in value)) {
    return undefined;
  }
  return value.data;
}

function objectMessage(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('message' in value)) {
    return undefined;
  }
  return value.message;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function githubErrorStatus(error: unknown): number | undefined {
  const status = objectStatus(error);
  if (typeof status === 'number') return status;
  const responseStatus = objectStatus(githubErrorResponse(error));
  return typeof responseStatus === 'number' ? responseStatus : undefined;
}

/**
 * `octokit.graphql` rejects a document whose body carries GraphQL `errors`
 * with those errors and the HTTP headers on the error itself.
 */
export function isGitHubGraphQlRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('errors' in error)) {
    return false;
  }
  const errors: unknown = error.errors;
  return (
    Array.isArray(errors) &&
    errors.some(
      (entry: unknown) =>
        isUnknownRecord(entry) && entry.type === 'RATE_LIMITED',
    )
  );
}

export function githubErrorHeaders(
  error: unknown,
): Record<string, string | number | string[] | undefined> {
  const responseHeaders = objectHeaders(githubErrorResponse(error));
  const headers = isUnknownRecord(responseHeaders)
    ? responseHeaders
    : objectHeaders(error);
  if (!isUnknownRecord(headers)) {
    return {};
  }
  const normalized: Record<string, string | number | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    ) {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function githubErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const responseData = objectData(githubErrorResponse(error));
  const responseMessage = objectMessage(responseData);
  if (typeof responseMessage === 'string') {
    return responseMessage;
  }
  return 'GitHub API request failed.';
}

/**
 * GraphQL rate limits arrive as HTTP 200. Carry them as a 429 with GitHub's
 * headers and the `RATE_LIMITED` marker so the broker pauses only the
 * `graphql` bucket.
 */
export class GitHubGraphQlRateLimitError extends Error {
  readonly status = 429;
  readonly errors = [{ type: 'RATE_LIMITED' }];
  readonly response: { status: number; headers: GitHubHeaders | undefined };

  constructor(headers: GitHubHeaders | undefined) {
    super('GitHub GraphQL rate limit exceeded.');
    this.name = 'GitHubGraphQlRateLimitError';
    this.response = { status: 429, headers };
  }
}
