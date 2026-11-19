import { AsyncLocalStorage } from 'node:async_hooks';
import type { Octokit } from '@octokit/rest';
import { invalidateTokenCache } from '../github-auth';
import {
  getGitHubBrokerCredentialPort,
  type GitHubBrokerCredentialLease,
} from './credential-port';
import {
  resolveOctokitBrokerClientOptions,
  type OctokitClientLog,
} from '../github-octokit-options';
import { loadOctokitConstructor } from '../github-octokit-loader';
import {
  logMainProcessInfo,
  logMainProcessWarn,
} from '../main-process-logging';
import { GitHubConditionalCache } from './conditional-cache';
import {
  GitHubBrokerCredentialResetError,
  GitHubBrokerError,
  GitHubBrokerTimeoutError,
  githubErrorHeaders,
  githubErrorMessage,
  githubErrorStatus,
  isGitHubBrokerError,
  isGitHubGraphQlRateLimitError,
} from './errors';
import {
  DEFAULT_GITHUB_RATE_LIMIT_RESOURCE,
  GitHubQuotaLedger,
  GitHubSpendCounters,
  type GitHubQuotaSnapshot,
  type GitHubRateLimitResource,
  type GitHubSpendSummary,
} from './quota';
import {
  SAFE_READ_RETRY_DELAYS_MS,
  SECONDARY_FALLBACK_DELAYS_MS,
  classifyGitHubRateLimit,
  normalizeGitHubHeaders,
  parsePollIntervalMs,
  readRateLimitSnapshot,
  withJitter,
  type GitHubHeaders,
  type GitHubRateLimitClassification,
  type GitHubRateLimitSnapshot,
  type GitHubRateLimitState,
} from './rate-limit';
import {
  GitHubRequestScheduler,
  type GitHubRequestOperation,
  type GitHubRequestPriority,
} from './scheduler';

export type {
  GitHubRateLimitSnapshot,
  GitHubRateLimitState,
} from './rate-limit';
export type {
  GitHubQuotaSnapshot,
  GitHubRateLimitResource,
  GitHubSpendSummary,
} from './quota';
export {
  GitHubBrokerCredentialResetError,
  GitHubBrokerError,
  GitHubBrokerLeaseExpiredError,
  GitHubBrokerTimeoutError,
  isGitHubBrokerError,
} from './errors';

export interface GitHubBrokerRequestOptions<T = unknown> {
  priority: GitHubRequestPriority;
  operation: GitHubRequestOperation;
  idempotency: 'safe' | 'unsafe';
  resourceKey?: string;
  conditional?: boolean;
  isCachedData?: (value: unknown) => value is T;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * A caller-selected credential lease from the credential port, authorized
   * again for every request attempt. Omitted: the broker default.
   */
  credential?: GitHubBrokerCredentialLease;
  /**
   * The quota bucket the request spends, checked before it is sent: `core`
   * (the default) for REST, `graphql` for GraphQL, `search` for REST search.
   */
  resource?: GitHubRateLimitResource;
  /** Spend-summary label; unlabeled callers share one bucket. */
  caller?: string;
}

export interface GitHubQuotaDiagnostics {
  quota: Array<{
    resource: GitHubRateLimitResource;
    limit: number;
    remaining: number;
    resetAt: string;
  }>;
  pausedUntil: Record<GitHubRateLimitResource, string>;
  spend: GitHubSpendSummary | null;
}

export interface GitHubRawResponse<T> {
  status: number;
  headers?: GitHubHeaders;
  data: T;
}

export type GitHubBrokerResult<T> =
  | {
      kind: 'read';
      data: T;
      changed: boolean;
      status: 200 | 304;
      rateLimit: GitHubRateLimitSnapshot;
      pollIntervalMs?: number;
    }
  | {
      kind: 'mutation';
      data: T;
      status: number;
      rateLimit: GitHubRateLimitSnapshot;
    };

export interface GitHubBroker {
  getCredentialGeneration(): number;
  execute<T>(
    request: (
      octokit: Octokit,
      conditionalHeaders: Record<string, string>,
    ) => Promise<GitHubRawResponse<T>>,
    options: GitHubBrokerRequestOptions<T>,
  ): Promise<GitHubBrokerResult<T>>;
  subscribeRateLimits(
    listener: (state: GitHubRateLimitState) => void,
  ): () => void;
  /** GitHub's last reported quota and the requests sent this window. */
  getQuotaDiagnostics(): GitHubQuotaDiagnostics;
  /** GitHub's latest count for one bucket, or undefined when none is known. */
  currentQuota(
    resource?: GitHubRateLimitResource,
    credential?: GitHubBrokerCredentialLease,
  ): GitHubQuotaSnapshot | undefined;
  resetCredentials(): void;
  shutdown(): void;
}

