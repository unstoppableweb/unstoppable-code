import type {
  AgentProviderType,
  AgentUsageOverview,
  ProviderUsageSummary,
  UsageLimitResumeInterruption,
} from '../types';

export const USAGE_RESUME_EXPIRY_MS = 7 * 24 * 60 * 60_000;
export const USAGE_RESUME_FRESHNESS_MS = 30_000;
/** Run-failure messages a stopped usage check records; hosts match on them. */
export const USAGE_RESUME_UNCHECKABLE =
  'The interrupted provider account’s usage could not be checked.';
export const USAGE_RESUME_EXPIRED = 'Usage did not clear within seven days.';
export const USAGE_RESUME_NOT_PENDING = 'This resume is no longer pending.';
const RETRY_FLOOR_MS = 60_000;
const DEFAULT_RETRY_MS = 15 * 60_000;

function parseFutureTime(value: unknown, now: number): number | null {
  const time =
    typeof value === 'string' && value.trim()
      ? Date.parse(value)
      : typeof value === 'number'
        ? new Date(value < 1_000_000_000_000 ? value * 1000 : value).getTime()
        : NaN;
  return Number.isFinite(time) && time > now ? time : null;
}

export function normalizeUsageResumeAccount(
  email: string | undefined,
): string | undefined {
  return email?.trim().toLowerCase() || undefined;
}

export type UsageLimitResumeOutlook =
  | { kind: 'uncheckable' }
  | { kind: 'recheck'; retryAt?: string }
  | { kind: 'reset'; runAt: string }
  | { kind: 'clear' };

export function classifyUsageLimitResume({
  interruption,
  summary,
  now,
  freshnessMs,
  refreshFailed,
  currentAccountEmail,
}: {
  interruption: UsageLimitResumeInterruption | undefined;
  summary: ProviderUsageSummary | undefined;
  now: number;
  freshnessMs: number;
  refreshFailed?: boolean;
  currentAccountEmail: string | undefined;
}): UsageLimitResumeOutlook {
  const accountEmail = normalizeUsageResumeAccount(interruption?.accountEmail);
  const currentAccount = normalizeUsageResumeAccount(currentAccountEmail);
  if (
    !interruption ||
    !Number.isFinite(interruption.detectedAt) ||
    interruption.detectedAt <= 0 ||
    interruption.detectedAt > now ||
    !interruption.userMessageId ||
    !accountEmail ||
    (currentAccount !== undefined && accountEmail !== currentAccount)
  ) {
    return { kind: 'uncheckable' };
  }
  if (!summary)
    return refreshFailed || currentAccount
      ? { kind: 'recheck' }
      : { kind: 'uncheckable' };
  const summaryAccount = normalizeUsageResumeAccount(summary.accountEmail);
  if (
    summary.provider !== interruption.provider ||
    (summaryAccount && summaryAccount !== accountEmail) ||
    summary.authState === 'unauthenticated' ||
    summary.errorInfo?.kind === 'auth' ||
    summary.errorInfo?.kind === 'unsupported'
  )
    return { kind: 'uncheckable' };
  if (summary.error !== undefined || summary.errorInfo !== undefined) {
    return currentAccount || refreshFailed
      ? { kind: 'recheck', retryAt: summary.errorInfo?.retryAt }
      : { kind: 'uncheckable' };
  }
  if (refreshFailed) return { kind: 'recheck' };
  if (!currentAccount) return { kind: 'uncheckable' };
  const updatedAt = Date.parse(summary.lastUpdatedAt ?? '');
  if (
    !summaryAccount ||
    summary.authState !== 'authenticated' ||
    !Number.isFinite(updatedAt) ||
    updatedAt < interruption.detectedAt ||
    updatedAt > now ||
    !Number.isFinite(freshnessMs) ||
    freshnessMs < 0 ||
    now - updatedAt > freshnessMs
  ) {
    return { kind: 'recheck' };
  }
  let usable = false;
  let latestReset = 0;
  for (const snapshot of summary.rateLimits ?? []) {
    for (const window of [snapshot.primary, snapshot.secondary]) {
      if (!window) continue;
      const percent = window.usedPercent;
      const remaining = window.remaining;
      const hasPercent =
        typeof percent === 'number' && Number.isFinite(percent) && percent >= 0;
      const hasRemaining =
        typeof remaining === 'number' &&
        Number.isFinite(remaining) &&
        remaining >= 0;
      if (!hasPercent && !hasRemaining && window.unlimited !== true) continue;
      usable = true;
      if (
        window.unlimited === true ||
        !((hasPercent && percent >= 100) || (hasRemaining && remaining === 0))
      )
        continue;
      const reset = parseFutureTime(window.resetsAt, now);
      if (reset === null) return { kind: 'recheck' };
      latestReset = Math.max(latestReset, reset);
    }
  }
  if (!usable) return { kind: 'uncheckable' };
  return latestReset
    ? { kind: 'reset', runAt: new Date(latestReset).toISOString() }
    : { kind: 'clear' };
}

export function nextUsageLimitResumeCheckAt({
  now,
  createdAt,
  retryAt,
  bannerResetAt,
  usageResetAt,
}: {
  now: number;
  createdAt: number;
  retryAt?: string;
  bannerResetAt?: string | number;
  usageResetAt?: string;
}): string {
  const retry = parseFutureTime(retryAt, now);
  const banner = parseFutureTime(bannerResetAt, now);
  const reset = parseFutureTime(usageResetAt, now);
  const next = Math.max(
    retry === null ? 0 : Math.max(retry, now + RETRY_FLOOR_MS),
    banner ?? 0,
    reset ?? 0,
  );
  return new Date(
    Math.min(
      createdAt + USAGE_RESUME_EXPIRY_MS,
      next || now + DEFAULT_RETRY_MS,
    ),
  ).toISOString();
}

export function selectProviderUsageLimitResumeAt(
  usage: AgentUsageOverview,
  provider: AgentProviderType,
  now: Date = new Date(),
): string | null {
  const summary = usage.providers.find(
    (candidate) => candidate.provider === provider,
  );
  let latestReset = -Infinity;
  for (const snapshot of summary?.rateLimits ?? []) {
    for (const window of [snapshot.primary, snapshot.secondary]) {
      if (
        !window ||
        typeof window.usedPercent !== 'number' ||
        window.usedPercent < 100
      )
        continue;
      const reset = parseFutureTime(window.resetsAt, now.getTime());
      if (reset !== null) latestReset = Math.max(latestReset, reset);
    }
  }
  return latestReset === -Infinity ? null : new Date(latestReset).toISOString();
}
