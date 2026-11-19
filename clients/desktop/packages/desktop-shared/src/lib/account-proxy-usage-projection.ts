/**
 * Portable display projection of provider plan usage, shared by the Remote
 * Control `provider_usage` publication in main and the desktop renderer's
 * account-proxy usage views, so both show the same windows for an account.
 * Only display fields cross: never credential file names, proxy status
 * messages, raw provider errors, or connection data.
 */
import {
  type RemoteControlProviderUsageAccount,
  type RemoteControlProviderUsageCredits,
  type RemoteControlProviderUsageError,
  type RemoteControlProviderUsageErrorKind,
  type RemoteControlProviderUsageWindow,
} from '@canopy/protocol/remote-control/shell';
import { subscriptionLabelForPlanType } from '@canopy/protocol/telemetry';
import type { AgentProviderType } from '../types';
import type {
  AccountProxyAccount,
  AccountProxyLimit,
} from '../types/account-proxy';
import type {
  ProviderCreditsSnapshot,
  ProviderRateLimitSnapshot,
  UsageFetchErrorKind,
} from '@canopy/execution-engine/types/observability';
import { buildProviderUsageWindows } from './provider-usage-windows';
import { usageFetchErrorHeadline } from './usage-fetch-error';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

const LEGACY_LIMITS: Readonly<
  Record<AccountProxyLimit['id'], { label: string; windowDurationMs: number }>
> = {
  'five-hour': { label: '5-hour limit', windowDurationMs: FIVE_HOUR_MS },
  weekly: { label: 'Weekly limit', windowDurationMs: SEVEN_DAY_MS },
};

function finiteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/** An ISO timestamp, or undefined for a missing or invalid time. */
export function toRemoteControlIsoTimestamp(
  value: string | number | null | undefined,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function projectCredits(
  credits: ProviderCreditsSnapshot | undefined,
  creditsAreCount: boolean,
): RemoteControlProviderUsageCredits | undefined {
  if (!credits) {
    return undefined;
  }
  const spent = finiteNumber(credits.usedUsd);
  const remaining = finiteNumber(credits.remainingUsd);
  const total = finiteNumber(credits.totalUsd);
  if (spent === undefined && remaining === undefined && total === undefined) {
    return undefined;
  }
  return {
    unit: creditsAreCount ? 'credits' : 'usd',
    ...(spent === undefined ? {} : { spent }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(total === undefined ? {} : { total }),
  };
}

/**
 * A provider's rate-limit snapshots as portable windows: stable ids, display
 * titles, true durations, and credits. A Codex bucket repeats its balance on
 * both windows; it is carried under the bucket's first window only.
 */
export function projectProviderUsageWindows(
  provider: AgentProviderType,
  rateLimits: readonly ProviderRateLimitSnapshot[] | undefined,
): RemoteControlProviderUsageWindow[] {
  const idCounts = new Map<string, number>();
  const bucketsWithCredits = new Set<string>();
  return buildProviderUsageWindows(provider, rateLimits).map(
    (window): RemoteControlProviderUsageWindow => {
      const occurrence = (idCounts.get(window.key) ?? 0) + 1;
      idCounts.set(window.key, occurrence);
      const bucket = window.key.slice(0, window.key.lastIndexOf('-'));
      const credits = bucketsWithCredits.has(bucket)
        ? undefined
        : projectCredits(window.credits, window.creditsAreCount === true);
      if (credits) {
        bucketsWithCredits.add(bucket);
      }
      const usedPercent = finiteNumber(window.usedPercent);
      const resetsAt = toRemoteControlIsoTimestamp(window.resetsAt);
      const windowDurationMs = finiteNumber(window.windowDurationMs);
      return {
        id: occurrence === 1 ? window.key : `${window.key}-${occurrence}`,
        label: window.unlimited
          ? window.title.replace(/ · Unlimited$/, '')
          : window.title,
        ...(window.unlimited ? { unlimited: true } : {}),
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(windowDurationMs === undefined || windowDurationMs <= 0
          ? {}
          : { windowDurationMs }),
        ...(credits ? { credits } : {}),
        ...(window.spend ? { spend: window.spend } : {}),
      };
    },
  );
}

/**
 * The wire kinds predate `rate_limited`; older clients read a throttled read
 * as a transient service failure, while the curated headline stays specific.
 */
export function remoteControlProviderUsageErrorKind(
  kind: UsageFetchErrorKind,
): RemoteControlProviderUsageErrorKind {
  return kind === 'rate_limited' ? 'service' : kind;
}

/** Curated copy for a failed read; never the raw provider message. */
export function projectProviderUsageError(
  kind: UsageFetchErrorKind,
  providerLabel: string,
): RemoteControlProviderUsageError {
  return {
    kind: remoteControlProviderUsageErrorKind(kind),
    message: usageFetchErrorHeadline(kind, providerLabel),
  };
}

/** The account fields the projection reads. */
export type AccountProxyUsageProjectionInput = Pick<
  AccountProxyAccount,
  | 'authIndex'
  | 'provider'
  | 'label'
  | 'source'
  | 'planType'
  | 'status'
  | 'availableAt'
  | 'limits'
  | 'usage'
>;

function providerLabel(provider: string): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function planLabel(account: AccountProxyUsageProjectionInput): string | null {
  if (account.source === 'api-key') return 'API key';
  if (account.provider === 'claude' || account.provider === 'codex') {
    return subscriptionLabelForPlanType(account.provider, account.planType);
  }
  return null;
}

function legacyWindows(
  limits: readonly AccountProxyLimit[],
): RemoteControlProviderUsageWindow[] {
  return limits.map((limit): RemoteControlProviderUsageWindow => {
    const legacy = LEGACY_LIMITS[limit.id];
    const usedPercent = finiteNumber(limit.usedPercent);
    const resetsAt = toRemoteControlIsoTimestamp(limit.resetsAt);
    return {
      id: limit.id,
      label: legacy.label,
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      windowDurationMs: legacy.windowDurationMs,
    };
  });
}

function usageProviderType(provider: string): AgentProviderType | null {
  return provider === 'claude' || provider === 'codex' ? provider : null;
}

/**
 * One account-proxy account as portable display data. A present usage
 * snapshot is authoritative even with no windows; the proxy's own reported
 * limits are used only when the account has no snapshot. With neither, the
 * account has no windows and no source: usage is unavailable, never 0%.
 * A failed read keeps the last known windows beside its curated error.
 */
export function projectAccountProxyUsageAccount(
  account: AccountProxyUsageProjectionInput,
): RemoteControlProviderUsageAccount {
  const plan = planLabel(account);
  const availableAt = toRemoteControlIsoTimestamp(account.availableAt);
  const identity = {
    id: account.authIndex,
    ...(account.label ? { label: account.label } : {}),
    ...(plan ? { planLabel: plan } : {}),
    // Older hosts know no sign-in status; they show this one as an error.
    ...(account.status === 'sign-in-required'
      ? { status: 'error' as const, signInRequired: true as const }
      : { status: account.status }),
    ...(availableAt === undefined ? {} : { availableAt }),
  };
  const usage = account.usage;
  if (usage === undefined) {
    const windows = legacyWindows(account.limits);
    return {
      ...identity,
      ...(windows.length > 0 ? { usageSource: 'passive' as const } : {}),
      windows,
    };
  }
  const provider = usageProviderType(account.provider);
  const windows =
    provider === null
      ? []
      : projectProviderUsageWindows(provider, usage.rateLimits);
  const lastUpdatedAt = toRemoteControlIsoTimestamp(usage.lastUpdatedAt);
  const retryAt = toRemoteControlIsoTimestamp(usage.retryAt);
  return {
    ...identity,
    usageSource: usage.source,
    ...(lastUpdatedAt === undefined ? {} : { lastUpdatedAt }),
    ...(usage.errorInfo
      ? {
          error: projectProviderUsageError(
            usage.errorInfo.kind,
            providerLabel(account.provider),
          ),
        }
      : {}),
    ...(retryAt === undefined ? {} : { retryAt }),
    windows,
  };
}