/** One scheduled attempt, visible to the Octokit request hook. */
interface GitHubRequestAttempt {
  signal: AbortSignal;
  generation: number;
  lease: GitHubBrokerCredentialLease;
  scope: string;
  caller?: string;
  priority: GitHubRequestPriority;
  resource: GitHubRateLimitResource;
  observedResponses: number;
}

const SHARED_PRIORITY_RANK: Record<GitHubRequestPriority, number> = {
  background: 0,
  watcher: 1,
  interactive: 2,
};

interface SharedRequest<T> {
  generation: number;
  priority: GitHubRequestPriority;
  controller: AbortController;
  typeIdentity: unknown;
  promise: Promise<GitHubBrokerResult<T>>;
  subscribers: number;
  settled: boolean;
}

function isSharedRequestFor<T>(
  shared: SharedRequest<unknown>,
  typeIdentity: unknown,
): shared is SharedRequest<T> {
  return shared.typeIdentity === typeIdentity;
}

const SHARED_FETCH_TIMEOUT_FLOOR_MS = 60_000;
const MAX_EXTERNAL_RESET_REISSUES = 3;
const MAX_PRIMARY_RETRIES = 3;

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? error.name : undefined;
  return name === 'AbortError' || name === 'RequestAbortedError';
}

function isSuccessfulMutationStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function errorFromUnknown(reason: unknown, fallback: GitHubBrokerError): Error {
  return reason instanceof Error ? reason : fallback;
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      errorFromUnknown(
        signal.reason,
        new GitHubBrokerError('cancelled', 'GitHub request was cancelled.'),
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        errorFromUnknown(
          signal?.reason,
          new GitHubBrokerError('cancelled', 'GitHub request was cancelled.'),
        ),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Checks a lease within the caller's timeout and cancellation, for the checks
 * that run outside a scheduled attempt: a stalled credential lookup rejects
 * with `timeout` once `timeoutMs` passes and with `cancelled` on abort.
 */
function verifyWithin(
  lease: GitHubBrokerCredentialLease,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const cancelled = (): GitHubBrokerError =>
    new GitHubBrokerError('cancelled', 'GitHub request was cancelled.');
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(cancelled());
    };
    const timer = setTimeout(
      () => {
        cleanup();
        reject(new GitHubBrokerTimeoutError());
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    credentialPort.verify(lease).then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(
          errorFromUnknown(
            error,
            new GitHubBrokerError(
              'not_authenticated',
              'The GitHub credential check failed.',
            ),
          ),
        );
      },
    );
  });
}

function readGitHubQuotaResource(
  headers: GitHubHeaders | undefined,
): GitHubRateLimitResource | undefined {
  const resource =
    normalizeGitHubHeaders(headers)['x-ratelimit-resource']?.trim();
  return resource ? resource : undefined;
}

const credentialPort = getGitHubBrokerCredentialPort();

function leaseFor(
  credential?: GitHubBrokerCredentialLease,
): GitHubBrokerCredentialLease {
  return credential ?? credentialPort.defaultLease;
}

function credentialScopeKey(credential?: GitHubBrokerCredentialLease): string {
  return credentialPort.scopeId(leaseFor(credential));
}

/**
 * Octokit's logger for the broker client. Request options (and so headers)
 * are never logged: debug and info are dropped, and warnings and errors keep
 * only their message.
 */
const OCTOKIT_LOG: OctokitClientLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message) => logMainProcessWarn(`[github] ${message}`),
  error: (message) => logMainProcessWarn(`[github] ${message}`),
};

type OctokitRequest = Octokit['request'];
type OctokitEndpoint = Required<
  ReturnType<OctokitRequest['endpoint']['merge']>
>;

