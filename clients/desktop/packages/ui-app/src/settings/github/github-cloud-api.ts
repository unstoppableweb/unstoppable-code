// ---------------------------------------------------------------------------
// Browser client for the "GitHub for cloud" routes (REG-3020).
//
// The connection calls go through the host's settings client (the fixed
// `account.github.connection.*` table entries: session included, the split
// deployment prefix applied, the body validated with the browser-safe runtime
// guards). A failure rejects with `GitHubCloudApiError`, whose `code` is set
// only for an allowlisted service code at its contract status (the settings
// error's `serverCode` and `status`). Nothing a response says is ever user
// copy: `gitHubCloudErrorMessage` maps the code (or the failure kind) to fixed
// local copy, so an arbitrary body carrying a string `code` or `error` is
// never displayed. An aborted call rejects with the abort itself, untouched,
// so callers can tell cancellation apart.
//
// The repository listing and creation capability routes (REG-3021) answer
// failures with the cloud envelope `{ error: { code, message, details? } }`
// instead, and say when to retry in `Retry-After`; the settings table carries
// neither, so they go through the GitHub host's repository transport. They
// reject with `GitHubCloudRepositoryApiError`, which trusts a repository or
// GitHub code only at its contract status, keeps only the allowlisted
// details, and maps to fixed copy through `gitHubCloudRepositoryErrorMessage`.
// A host without a repository transport answers `unavailable`.
// ---------------------------------------------------------------------------

import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import {
  isGitHubCloudConnectionDto,
  isGitHubCloudConnectResponse,
  isGitHubRepositoryCreationCapabilityDto,
  type GitHubCloudConnectIntent,
  type GitHubCloudConnectResponse,
  type GitHubCloudConnectionDto,
  type GitHubRepositoryCreationCapabilityDto,
} from '@canopy/protocol/settings/account-github';
import type {
  CloudRepositoryErrorDetails,
  CloudRepositoryFailureCode,
} from '@canopy/protocol/settings/cloud-repository-contracts';
import {
  cloudRepositoryFailureCopy,
  readCloudRepositoryErrorBody,
} from '@canopy/protocol/settings/cloud-repository-errors';
import { readRetryAfterSeconds } from '@canopy/protocol/settings/cloud-retry-after';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import {
  GITHUB_CLOUD_ERROR_COPY,
  GITHUB_CLOUD_ERROR_STATUS,
  readGitHubCloudErrorCode,
  type GitHubCloudErrorCode,
} from '@canopy/protocol/settings/github-cloud-errors';
import {
  isGitHubCloudRepositoryPageDto,
  type GitHubCloudRepositoryListingInput,
  type GitHubCloudRepositoryPageDto,
} from '@canopy/protocol/settings/github-cloud-repository-listing';
import { GITHUB_REPOSITORY_QUERY_MAX_LENGTH } from '@canopy/protocol/settings/organization-repositories';
import type {
  GitHubCloudRepositoryResponse,
  GitHubCloudRepositoryRoute,
  GitHubCloudRepositoryTransport,
} from './github-cloud-host';

/** Which call failed; picks the generic copy for an untyped failure. */
export type GitHubCloudApiAction = 'load' | 'verify' | 'connect' | 'disconnect';

export type GitHubCloudApiFailureKind =
  /** An allowlisted service code at its contract status. */
  | 'typed'
  /** 404: GitHub for cloud (or cloud work) is off for this account. */
  | 'unavailable'
  /** 401: no usable session. */
  | 'unauthorized'
  /** Any other non-2xx answer, including route-level and wrapper codes. */
  | 'http'
  /** A 2xx answer whose body failed the runtime guard. */
  | 'invalid-response'
  /** The request never got an answer. */
  | 'network';

export const GITHUB_CLOUD_ACTION_ERROR_COPY: Readonly<
  Record<GitHubCloudApiAction, string>
> = {
  load: "Couldn't load your GitHub connection. Try again.",
  verify: "Couldn't check your GitHub connection. Try again.",
  connect: "Couldn't link GitHub. Try again.",
  disconnect: "Couldn't unlink GitHub. Try again.",
};

export const GITHUB_CLOUD_UNAVAILABLE_COPY =
  "Linking GitHub isn't available for your account yet.";

export const GITHUB_CLOUD_SIGNED_OUT_COPY =
  'Your session ended. Sign in again to continue.';

