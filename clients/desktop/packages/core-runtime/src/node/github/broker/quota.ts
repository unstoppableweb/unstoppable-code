import { normalizeGitHubHeaders, type GitHubHeaders } from './rate-limit';
import type { GitHubRequestPriority } from './scheduler';

/**
 * GitHub's quota buckets: `core` for REST, `graphql` for GraphQL points, and
 * smaller ones such as `search`. Each is spent and reset on its own.
 */
export type GitHubRateLimitResource = string;

export const DEFAULT_GITHUB_RATE_LIMIT_RESOURCE: GitHubRateLimitResource =
  'core';

/**
 * Share of a bucket each priority leaves untouched. Agents spend from the same
 * token, so background work stops well before the last tenth that watchers
 * may spend, and only interactive requests may go below that.
 */
export const GITHUB_QUOTA_RESERVE_RATIOS: Readonly<
  Record<GitHubRequestPriority, number>
> = {
  background: 0.3,
  watcher: 0.1,
  interactive: 0,
};

export const UNLABELED_GITHUB_CALLER = 'unlabeled';
export const GITHUB_SPEND_WINDOW_MS = 60 * 60_000;

export interface GitHubQuotaSnapshot {
  resource: GitHubRateLimitResource;
  limit: number;
  remaining: number;
  resetAtMs: number;
}

/** The bucket a response reports, or null when its headers name none. */
export function readGitHubQuota(
  headers: GitHubHeaders | undefined,
): GitHubQuotaSnapshot | null {
  const normalized = normalizeGitHubHeaders(headers);
  const resource = normalized['x-ratelimit-resource']?.trim();
  const limit = Number(normalized['x-ratelimit-limit']);
  const remaining = Number(normalized['x-ratelimit-remaining']);
  const reset = Number(normalized['x-ratelimit-reset']);
  if (
    !resource ||
    normalized['x-ratelimit-limit'] === undefined ||
    normalized['x-ratelimit-remaining'] === undefined ||
    normalized['x-ratelimit-reset'] === undefined ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    !Number.isFinite(remaining) ||
    remaining < 0 ||
    !Number.isFinite(reset)
  ) {
    return null;
  }
  return { resource, limit, remaining, resetAtMs: reset * 1000 };
}

/**
 * What GitHub last said is left of each bucket, per credential scope. The
 * numbers are GitHub's own, so they include what agents spent through `gh`
 * with the same token. Nothing is debited locally: a 304 or a request that
 * never reached GitHub spends nothing, and a local count would drift.
 */
export class GitHubQuotaLedger {
  private snapshots = new Map<string, GitHubQuotaSnapshot>();

  /** Record one response's headers; returns the snapshot when it was kept. */
  observe(
    scope: string,
    headers: GitHubHeaders | undefined,
  ): GitHubQuotaSnapshot | null {
    const quota = readGitHubQuota(headers);
    if (!quota) return null;
    const key = ledgerKey(scope, quota.resource);
    const previous = this.snapshots.get(key);
    // GitHub answers from several regions, so a later answer can report more
    // left in the same window; keeping the lower count would hold background
    // work at the reserve until the reset. An answer from an older window
    // says nothing about this one.
    if (previous && quota.resetAtMs < previous.resetAtMs) return null;
    this.snapshots.set(key, quota);
    return quota;
  }

  /** The current window's snapshot; undefined once the window has reset. */
  get(
    scope: string,
    resource: GitHubRateLimitResource,
    nowMs: number,
  ): GitHubQuotaSnapshot | undefined {
    const snapshot = this.snapshots.get(ledgerKey(scope, resource));
    return snapshot && snapshot.resetAtMs > nowMs ? snapshot : undefined;
  }

  /**
   * When a request of this priority may be sent again, or null when it may be
   * sent now. Interactive requests may spend the whole reserve, but not a
   * bucket GitHub already reported empty.
   */
  refusedUntil(
    scope: string,
    resource: GitHubRateLimitResource,
    priority: GitHubRequestPriority,
    nowMs: number,
  ): number | null {
    const snapshot = this.get(scope, resource, nowMs);
    if (!snapshot) return null;
    const floor = Math.max(
      1,
      snapshot.limit * GITHUB_QUOTA_RESERVE_RATIOS[priority],
    );
    return snapshot.remaining < floor ? snapshot.resetAtMs : null;
  }

