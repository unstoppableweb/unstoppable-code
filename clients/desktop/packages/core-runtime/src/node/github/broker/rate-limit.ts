export type GitHubHeaderValue = string | number | string[] | undefined;
export type GitHubHeaders = Record<string, GitHubHeaderValue>;

export interface GitHubRateLimitSnapshot {
  limit?: number;
  remaining?: number;
  used?: number;
  resetAt?: string;
  resource?: string;
}

export interface GitHubRateLimitState {
  kind: 'primary' | 'secondary';
  retryAt: string;
  retryAfterSeconds: number;
  resource?: string;
  snapshot: GitHubRateLimitSnapshot;
}

export type GitHubRateLimitClassification =
  | {
      kind: 'primary';
      retryAtMs: number;
      snapshot: GitHubRateLimitSnapshot;
    }
  | {
      kind: 'secondary';
      retryAtMs: number;
      retryAfterSeconds: number;
      snapshot: GitHubRateLimitSnapshot;
    };

const SECONDARY_LIMIT_PATTERNS = [
  /secondary rate limit/i,
  /abuse detection/i,
  /temporarily blocked/i,
  /please wait a few minutes/i,
  /submitted too quickly/i,
];

export const SECONDARY_FALLBACK_DELAYS_MS = [60_000, 120_000, 240_000];
export const SAFE_READ_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
export const MIN_POLL_INTERVAL_MS = 1_000;
export const MAX_POLL_INTERVAL_MS = 5 * 60_000;

export function normalizeGitHubHeaders(
  headers: GitHubHeaders | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    normalized[name.toLowerCase()] = Array.isArray(value)
      ? value.join(', ')
      : String(value);
  }
  return normalized;
}

function parseFiniteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readRateLimitSnapshot(
  headers: GitHubHeaders | undefined,
): GitHubRateLimitSnapshot {
  const normalized = normalizeGitHubHeaders(headers);
  const resetEpoch = parseFiniteNumber(normalized['x-ratelimit-reset']);
  return {
    ...(parseFiniteNumber(normalized['x-ratelimit-limit']) !== undefined
      ? { limit: parseFiniteNumber(normalized['x-ratelimit-limit']) }
      : {}),
    ...(parseFiniteNumber(normalized['x-ratelimit-remaining']) !== undefined
      ? { remaining: parseFiniteNumber(normalized['x-ratelimit-remaining']) }
      : {}),
    ...(parseFiniteNumber(normalized['x-ratelimit-used']) !== undefined
      ? { used: parseFiniteNumber(normalized['x-ratelimit-used']) }
      : {}),
    ...(resetEpoch !== undefined
      ? { resetAt: new Date(resetEpoch * 1000).toISOString() }
      : {}),
    ...(normalized['x-ratelimit-resource']
      ? { resource: normalized['x-ratelimit-resource'] }
      : {}),
  };
}

export function parsePollIntervalMs(
  headers: GitHubHeaders | undefined,
): number | undefined {
  const normalized = normalizeGitHubHeaders(headers);
  const seconds = parseFiniteNumber(normalized['x-poll-interval']);
  if (seconds === undefined || seconds < 0) return undefined;
  return Math.min(
    MAX_POLL_INTERVAL_MS,
    Math.max(MIN_POLL_INTERVAL_MS, Math.round(seconds * 1000)),
  );
}

export function retryAfterMs(
  value: string | undefined,
  nowMs: number,
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

/**
 * A primary limit (`kind: 'primary'`) empties one bucket and pauses only that
 * bucket; secondary throttling is account-wide. GraphQL reports an empty
 * point bucket as a `RATE_LIMITED` error, usually with HTTP 200, so
 * `graphQlRateLimited` makes it primary even without `remaining: 0`.
 */
export function classifyGitHubRateLimit(options: {
  status: number | undefined;
  headers?: GitHubHeaders;
  message?: string;
  secondaryRetryIndex: number;
  graphQlRateLimited?: boolean;
  nowMs?: number;
  random?: () => number;
}): GitHubRateLimitClassification | null {
  const graphQlRateLimited = options.graphQlRateLimited === true;
  if (options.status !== 403 && options.status !== 429 && !graphQlRateLimited) {
    return null;
  }
  const nowMs = options.nowMs ?? Date.now();
  const headers = normalizeGitHubHeaders(options.headers);
  const snapshot = readRateLimitSnapshot(options.headers);
  const resetEpoch = parseFiniteNumber(headers['x-ratelimit-reset']);
  const random = options.random ?? Math.random;
  const fallbackIndex = Math.min(
    options.secondaryRetryIndex,
    SECONDARY_FALLBACK_DELAYS_MS.length - 1,
  );

  if (
    resetEpoch !== undefined &&
    (headers['x-ratelimit-remaining'] === '0' ||
      (graphQlRateLimited && resetEpoch * 1000 > nowMs))
  ) {
    return {
      kind: 'primary',
      retryAtMs: Math.max(nowMs, resetEpoch * 1000 + 1000),
      snapshot,
    };
  }
  if (graphQlRateLimited) {
    const delayMs = Math.max(
      1000,
      Math.round(
        SECONDARY_FALLBACK_DELAYS_MS[fallbackIndex] * (0.8 + random() * 0.4),
      ),
    );
    return { kind: 'primary', retryAtMs: nowMs + delayMs, snapshot };
  }

  const retryMs = retryAfterMs(headers['retry-after'], nowMs);
  const hasSecondaryText = SECONDARY_LIMIT_PATTERNS.some((pattern) =>
    pattern.test(options.message ?? ''),
  );
  if (retryMs === undefined && !hasSecondaryText && options.status !== 429) {
    return null;
  }

  const baseDelay = retryMs ?? SECONDARY_FALLBACK_DELAYS_MS[fallbackIndex];
  if (baseDelay === undefined) return null;
  const jitter = retryMs === undefined ? 0.8 + random() * 0.4 : 1;
  const delayMs = Math.max(1000, Math.round(baseDelay * jitter));
  return {
    kind: 'secondary',
    retryAtMs: nowMs + delayMs,
    retryAfterSeconds: Math.ceil(delayMs / 1000),
    snapshot,
  };
}

export function withJitter(
  delayMs: number,
  random: () => number = Math.random,
  fraction = 0.2,
): number {
  const multiplier = 1 - fraction + random() * fraction * 2;
  return Math.max(0, Math.round(delayMs * multiplier));
}