/** A failed GitHub for cloud call. Its message is never user copy. */
export class GitHubCloudApiError extends Error {
  readonly kind: GitHubCloudApiFailureKind;
  /** HTTP status, or null when there was no answer. */
  readonly status: number | null;
  /** The allowlisted service code, only for `kind === 'typed'`. */
  readonly code: GitHubCloudErrorCode | null;

  constructor(
    kind: GitHubCloudApiFailureKind,
    status: number | null,
    code: GitHubCloudErrorCode | null = null,
  ) {
    super(`GitHub for cloud request failed (${kind})`);
    this.name = 'GitHubCloudApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export function isGitHubCloudApiError(
  error: unknown,
): error is GitHubCloudApiError {
  return error instanceof GitHubCloudApiError;
}

/** Fixed local copy for a failure of `action`; never text from a response. */
export function gitHubCloudErrorMessage(
  error: unknown,
  action: GitHubCloudApiAction,
): string {
  if (!isGitHubCloudApiError(error)) {
    return GITHUB_CLOUD_ACTION_ERROR_COPY[action];
  }
  if (error.code !== null) return GITHUB_CLOUD_ERROR_COPY[error.code];
  if (error.kind === 'unavailable') return GITHUB_CLOUD_UNAVAILABLE_COPY;
  if (error.kind === 'unauthorized') return GITHUB_CLOUD_SIGNED_OUT_COPY;
  return GITHUB_CLOUD_ACTION_ERROR_COPY[action];
}

function failureFor(status: number, body: unknown): GitHubCloudApiError {
  const code = readGitHubCloudErrorCode(body);
  if (code !== null && GITHUB_CLOUD_ERROR_STATUS[code] === status) {
    return new GitHubCloudApiError('typed', status, code);
  }
  if (status === 404) return new GitHubCloudApiError('unavailable', status);
  if (status === 401) return new GitHubCloudApiError('unauthorized', status);
  return new GitHubCloudApiError('http', status);
}

const NO_BODY: unique symbol = Symbol('no JSON body');

async function readJson(
  response: GitHubCloudRepositoryResponse,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body;
  } catch (error) {
    if (signal?.aborted) throw error;
    return NO_BODY;
  }
}

/**
 * An `Error` or an error from another realm (a `DOMException` is not an
 * `instanceof Error` across realms).
 */
function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'name') === 'string' &&
    typeof Reflect.get(value, 'message') === 'string'
  );
}

/** The abort itself, as an aborted fetch rejects with it. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return isErrorLike(reason)
    ? reason
    : new DOMException('Aborted', 'AbortError');
}

/**
 * Settles with `call`, or rejects with the abort once `signal` aborts. The
 * settings client takes no signal, so an aborted read's late answer is
 * dropped here instead. The abort is watched before `call` starts, so an
 * abort raised while it is sent still wins.
 */