  list(nowMs: number): GitHubQuotaSnapshot[] {
    return Array.from(this.snapshots.values()).filter(
      (snapshot) => snapshot.resetAtMs > nowMs,
    );
  }

  clear(): void {
    this.snapshots.clear();
  }
}

function ledgerKey(scope: string, resource: GitHubRateLimitResource): string {
  return `${scope}\0${resource}`;
}

export interface GitHubSpendEntry {
  caller: string;
  priority: GitHubRequestPriority;
  resource: GitHubRateLimitResource;
  /** Responses GitHub returned, including 304s and errors. */
  requests: number;
  /** 304 responses, which cost no quota. */
  notModified: number;
}

export interface GitHubSpendSummary {
  windowStartedAt: string;
  entries: GitHubSpendEntry[];
}

/**
 * Requests that reached GitHub, per caller, priority, and bucket. One summary
 * line is logged per window instead of one line per request.
 */
export class GitHubSpendCounters {
  private entries = new Map<string, GitHubSpendEntry>();
  private windowStartedAt: number | null = null;

  constructor(
    private readonly log: (message: string) => void,
    private readonly windowMs = GITHUB_SPEND_WINDOW_MS,
  ) {}

  record(
    request: {
      caller?: string;
      priority: GitHubRequestPriority;
      resource: GitHubRateLimitResource;
      notModified: boolean;
    },
    nowMs: number,
    quota: () => GitHubQuotaSnapshot[],
  ): void {
    if (
      this.windowStartedAt !== null &&
      nowMs - this.windowStartedAt >= this.windowMs
    ) {
      this.flush(nowMs, quota());
    }
    this.windowStartedAt ??= nowMs;
    const caller = request.caller ?? UNLABELED_GITHUB_CALLER;
    const key = `${caller}\0${request.priority}\0${request.resource}`;
    const entry = this.entries.get(key) ?? {
      caller,
      priority: request.priority,
      resource: request.resource,
      requests: 0,
      notModified: 0,
    };
    entry.requests += 1;
    if (request.notModified) entry.notModified += 1;
    this.entries.set(key, entry);
  }

  /** Log the current window and start a new one. */
  flush(nowMs: number, quota: GitHubQuotaSnapshot[]): void {
    if (this.windowStartedAt === null || this.entries.size === 0) {
      this.windowStartedAt = null;
      return;
    }
    const minutes = Math.max(
      1,
      Math.round((nowMs - this.windowStartedAt) / 60_000),
    );
    this.log(
      formatGitHubSpendSummary(
        Array.from(this.entries.values()),
        minutes,
        quota,
      ),
    );
    this.entries.clear();
    this.windowStartedAt = null;
  }

  summary(): GitHubSpendSummary | null {
    if (this.windowStartedAt === null) return null;
    return {
      windowStartedAt: new Date(this.windowStartedAt).toISOString(),
      entries: Array.from(this.entries.values()).map((entry) => ({
        ...entry,
      })),
    };
  }
}

export function formatGitHubSpendSummary(
  entries: readonly GitHubSpendEntry[],
  minutes: number,
  quota: readonly GitHubQuotaSnapshot[],
): string {
  const byResource = new Map<string, GitHubSpendEntry[]>();
  for (const entry of entries) {
    const group = byResource.get(entry.resource) ?? [];
    group.push(entry);
    byResource.set(entry.resource, group);
  }
  const resources = Array.from(byResource.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([resource, group]) => {
      const total = group.reduce((sum, entry) => sum + entry.requests, 0);
      const notModified = group.reduce(
        (sum, entry) => sum + entry.notModified,
        0,
      );
      const callers = [...group]
        .sort(
          (left, right) =>
            right.requests - left.requests ||
            left.caller.localeCompare(right.caller),
        )
        .map((entry) => `${entry.caller}/${entry.priority} ${entry.requests}`)
        .join(', ');
      return `${resource} ${total} (${callers}; ${notModified} not modified)`;
    })
    .join('; ');
  const remaining = [...quota]
    .sort((left, right) => left.resource.localeCompare(right.resource))
    .map(
      (snapshot) =>
        `${snapshot.resource} ${snapshot.remaining}/${snapshot.limit}`,
    )
    .join(', ');
  return `[github-broker] GitHub requests in the last ${minutes} min: ${resources}.${
    remaining ? ` Remaining: ${remaining}.` : ''
  }`;
}