class GitHubBrokerImpl implements GitHubBroker {
  private scheduler = new GitHubRequestScheduler();
  private conditionalCache = new GitHubConditionalCache();
  private octokit: Octokit | null = null;
  private credentialGeneration = 0;
  private stopped = false;
  private listeners = new Set<(state: GitHubRateLimitState) => void>();
  private inFlight = new Map<string, SharedRequest<unknown>>();
  private requestAttempt = new AsyncLocalStorage<GitHubRequestAttempt>();
  private lastNotifiedPause = new Map<string, number>();
  private quotaLedger = new GitHubQuotaLedger();
  private spend = new GitHubSpendCounters((message) =>
    logMainProcessInfo(message),
  );

  getCredentialGeneration(): number {
    return this.credentialGeneration;
  }

  async execute<T>(
    request: (
      octokit: Octokit,
      conditionalHeaders: Record<string, string>,
    ) => Promise<GitHubRawResponse<T>>,
    options: GitHubBrokerRequestOptions<T>,
  ): Promise<GitHubBrokerResult<T>> {
    if (this.stopped) {
      throw new GitHubBrokerError('shutdown', 'GitHub broker is shut down.');
    }
    let authenticationRefreshes = 0;
    let externalResetReissues = 0;

    while (true) {
      const generation = this.credentialGeneration;
      try {
        const result =
          options.operation === 'read' &&
          options.idempotency === 'safe' &&
          options.conditional === true &&
          options.resourceKey
            ? await this.executeShared(
                request,
                options,
                generation,
                authenticationRefreshes,
              )
            : await this.executeForGeneration(
                request,
                options,
                generation,
                authenticationRefreshes,
              );
        // A write GitHub has applied is returned as it is: dropping or
        // re-sending it would repeat or hide the write.
        if (options.operation === 'mutation') return result;
        // A read, fresh, shared or replayed from the conditional cache on a
        // 304, is handed over only while the caller's own lease still holds.
        await verifyWithin(
          leaseFor(options.credential),
          options.timeoutMs,
          options.signal,
        );
        // A reset while that check ran means the read belongs to the previous
        // credential: drop it and read again under the new one.
        if (generation !== this.credentialGeneration) {
          throw new GitHubBrokerCredentialResetError('credential_reset');
        }
        return result;
      } catch (error) {
        if (!(error instanceof GitHubBrokerCredentialResetError)) throw error;
        if (error.reason === 'authentication_refresh') {
          authenticationRefreshes += 1;
          if (authenticationRefreshes > 1) {
            throw new GitHubBrokerError(
              'not_authenticated',
              'GitHub authentication failed after refreshing credentials.',
              { status: 401 },
            );
          }
        } else {
          externalResetReissues += 1;
          if (externalResetReissues > MAX_EXTERNAL_RESET_REISSUES) {
            throw error;
          }
        }
      }
    }
  }