function abortable<T>(
  call: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return call();
  if (signal.aborted) return Promise.reject(abortReason(signal));
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([aborted, call()]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

/** The settings client's failure as this module's error. */
function failureFromSettings(error: unknown): GitHubCloudApiError {
  if (!(error instanceof SettingsOperationError)) {
    return new GitHubCloudApiError('network', null);
  }
  if (error.code === 'invalid_response') {
    return new GitHubCloudApiError('invalid-response', error.status ?? null);
  }
  // No answer: offline, an unsent request, or a write whose outcome is unknown.
  if (error.status === undefined)
    return new GitHubCloudApiError('network', null);
  return failureFor(error.status, { code: error.serverCode });
}

/**
 * Runs one connection entry, rejecting with `GitHubCloudApiError`. The
 * client validates the result against the entry; the guard is checked here
 * again so a host client that answers loosely still never reaches a view.
 */
async function request<T>(
  call: () => Promise<unknown>,
  guard: (body: unknown) => body is T,
  signal?: AbortSignal,
): Promise<T> {
  let body: unknown;
  try {
    body = await abortable(call, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw failureFromSettings(error);
  }
  if (!guard(body)) throw new GitHubCloudApiError('invalid-response', null);
  return body;
}

/** The stored connection projection (not a live check). */
export function fetchGitHubCloudConnection(
  client: AccountOrganizationSettingsClient,
  signal?: AbortSignal,
): Promise<GitHubCloudConnectionDto> {
  return request(
    () => client.read('account.github.connection.read', {}),
    isGitHubCloudConnectionDto,
    signal,
  );
}

/** Verifies the user's GitHub authorization and installations live. */
export function verifyGitHubCloudConnection(
  client: AccountOrganizationSettingsClient,
  signal?: AbortSignal,
): Promise<GitHubCloudConnectionDto> {
  return request(
    () => client.write('account.github.connection.verify', {}),
    isGitHubCloudConnectionDto,
    signal,
  );
}

export interface GitHubCloudConnectRequest {
  /** In-app path GitHub setup returns to; the server normalizes it. */
  returnTo: string;
  /** `install` always offers the App install step (Add account). */
  intent?: GitHubCloudConnectIntent;
  /** The original OAuth flow's server-side fence; never refreshed on callback. */
  continuationGeneration?: number;
}

/** The explicit Connect: follow `next`, not the connection state. */
export function startGitHubCloudConnect(
  client: AccountOrganizationSettingsClient,
  { returnTo, intent, continuationGeneration }: GitHubCloudConnectRequest,
): Promise<GitHubCloudConnectResponse> {
  return request(
    () =>
      client.write('account.github.connection.installLink', {
        returnTo,
        ...(intent === undefined ? {} : { intent }),
        ...(continuationGeneration === undefined
          ? {}
          : { continuationGeneration }),
      }),
    isGitHubCloudConnectResponse,
  );
}

/** Disconnects GitHub for cloud; returns the projection read afterwards. */
export function disconnectGitHubCloud(
  client: AccountOrganizationSettingsClient,
): Promise<GitHubCloudConnectionDto> {
  return request(
    () => client.write('account.github.connection.disconnect', {}),
    isGitHubCloudConnectionDto,
  );
}

// ---------------------------------------------------------------------------
// Repository listing and creation capability (REG-3021)
// ---------------------------------------------------------------------------

const REPOSITORIES_PATH = '/cloud/github/repositories';
const CREATION_CAPABILITY_PATH = `${REPOSITORIES_PATH}/creation-capability`;

/**
 * The backend path (after `/api`) of one repository route. `cursor` 1 and a
 * blank `query` are left out of the address; the query is trimmed and
 * bounded to what the route accepts.
 */
export function gitHubCloudRepositoryRoutePath(
  route: GitHubCloudRepositoryRoute,
): string {
  if (route.kind === 'creationCapability') {
    const params = new URLSearchParams({
      installationId: route.installationId,
    });
    return `${CREATION_CAPABILITY_PATH}?${params.toString()}`;
  }
  const { installationId, cursor, query } = route.input;
  const params = new URLSearchParams({ installationId });
  if (cursor > 1) params.set('cursor', String(cursor));
  const q = query.trim().slice(0, GITHUB_REPOSITORY_QUERY_MAX_LENGTH);
  if (q !== '') params.set('q', q);
  return `${REPOSITORIES_PATH}?${params.toString()}`;
}

/** Which repository call failed; picks the generic copy for an untyped failure. */
export type GitHubCloudRepositoryApiAction = 'list' | 'capability';

export const GITHUB_CLOUD_REPOSITORY_ACTION_ERROR_COPY: Readonly<
  Record<GitHubCloudRepositoryApiAction, string>
> = {
  list: "Couldn't load repositories from GitHub. Try again.",
  capability:
    "Couldn't check whether this account can create repositories. Try again.",
};

/** A failed repository listing or capability call. Its message is never user copy. */
export class GitHubCloudRepositoryApiError extends Error {
  readonly kind: GitHubCloudApiFailureKind;
  /** HTTP status, or null when there was no answer. */
  readonly status: number | null;
  /** A repository or GitHub code at its contract status, for `typed` only. */
  readonly code: CloudRepositoryFailureCode | null;
  /** Allowlisted diagnostics of a typed failure; never provider text. */
  readonly details: CloudRepositoryErrorDetails | null;
  /** From the fixed table for the code; never retried automatically. */
  readonly retryable: boolean;
  /** `Retry-After` in seconds, capped; null when absent. */
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: GitHubCloudApiFailureKind,
    status: number | null,
    typed: {
      readonly code: CloudRepositoryFailureCode;
      readonly details: CloudRepositoryErrorDetails | null;
      readonly retryable: boolean;
    } | null = null,
    retryAfterSeconds: number | null = null,
  ) {
    super(`GitHub repository request failed (${kind})`);
    this.name = 'GitHubCloudRepositoryApiError';
    this.kind = kind;
    this.status = status;
    this.code = typed?.code ?? null;
    this.details = typed?.details ?? null;
    this.retryable = typed?.retryable ?? false;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isGitHubCloudRepositoryApiError(
  error: unknown,
): error is GitHubCloudRepositoryApiError {
  return error instanceof GitHubCloudRepositoryApiError;
}

/** Fixed local copy for a failed repository call; never text from a response. */
export function gitHubCloudRepositoryErrorMessage(
  error: unknown,
  action: GitHubCloudRepositoryApiAction,
): string {
  if (!isGitHubCloudRepositoryApiError(error)) {
    return GITHUB_CLOUD_REPOSITORY_ACTION_ERROR_COPY[action];
  }
  if (error.code !== null) return cloudRepositoryFailureCopy(error.code);
  if (error.kind === 'unavailable') {
    return cloudRepositoryFailureCopy('cloud-repository-disabled');
  }
  if (error.kind === 'unauthorized') return GITHUB_CLOUD_SIGNED_OUT_COPY;
  return GITHUB_CLOUD_REPOSITORY_ACTION_ERROR_COPY[action];
}

function repositoryFailureFor(
  response: GitHubCloudRepositoryResponse,
  body: unknown,
): GitHubCloudRepositoryApiError {
  const { status } = response;
  const retryAfter = readRetryAfterSeconds(response.headers);
  const typed = readCloudRepositoryErrorBody(body, status);
  if (typed !== null) {
    return new GitHubCloudRepositoryApiError(
      'typed',
      status,
      typed,
      retryAfter,
    );
  }
  if (status === 404) {
    return new GitHubCloudRepositoryApiError('unavailable', status);
  }
  if (status === 401) {
    return new GitHubCloudRepositoryApiError('unauthorized', status);
  }
  return new GitHubCloudRepositoryApiError('http', status, null, retryAfter);
}

async function repositoryRequest<T>(
  transport: GitHubCloudRepositoryTransport | null,
  route: GitHubCloudRepositoryRoute,
  signal: AbortSignal | undefined,
  guard: (body: unknown) => body is T,
): Promise<T> {
  if (transport === null) {
    throw new GitHubCloudRepositoryApiError('unavailable', null);
  }
  let response: GitHubCloudRepositoryResponse;
  try {
    response = await transport.request(route, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GitHubCloudRepositoryApiError('network', null);
  }
  const body = await readJson(response, signal);
  if (!response.ok) throw repositoryFailureFor(response, body);
  if (!guard(body)) {
    throw new GitHubCloudRepositoryApiError(
      'invalid-response',
      response.status,
    );
  }
  return body;
}

/**
 * One page of the repositories the user's GitHub token can see in one
 * installation (see `gitHubCloudRepositoryRoutePath` for the address). A
 * page that answers for another installation is refused as an invalid
 * response. Without a repository transport it rejects as `unavailable`.
 */
export function fetchGitHubCloudRepositoryPage(
  transport: GitHubCloudRepositoryTransport | null,
  input: GitHubCloudRepositoryListingInput,
  signal?: AbortSignal,
): Promise<GitHubCloudRepositoryPageDto> {
  return repositoryRequest(
    transport,
    { kind: 'page', input },
    signal,
    (body): body is GitHubCloudRepositoryPageDto =>
      isGitHubCloudRepositoryPageDto(body) &&
      body.installationId === input.installationId,
  );
}

/**
 * Whether the user can create a repository under one installation's account.
 * Computed from fresh evidence on every call; the server checks again before
 * any create, so this only decides what the dialog offers.
 */
export function fetchGitHubRepositoryCreationCapability(
  transport: GitHubCloudRepositoryTransport | null,
  installationId: string,
  signal?: AbortSignal,
): Promise<GitHubRepositoryCreationCapabilityDto> {
  return repositoryRequest(
    transport,
    { kind: 'creationCapability', installationId },
    signal,
    (body): body is GitHubRepositoryCreationCapabilityDto =>
      isGitHubRepositoryCreationCapabilityDto(body) &&
      body.installationId === installationId,
  );
}