  subscribeRateLimits(
    listener: (state: GitHubRateLimitState) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  currentQuota(
    resource: GitHubRateLimitResource = DEFAULT_GITHUB_RATE_LIMIT_RESOURCE,
    credential?: GitHubBrokerCredentialLease,
  ): GitHubQuotaSnapshot | undefined {
    return this.quotaLedger.get(
      credentialScopeKey(credential),
      resource,
      Date.now(),
    );
  }

  getQuotaDiagnostics(): GitHubQuotaDiagnostics {
    const now = Date.now();
    const quota = this.quotaLedger.list(now);
    const pausedUntil: Record<GitHubRateLimitResource, string> = {};
    const resources = Array.from(
      new Set([
        DEFAULT_GITHUB_RATE_LIMIT_RESOURCE,
        'graphql',
        ...quota.map((snapshot) => snapshot.resource),
      ]),
    );
    for (const resource of resources) {
      const until = this.scheduler.getPauseUntil(resource);
      if (until > now) pausedUntil[resource] = new Date(until).toISOString();
    }
    return {
      quota: quota.map((snapshot) => ({
        resource: snapshot.resource,
        limit: snapshot.limit,
        remaining: snapshot.remaining,
        resetAt: new Date(snapshot.resetAtMs).toISOString(),
      })),
      pausedUntil,
      spend: this.spend.summary(),
    };
  }

  resetCredentials(): void {
    if (this.stopped) return;
    invalidateTokenCache();
    this.bumpCredentialGeneration('credential_reset');
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.spend.flush(Date.now(), this.quotaLedger.list(Date.now()));
    this.scheduler.shutdown();
    this.abortSharedRequests('credential_reset');
    this.listeners.clear();
    this.conditionalCache.clear();
    this.quotaLedger.clear();
    this.octokit = null;
  }

  private async executeShared<T>(
    request: (
      octokit: Octokit,
      conditionalHeaders: Record<string, string>,
    ) => Promise<GitHubRawResponse<T>>,
    options: GitHubBrokerRequestOptions<T>,
    generation: number,
    authenticationRefreshes: number,
  ): Promise<GitHubBrokerResult<T>> {
    // Leases for the same credential share a scope, so a read one lease starts
    // can be joined under another: each caller's own lease is checked before
    // it joins (and, in execute, before the result is handed over).
    const lease = leaseFor(options.credential);
    await verifyWithin(lease, options.timeoutMs, options.signal);
    if (generation !== this.credentialGeneration) {
      throw new GitHubBrokerCredentialResetError('credential_reset');
    }
    const key = `${generation}:${credentialPort.scopeId(lease)}:${options.resourceKey}`;
    const typeIdentity = options.isCachedData ?? request;
    const existing = this.inFlight.get(key);
    let shared =
      existing &&
      isSharedRequestFor<T>(existing, typeIdentity) &&
      SHARED_PRIORITY_RANK[existing.priority] >=
        SHARED_PRIORITY_RANK[options.priority]
        ? existing
        : undefined;
    if (!shared) {
      const controller = new AbortController();
      const requestPromise = this.executeForGeneration(
        request,
        {
          ...options,
          signal: controller.signal,
          timeoutMs: Math.max(SHARED_FETCH_TIMEOUT_FLOOR_MS, options.timeoutMs),
        },
        generation,
        authenticationRefreshes,
      );
      const createdShared: SharedRequest<T> = {
        generation,
        priority: options.priority,
        controller,
        typeIdentity,
        subscribers: 0,
        settled: false,
        promise: requestPromise,
      };
      createdShared.promise = requestPromise.finally(() => {
        createdShared.settled = true;
        if (this.inFlight.get(key) === createdShared) {
          this.inFlight.delete(key);
        }
      });
      createdShared.promise.catch(() => undefined);
      shared = createdShared;
      this.inFlight.set(key, createdShared);
    }
    return this.subscribeToShared(shared, options);
  }

  private subscribeToShared<T>(
    shared: SharedRequest<T>,
    options: GitHubBrokerRequestOptions<T>,
  ): Promise<GitHubBrokerResult<T>> {
    if (options.signal?.aborted) {
      return Promise.reject(
        new GitHubBrokerError('cancelled', 'GitHub request was cancelled.'),
      );
    }
    shared.subscribers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (
        result?: GitHubBrokerResult<T>,
        error?: unknown,
      ): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        shared.subscribers -= 1;
        if (shared.subscribers === 0 && !shared.settled) {
          shared.controller.abort(
            new GitHubBrokerError(
              'cancelled',
              'All subscribers cancelled the shared GitHub request.',
            ),
          );
        }
        if (error !== undefined) {
          reject(
            errorFromUnknown(
              error,
              new GitHubBrokerError(
                'network',
                'GitHub request failed without an Error response.',
                { retriable: true },
              ),
            ),
          );
        } else if (result !== undefined) {
          resolve(result);
        } else {
          reject(
            new GitHubBrokerError(
              'invalid_response',
              'GitHub request completed without a result.',
            ),
          );
        }
      };
      const onAbort = (): void =>
        finish(
          undefined,
          new GitHubBrokerError('cancelled', 'GitHub request was cancelled.'),
        );
      const armTimeout = (delayMs: number): void => {
        timeout = setTimeout(
          () => {
            const pauseRemainingMs =
              this.scheduler.getPauseUntil(
                options.resource ?? DEFAULT_GITHUB_RATE_LIMIT_RESOURCE,
              ) - Date.now();
            if (pauseRemainingMs > 0) {
              armTimeout(pauseRemainingMs + Math.max(1, options.timeoutMs));
              return;
            }
            finish(undefined, new GitHubBrokerTimeoutError());
          },
          Math.max(1, delayMs),
        );
        timeout.unref?.();
      };
      armTimeout(options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });

      shared.promise.then(
        (result) => {
          if (shared.generation !== this.credentialGeneration) {
            const reason: unknown = shared.controller.signal.reason;
            finish(
              undefined,
              reason instanceof GitHubBrokerCredentialResetError
                ? reason
                : new GitHubBrokerCredentialResetError('credential_reset'),
            );
            return;
          }
          finish(result);
        },
        (error) => {
          if (shared.generation !== this.credentialGeneration) {
            const reason: unknown = shared.controller.signal.reason;
            finish(
              undefined,
              reason instanceof GitHubBrokerCredentialResetError
                ? reason
                : error instanceof GitHubBrokerCredentialResetError
                  ? error
                  : new GitHubBrokerCredentialResetError('credential_reset'),
            );
            return;
          }
          finish(undefined, error);
        },
      );
    });
  }

  private async executeForGeneration<T>(
    request: (
      octokit: Octokit,
      conditionalHeaders: Record<string, string>,
    ) => Promise<GitHubRawResponse<T>>,
    options: GitHubBrokerRequestOptions<T>,
    generation: number,
    authenticationRefreshes: number,
  ): Promise<GitHubBrokerResult<T>> {
    const cacheKey = options.resourceKey
      ? `${generation}:${credentialScopeKey(options.credential)}:${options.resourceKey}`
      : undefined;
    const cacheEntry =
      options.operation === 'read' &&
      options.conditional &&
      options.isCachedData &&
      cacheKey
        ? this.conditionalCache.get(cacheKey, options.isCachedData)
        : undefined;
    let conditionalHeaders: Record<string, string> = cacheEntry
      ? { 'if-none-match': cacheEntry.etag }
      : {};
    let retriedMissing304Cache = false;
    let safeRetryIndex = 0;
    let secondaryRetryIndex = 0;
    let primaryRetryIndex = 0;
    const lease = leaseFor(options.credential);
    const scope = credentialPort.scopeId(lease);
    const resource = options.resource ?? DEFAULT_GITHUB_RATE_LIMIT_RESOURCE;

    while (true) {
      if (generation !== this.credentialGeneration) {
        throw new GitHubBrokerCredentialResetError('credential_reset');
      }
      let attempt: GitHubRequestAttempt | undefined;
      try {
        const response = await this.scheduler.schedule(
          async (signal) => {
            const octokit = await this.prepareAttempt(generation, lease);
            const current: GitHubRequestAttempt = {
              signal,
              generation,
              lease,
              scope,
              ...(options.caller ? { caller: options.caller } : {}),
              priority: options.priority,
              resource,
              observedResponses: 0,
            };
            attempt = current;
            return this.requestAttempt.run(current, () =>
              request(octokit, conditionalHeaders),
            );
          },
          {
            priority: options.priority,
            operation: options.operation,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
            resource,
            admit: () =>
              this.quotaLedger.refusedUntil(
                scope,
                resource,
                options.priority,
                Date.now(),
              ),
          },
        );
        if (attempt && attempt.observedResponses === 0) {
          this.observeResponse(attempt, response.status, response.headers);
        }

        const rateLimit = readRateLimitSnapshot(response.headers);
        if (options.operation === 'mutation') {
          if (!isSuccessfulMutationStatus(response.status)) {
            throw new GitHubBrokerError(
              'invalid_response',
              `GitHub mutation returned unexpected status ${response.status}.`,
              { status: response.status },
            );
          }
          return {
            kind: 'mutation',
            data: response.data,
            status: response.status,
            rateLimit,
          };
        }
        if (generation !== this.credentialGeneration) {
          throw new GitHubBrokerCredentialResetError('credential_reset');
        }

        const pollIntervalMs = parsePollIntervalMs(response.headers);
        if (response.status === 304) {
          const current =
            cacheKey && options.isCachedData
              ? this.conditionalCache.get(cacheKey, options.isCachedData)
              : undefined;
          if (!current) {
            if (retriedMissing304Cache) {
              throw new GitHubBrokerError(
                'invalid_response',
                'GitHub returned 304 without a cached response.',
                { status: 304 },
              );
            }
            retriedMissing304Cache = true;
            conditionalHeaders = {};
            continue;
          }
          return {
            kind: 'read',
            data: current.data,
            changed: false,
            status: 304,
            rateLimit,
            ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
          };
        }
        if (response.status !== 200) {
          throw new GitHubBrokerError(
            'invalid_response',
            `GitHub read returned unexpected status ${response.status}.`,
            { status: response.status },
          );
        }
        if (cacheKey && options.conditional) {
          const headers = normalizeGitHubHeaders(response.headers);
          const etag = headers.etag;
          // Cached only while the lease that fetched it still holds, so
          // nothing is cached on behalf of a lease revoked mid-flight.
          const leaseHolds = await verifyWithin(
            lease,
            options.timeoutMs,
            options.signal,
          ).then(
            () => true,
            () => false,
          );
          if (etag && leaseHolds)
            this.conditionalCache.set(cacheKey, etag, response.data);
          else this.conditionalCache.delete(cacheKey);
        }
        return {
          kind: 'read',
          data: response.data,
          changed: true,
          status: 200,
          rateLimit,
          ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
        };
      } catch (error) {
        if (error instanceof GitHubBrokerCredentialResetError) throw error;
        if (
          isGitHubBrokerError(error) &&
          (error.code === 'cancelled' || error.code === 'shutdown')
        ) {
          throw error;
        }
        const graphQlRateLimited = isGitHubGraphQlRateLimitError(error);
        const status =
          githubErrorStatus(error) ?? (graphQlRateLimited ? 429 : undefined);
        if (
          attempt &&
          attempt.observedResponses === 0 &&
          (status !== undefined || graphQlRateLimited)
        ) {
          this.observeResponse(attempt, status, githubErrorHeaders(error));
        }
        if (status === 304 && options.operation === 'read') {
          const headers = githubErrorHeaders(error);
          const current =
            cacheKey && options.isCachedData
              ? this.conditionalCache.get(cacheKey, options.isCachedData)
              : undefined;
          if (!current) {
            if (retriedMissing304Cache) {
              throw new GitHubBrokerError(
                'invalid_response',
                'GitHub returned 304 without a cached response.',
                { status: 304, cause: error },
              );
            }
            retriedMissing304Cache = true;
            conditionalHeaders = {};
            continue;
          }
          const pollIntervalMs = parsePollIntervalMs(headers);
          return {
            kind: 'read',
            data: current.data,
            changed: false,
            status: 304,
            rateLimit: readRateLimitSnapshot(headers),
            ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
          };
        }
        if (status === 401) {
          if (!credentialPort.isDefault(lease)) {
            throw new GitHubBrokerError(
              'not_authenticated',
              'The selected GitHub credential was rejected.',
              { status, cause: error },
            );
          }
          if (authenticationRefreshes >= 1) {
            throw new GitHubBrokerError(
              'not_authenticated',
              'GitHub authentication failed after refreshing credentials.',
              { status, cause: error },
            );
          }
          invalidateTokenCache();
          this.bumpCredentialGeneration('authentication_refresh');
          throw new GitHubBrokerCredentialResetError('authentication_refresh');
        }

        if (generation !== this.credentialGeneration) {
          throw new GitHubBrokerCredentialResetError('credential_reset');
        }
        const headers = githubErrorHeaders(error);
        const rateLimit = classifyGitHubRateLimit({
          status,
          headers,
          message: githubErrorMessage(error),
          secondaryRetryIndex,
          graphQlRateLimited,
        });
        if (rateLimit) {
          const pausedResource = this.applyRateLimitPause(
            rateLimit,
            graphQlRateLimited ? 'graphql' : resource,
          );
          if (options.idempotency === 'unsafe') {
            throw new GitHubBrokerError(
              'rate_limited',
              'GitHub rate limited an unsafe operation; it was not retried.',
              {
                retriable: true,
                status,
                cause: error,
                retryAt: rateLimit.retryAtMs,
                ...(pausedResource ? { resource: pausedResource } : {}),
              },
            );
          }
          const retryAllowed =
            rateLimit.kind === 'primary'
              ? primaryRetryIndex < MAX_PRIMARY_RETRIES
              : secondaryRetryIndex < SECONDARY_FALLBACK_DELAYS_MS.length;
          if (!retryAllowed) {
            throw new GitHubBrokerError(
              'rate_limited',
              'GitHub rate-limit retry budget was exhausted.',
              {
                retriable: true,
                status,
                cause: error,
                retryAt: rateLimit.retryAtMs,
                ...(pausedResource ? { resource: pausedResource } : {}),
              },
            );
          }
          if (rateLimit.kind === 'primary') primaryRetryIndex += 1;
          else secondaryRetryIndex += 1;
          continue;
        }

        if (status === 403) {
          throw new GitHubBrokerError(
            'permission_denied',
            githubErrorMessage(error),
            { status, cause: error },
          );
        }
        if (status === 404) {
          throw new GitHubBrokerError('not_found', githubErrorMessage(error), {
            status,
            cause: error,
          });
        }

        const retryableSafeOperation =
          options.idempotency === 'safe' &&
          (options.operation === 'read' || options.operation === 'mutation');
        const isTimeout = error instanceof GitHubBrokerTimeoutError;
        const isServerFailure = status !== undefined && status >= 500;
        const isNetworkFailure =
          status === undefined &&
          !isGitHubBrokerError(error) &&
          !isAbortLike(error);
        if (
          retryableSafeOperation &&
          (isTimeout || isServerFailure || isNetworkFailure) &&
          safeRetryIndex < SAFE_READ_RETRY_DELAYS_MS.length
        ) {
          const delayMs = withJitter(
            SAFE_READ_RETRY_DELAYS_MS[safeRetryIndex++],
          );
          await delayWithSignal(delayMs, options.signal);
          continue;
        }
        if (isTimeout) throw error;
        if (isServerFailure) {
          throw new GitHubBrokerError(
            'server_error',
            githubErrorMessage(error),
            { retriable: true, status, cause: error },
          );
        }
        if (isNetworkFailure || isAbortLike(error)) {
          throw new GitHubBrokerError('network', githubErrorMessage(error), {
            retriable: true,
            cause: error,
          });
        }
        throw error;
      }
    }
  }

  /**
   * Check the attempt's lease before the request runs, so a missing or
   * revoked credential is refused before the request function runs, and
   * return the broker's one client. The client holds no credential: the lease
   * is authorized again for every HTTP request the attempt makes.
   */
  private async prepareAttempt(
    generation: number,
    lease: GitHubBrokerCredentialLease,
  ): Promise<Octokit> {
    if (generation !== this.credentialGeneration) {
      throw new GitHubBrokerCredentialResetError('credential_reset');
    }
    await credentialPort.verify(lease);
    if (generation !== this.credentialGeneration) {
      throw new GitHubBrokerCredentialResetError('credential_reset');
    }
    this.octokit ??= this.createOctokit();
    return this.octokit;
  }

  private createOctokit(): Octokit {
    const OctokitConstructor = loadOctokitConstructor();
    const octokit = new OctokitConstructor(
      resolveOctokitBrokerClientOptions(
        () => this.leaseAuthentication(),
        OCTOKIT_LOG,
      ),
    );
    octokit.hook?.wrap('request', async (request, requestOptions) => {
      const attempt = this.requestAttempt.getStore();
      if (!attempt) return request(requestOptions);
      try {
        const response = await request(requestOptions);
        this.observeResponse(attempt, response.status, response.headers);
        return response;
      } catch (error) {
        const status = githubErrorStatus(error);
        if (status !== undefined) {
          this.observeResponse(attempt, status, githubErrorHeaders(error));
        }
        throw error;
      }
    });
    return octokit;
  }

  /**
   * The client's auth strategy. Octokit wraps this hook first, so it runs
   * innermost: every plugin hook (request logging included) sees the request
   * without its `authorization` header. The header is set on a fresh endpoint
   * object for one HTTP request and removed when that request settles.
   */
  private leaseAuthentication(): unknown {
    const hook = async (
      request: OctokitRequest,
      options: OctokitEndpoint,
    ): ReturnType<OctokitRequest> => {
      const attempt = this.requestAttempt.getStore();
      if (!attempt) {
        throw new GitHubBrokerError(
          'not_authenticated',
          'GitHub requests are authorized only inside a broker attempt.',
        );
      }
      // Each Octokit hook receives the options its request started with, not
      // what an outer hook passes on, so the attempt's signal is attached here,
      // next to the header, where the HTTP request is actually sent.
      const endpoint = request.endpoint.merge(options);
      endpoint.request = { ...endpoint.request, signal: attempt.signal };
      // A call left running after its attempt settled is never authorized.
      attempt.signal.throwIfAborted();
      const authorization = await credentialPort.authorize(attempt.lease);
      attempt.signal.throwIfAborted();
      // A reset while the lease was being authorized means the header may be
      // the previous credential's: send nothing and let the attempt reissue.
      if (attempt.generation !== this.credentialGeneration) {
        throw new GitHubBrokerCredentialResetError('credential_reset');
      }
      // The last check before sending: a lease that expired or was revoked
      // while it was being authorized sends nothing.
      credentialPort.assertLive(attempt.lease);
      endpoint.headers.authorization = authorization;
      try {
        return await request(endpoint);
      } finally {
        delete endpoint.headers.authorization;
      }
    };
    return Object.assign(
      (): Promise<{ type: 'lease' }> => Promise.resolve({ type: 'lease' }),
      { hook },
    );
  }

  private bumpCredentialGeneration(
    reason: 'credential_reset' | 'authentication_refresh',
  ): void {
    this.credentialGeneration += 1;
    this.conditionalCache.clear();
    this.quotaLedger.clear();
    this.abortSharedRequests(reason);
  }

  /**
   * Record one response that reached GitHub: its quota headers update the
   * ledger and its cost is counted for the caller. A bucket GitHub reports
   * empty pauses that bucket until it resets.
   */
  private observeResponse(
    attempt: GitHubRequestAttempt,
    status: number | undefined,
    headers: GitHubHeaders | undefined,
  ): void {
    attempt.observedResponses += 1;
    const now = Date.now();
    const snapshot =
      attempt.generation === this.credentialGeneration
        ? this.quotaLedger.observe(attempt.scope, headers)
        : null;
    this.spend.record(
      {
        ...(attempt.caller ? { caller: attempt.caller } : {}),
        priority: attempt.priority,
        resource: readGitHubQuotaResource(headers) ?? attempt.resource,
        notModified: status === 304,
      },
      now,
      () => this.quotaLedger.list(now),
    );
    if (snapshot && snapshot.remaining === 0 && snapshot.resetAtMs > now) {
      this.applyRateLimitPause(
        {
          kind: 'primary',
          retryAtMs: snapshot.resetAtMs + 1000,
          snapshot: readRateLimitSnapshot(headers),
        },
        snapshot.resource,
      );
    }
  }

  /**
   * A primary limit pauses only the bucket GitHub reported, and the
   * request's own bucket when they differ; secondary throttling pauses
   * everything. Returns the paused bucket, or undefined for a global pause.
   */
  private applyRateLimitPause(
    classification: GitHubRateLimitClassification,
    requestResource: GitHubRateLimitResource,
  ): GitHubRateLimitResource | undefined {
    if (classification.kind === 'secondary') {
      this.scheduler.pauseUntil(classification.retryAtMs);
      this.emitRateLimit(classification);
      return undefined;
    }
    const reported = classification.snapshot.resource ?? requestResource;
    this.scheduler.pauseUntil(classification.retryAtMs, reported);
    if (reported !== requestResource) {
      this.scheduler.pauseUntil(classification.retryAtMs, requestResource);
    }
    this.emitRateLimit({
      ...classification,
      snapshot: { ...classification.snapshot, resource: reported },
    });
    return reported;
  }

  private abortSharedRequests(
    reason: 'credential_reset' | 'authentication_refresh',
  ): void {
    const error = new GitHubBrokerCredentialResetError(reason);
    for (const shared of Array.from(this.inFlight.values())) {
      shared.controller.abort(error);
    }
    this.inFlight.clear();
  }

  private emitRateLimit(classification: GitHubRateLimitClassification): void {
    const key =
      classification.kind === 'primary'
        ? `primary:${classification.snapshot.resource ?? DEFAULT_GITHUB_RATE_LIMIT_RESOURCE}`
        : 'secondary';
    const previous = this.lastNotifiedPause.get(key) ?? 0;
    if (classification.retryAtMs <= previous) return;
    this.lastNotifiedPause.set(key, classification.retryAtMs);
    const retryAfterSeconds = Math.max(
      0,
      Math.ceil((classification.retryAtMs - Date.now()) / 1000),
    );
    const state: GitHubRateLimitState = {
      kind: classification.kind,
      retryAt: new Date(classification.retryAtMs).toISOString(),
      retryAfterSeconds,
      snapshot: classification.snapshot,
      ...(classification.snapshot.resource
        ? { resource: classification.snapshot.resource }
        : {}),
    };
    for (const listener of Array.from(this.listeners)) listener(state);
  }
}

let singleton: GitHubBroker | null = null;

export function getGitHubBroker(): GitHubBroker {
  singleton ??= new GitHubBrokerImpl();
  return singleton;
}

/** Test-only reset for fresh singleton state between isolated module tests. */
export function resetGitHubBrokerForTests(): void {
  singleton?.shutdown();
  singleton = null;
}
