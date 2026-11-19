import type { WorkerAgentUsageLimitsHost } from '@canopy/core-runtime/node/agent/providers';
import type {
  AgentUsageOverview,
  ProviderRateLimitSnapshot,
  ProviderUsageSummary,
  UsageFetchErrorKind,
} from '@canopy/protocol/observability';
import type { OpenCodeAccountSnapshot } from '@canopy/protocol/portal';
import type {
  UsageLimitAccount,
  UsageLimitBucket,
  UsageLimitSourceStatus,
  UsageLimitWindow,
  UsageLimitsReadError,
  UsageLimitsSnapshot,
} from '@canopy/protocol/provider-usage';
import type { AccountProxyUsageSnapshot } from '@canopy/desktop-shared/types/account-proxy';
import { CANOPY_IN_PROCESS_WORKER_TARGET_ID } from '@canopy/protocol/canopy-core';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  getAccountProxyUsageProjectionInventory,
  type AccountProxyUsageProjectionInventory,
} from '../account-proxy/service';
import { peekObservabilityService } from '../observability';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1_000;
const NATIVE_QUOTA_PROVIDERS = new Set([
  'claude',
  'codex',
  'cursor',
  'copilot',
]);

const ERROR_MESSAGES: Readonly<Record<UsageFetchErrorKind, string>> = {
  auth: 'Sign in again to read account usage.',
  network: 'The usage service could not be reached.',
  service: 'The usage service returned an error.',
  rate_limited: 'The usage service is temporarily rate limited.',
  unsupported: 'Usage limits are not available for this account.',
  unknown: 'Usage could not be read.',
};

interface DesktopUsageLimitsHostSources {
  readonly getUsageOverview: () => AgentUsageOverview | null;
  readonly getAccountProxyInventory: () => AccountProxyUsageProjectionInventory;
  readonly getAccountProxyUsage: (
    connectionId: string,
    authIndex: string,
  ) => AccountProxyUsageSnapshot | undefined;
  readonly now: () => Date;
}

const desktopSources: DesktopUsageLimitsHostSources = {
  getUsageOverview: () =>
    peekObservabilityService()?.getUsageOverview() ?? null,
  getAccountProxyInventory: getAccountProxyUsageProjectionInventory,
  getAccountProxyUsage: (connectionId, authIndex) =>
    peekObservabilityService()?.getAccountProxyUsage(connectionId, authIndex),
  now: () => new Date(),
};

/** Code-point ordering is deterministic across host locales. */
function compareKeys(
  left: readonly string[],
  right: readonly string[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? '';
    const b = right[index] ?? '';
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function safeText(
  value: string | undefined,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = withoutControlCharacters(value)
    .trim()
    .slice(0, maximum)
    .trim();
  if (
    normalized.length === 0 ||
    normalized.includes('/') ||
    normalized.includes('\\')
  )
    return undefined;
  return normalized;
}

function withoutControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
}

/** Provider model/surface identifiers are not host paths. */
function safeScopeText(
  value: string | null | undefined,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = withoutControlCharacters(value)
    .trim()
    .slice(0, maximum)
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isoTimestamp(value: string | number | undefined): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function curatedError(
  kind: UsageFetchErrorKind,
  retryAt?: string,
): UsageLimitsReadError {
  const normalizedRetryAt = isoTimestamp(retryAt);
  return {
    kind,
    message: ERROR_MESSAGES[kind],
    ...(normalizedRetryAt === undefined ? {} : { retryAt: normalizedRetryAt }),
  };
}

function proxyError(
  inventory: AccountProxyUsageProjectionInventory,
): UsageLimitsReadError | undefined {
  switch (inventory.errorCode) {
    case 'unauthorized':
    case 'blocked':
      return curatedError('auth');
    case 'unreachable':
      return curatedError('network');
    case 'management-disabled':
    case 'remote-management-disabled':
    case 'local-unsupported':
      return curatedError('unsupported');
    case 'invalid-url':
    case 'insecure-url':
    case 'not-proxy':
    case 'too-old':
    case 'storage-unavailable':
    case 'local-failed':
    case 'unexpected':
      return curatedError('service');
    case undefined:
      return undefined;
  }
}

function numeric(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function inferredDuration(
  provider: string,
  limit: ProviderRateLimitSnapshot,
): number | undefined {
  if (provider !== 'claude') return undefined;
  const limitId = (limit.limitId ?? '').toLowerCase();
  if (
    limitId === 'five_hour' ||
    limitId === 'five-hour' ||
    limitId === 'session'
  )
    return FIVE_HOUR_MS;
  if (
    limitId.startsWith('seven_day') ||
    limitId.startsWith('seven-day') ||
    limitId.startsWith('weekly')
  )
    return SEVEN_DAY_MS;
  return undefined;
}

function projectWindow(
  provider: string,
  limit: ProviderRateLimitSnapshot,
  kind: UsageLimitWindow['kind'],
  source: ProviderRateLimitSnapshot['primary'],
): UsageLimitWindow | undefined {
  if (source === undefined) return undefined;
  const result: UsageLimitWindow = { kind };
  if (typeof source.unlimited === 'boolean')
    result.unlimited = source.unlimited;
  const limitValue = numeric(source.limit);
  if (limitValue !== undefined) result.limit = limitValue;
  const remaining = numeric(source.remaining);
  if (remaining !== undefined) result.remaining = remaining;
  const usedPercent = numeric(source.usedPercent);
  if (usedPercent !== undefined) result.usedPercent = usedPercent;
  const resetsAt = isoTimestamp(source.resetsAt);
  if (resetsAt !== undefined) result.resetsAt = resetsAt;
  const reportedDuration = numeric(source.windowDurationMins);
  const convertedDuration =
    reportedDuration !== undefined && reportedDuration > 0
      ? numeric(reportedDuration * 60_000)
      : undefined;
  const windowDurationMs =
    convertedDuration ?? inferredDuration(provider, limit);
  if (windowDurationMs !== undefined)
    result.windowDurationMs = windowDurationMs;
  return Object.keys(result).length > 1 ? result : undefined;
}

function projectScope(
  limit: ProviderRateLimitSnapshot,
): UsageLimitBucket['scope'] {
  const scope: NonNullable<UsageLimitBucket['scope']> = {};
  if (limit.scope?.model !== undefined) {
    scope.model = {
      id: safeScopeText(limit.scope.model.id, 512) ?? null,
      displayName: safeScopeText(limit.scope.model.displayName, 320) ?? null,
    };
  }
  if (limit.scope?.surface !== undefined) {
    scope.surface = safeScopeText(limit.scope.surface, 320) ?? null;
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
}

function projectRateLimits(
  provider: string,
  rateLimits: readonly ProviderRateLimitSnapshot[],
): UsageLimitBucket[] {
  const normalizedProvider = provider.toLowerCase();
  const buckets: UsageLimitBucket[] = [];
  for (const [index, limit] of rateLimits.entries()) {
    const identity =
      `${limit.limitId ?? ''} ${limit.limitName ?? ''}`.toLowerCase();
    if (
      identity.includes('credit') ||
      identity.includes('wallet') ||
      identity.includes('spend') ||
      identity.includes('usd')
    )
      continue;
    const windows = [
      projectWindow(normalizedProvider, limit, 'primary', limit.primary),
      projectWindow(normalizedProvider, limit, 'secondary', limit.secondary),
    ].filter((window): window is UsageLimitWindow => window !== undefined);
    if (windows.length === 0) continue;
    const scope = projectScope(limit);
    buckets.push({
      id: `quota-${index + 1}`,
      label:
        safeText(limit.limitName, 320) ??
        safeText(limit.limitId, 320) ??
        `Usage limit ${index + 1}`,
      ...(scope === undefined ? {} : { scope }),
      windows,
    });
  }
  return buckets;
}

function projectLegacyProxyLimits(
  limits: AccountProxyUsageProjectionInventory['accounts'][number]['legacyLimits'],
): UsageLimitBucket[] {
  const buckets: UsageLimitBucket[] = [];
  for (const limit of limits) {
    const usedPercent = numeric(limit.usedPercent);
    const resetsAt = isoTimestamp(limit.resetsAt ?? undefined);
    buckets.push({
      id: limit.id === 'five-hour' ? 'legacy-five-hour' : 'legacy-weekly',
      label: limit.id === 'five-hour' ? '5-hour' : 'Weekly',
      windows: [
        {
          kind: 'primary',
          ...(usedPercent === undefined ? {} : { usedPercent }),
          ...(resetsAt === undefined ? {} : { resetsAt }),
          windowDurationMs:
            limit.id === 'five-hour' ? FIVE_HOUR_MS : SEVEN_DAY_MS,
        },
      ],
    });
  }
  return buckets;
}

function nativeIdentity(summary: ProviderUsageSummary): string | undefined {
  return (
    safeText(summary.accountEmail, 320) ?? safeText(summary.accountLabel, 320)
  );
}

function nativeAccount(
  summary: ProviderUsageSummary,
  index: number,
): UsageLimitAccount | undefined {
  if (!NATIVE_QUOTA_PROVIDERS.has(summary.provider)) return undefined;
  const label = nativeIdentity(summary);
  if (
    summary.authState !== 'authenticated' &&
    !(summary.authState === 'error' && label)
  )
    return undefined;

  const retryAt = summary.errorInfo?.retryAt;
  const usageObservedAt = isoTimestamp(summary.lastUpdatedAt) ?? null;
  const hasUsageObservation = Array.isArray(summary.rateLimits);
  const error = summary.errorInfo
    ? curatedError(summary.errorInfo.kind, retryAt)
    : summary.authState === 'error'
      ? curatedError('unknown')
      : undefined;
  const state = summary.authState;
  const usageState = hasUsageObservation
    ? 'reported'
    : summary.errorInfo?.kind === 'unsupported'
      ? 'unsupported'
      : 'unavailable';
  const status =
    state === 'error' || (error !== undefined && error.kind !== 'rate_limited')
      ? 'error'
      : error?.kind === 'rate_limited'
        ? 'cooling'
        : 'active';
  const planLabel = safeText(summary.subscriptionLabel, 320);

  return {
    accountId: `native-${summary.provider}-${index + 1}`,
    provider: summary.provider,
    source: 'native',
    ...(label === undefined ? {} : { label }),
    ...(planLabel === undefined ? {} : { planLabel }),
    authState: state,
    status,
    ...(error?.kind === 'rate_limited' && error.retryAt !== undefined
      ? { availableAt: error.retryAt }
      : {}),
    ...(error?.kind === 'auth' ? { needsSignIn: true } : {}),
    inventoryObservedAt: null,
    usageObservedAt,
    usageSource: 'unknown',
    usageState,
    ...(error === undefined ? {} : { error }),
    limits: projectRateLimits(summary.provider, summary.rateLimits ?? []),
  };
}

function proxyAuthState(
  status: AccountProxyUsageProjectionInventory['accounts'][number]['status'],
  usage: AccountProxyUsageSnapshot | undefined,
): UsageLimitAccount['authState'] {
  if (
    usage?.errorInfo?.kind === 'auth' ||
    status === 'error' ||
    status === 'sign-in-required'
  )
    return 'error';
  if (status === 'active' || status === 'cooling' || status === 'refreshing')
    return 'authenticated';
  return 'unknown';
}

function proxyAccount(
  account: AccountProxyUsageProjectionInventory['accounts'][number],
  index: number,
  inventory: AccountProxyUsageProjectionInventory,
  cachedUsage: AccountProxyUsageSnapshot | undefined,
): UsageLimitAccount {
  const hasDetailedObservation =
    cachedUsage !== undefined &&
    (cachedUsage.errorInfo === undefined ||
      cachedUsage.lastUpdatedAt !== undefined ||
      cachedUsage.source === 'passive' ||
      cachedUsage.rateLimits.length > 0);
  const detailedUsage = hasDetailedObservation ? cachedUsage : undefined;
  const legacyLimits = projectLegacyProxyLimits(account.legacyLimits);
  const limits =
    detailedUsage !== undefined
      ? projectRateLimits(account.provider, detailedUsage.rateLimits)
      : legacyLimits;
  const error = cachedUsage?.errorInfo
    ? curatedError(cachedUsage.errorInfo.kind, cachedUsage.errorInfo.retryAt)
    : undefined;
  const supportedProvider =
    account.provider.toLowerCase() === 'claude' ||
    account.provider.toLowerCase() === 'codex';
  const usageState =
    detailedUsage !== undefined || legacyLimits.length > 0
      ? 'reported'
      : error?.kind === 'unsupported' || !supportedProvider
        ? 'unsupported'
        : 'unavailable';
  const usageObservedAt = isoTimestamp(cachedUsage?.lastUpdatedAt) ?? null;
  const availableAt =
    isoTimestamp(account.availableAt ?? undefined) ??
    isoTimestamp(cachedUsage?.retryAt);
  const planLabel =
    safeText(cachedUsage?.planType, 320) ?? safeText(account.planLabel, 320);
  const label =
    account.label === account.authIndex
      ? undefined
      : safeText(account.label, 320);
  return {
    accountId: `account-proxy-${index + 1}`,
    provider: safeText(account.provider, 512) ?? 'unknown',
    source: 'account_proxy',
    ...(label === undefined ? {} : { label }),
    ...(planLabel === undefined ? {} : { planLabel }),
    authState: proxyAuthState(account.status, cachedUsage),
    status: account.status === 'sign-in-required' ? 'error' : account.status,
    ...(account.status === 'cooling' && availableAt !== undefined
      ? { availableAt }
      : {}),
    ...(error?.kind === 'auth' || account.status === 'sign-in-required'
      ? { needsSignIn: true }
      : {}),
    inventoryObservedAt: inventory.observedAt,
    usageObservedAt,
    usageSource:
      detailedUsage !== undefined
        ? detailedUsage.source
        : legacyLimits.length > 0
          ? 'passive'
          : 'unknown',
    usageState,
    ...(error === undefined ? {} : { error }),
    limits,
  };
}

function nativeAccounts(
  overview: AgentUsageOverview | null,
): UsageLimitAccount[] {
  if (overview === null) return [];
  const accounts: UsageLimitAccount[] = [];
  const summaries = [...overview.providers].sort((left, right) =>
    compareKeys(
      [left.provider, nativeIdentity(left) ?? ''],
      [right.provider, nativeIdentity(right) ?? ''],
    ),
  );
  for (const summary of summaries) {
    const projected = nativeAccount(summary, accounts.length);
    if (projected !== undefined) accounts.push(projected);
  }
  return accounts;
}

function nativeInventoryWasObserved(
  overview: AgentUsageOverview | null,
): boolean {
  return (
    overview?.providers.some(
      (summary) =>
        NATIVE_QUOTA_PROVIDERS.has(summary.provider) &&
        (summary.authState === 'authenticated' ||
          summary.authState === 'unauthenticated' ||
          (summary.authState === 'error' &&
            nativeIdentity(summary) !== undefined)),
    ) ?? false
  );
}

function openCodeAccounts(snapshot: OpenCodeAccountSnapshot | undefined): {
  accounts: UsageLimitAccount[];
  source: UsageLimitSourceStatus;
} {
  if (snapshot === undefined) {
    return {
      accounts: [],
      source: { source: 'opencode', state: 'not_observed', observedAt: null },
    };
  }
  const observedAt = isoTimestamp(snapshot.updatedAt) ?? null;
  if (snapshot.status === 'unavailable') {
    return {
      accounts: [],
      source: {
        source: 'opencode',
        state: 'unavailable',
        observedAt: null,
        error: curatedError('service'),
      },
    };
  }

  const accounts: UsageLimitAccount[] = [];
  const providers = [...snapshot.providers].sort((left, right) =>
    compareKeys([left.id], [right.id]),
  );
  for (const [providerIndex, provider] of providers.entries()) {
    // OpenCode exposes display metadata only, not a persistent account ID.
    const metadata = [...provider.accounts].sort((left, right) =>
      compareKeys([left.label, left.method], [right.label, right.method]),
    );
    for (const [accountIndex, account] of metadata.entries()) {
      const label = safeText(account.label, 320);
      accounts.push({
        accountId: `opencode-${providerIndex + 1}-${accountIndex + 1}`,
        provider: safeText(provider.id, 512) ?? 'opencode',
        source: 'opencode',
        ...(label === undefined ? {} : { label }),
        authState: account.needsSignIn ? 'unauthenticated' : 'unknown',
        status: account.needsSignIn
          ? 'pending'
          : account.selected
            ? 'active'
            : 'disabled',
        selected: account.selected,
        needsSignIn: account.needsSignIn,
        inventoryObservedAt: observedAt,
        usageObservedAt: null,
        usageSource: 'unknown',
        usageState: 'unsupported',
        error: curatedError('unsupported'),
        limits: [],
      });
    }
  }
  return {
    accounts,
    source: { source: 'opencode', state: 'observed', observedAt },
  };
}

function sourceCompleteness(
  sources: readonly UsageLimitSourceStatus[],
): UsageLimitsSnapshot['completeness'] {
  return sources.every(
    (source) =>
      source.state === 'observed' || source.state === 'not_configured',
  )
    ? 'complete'
    : 'partial';
}

function getPassiveUsageLimitsSnapshot(
  sources: DesktopUsageLimitsHostSources,
): UsageLimitsSnapshot {
  let overview: AgentUsageOverview | null = null;
  let overviewReadFailed = false;
  try {
    overview = sources.getUsageOverview();
  } catch {
    overviewReadFailed = true;
  }

  let proxyInventory: AccountProxyUsageProjectionInventory;
  try {
    proxyInventory = sources.getAccountProxyInventory();
  } catch {
    proxyInventory = {
      state: 'unavailable',
      observedAt: null,
      accounts: [],
    };
  }

  const native = nativeAccounts(overview);
  const openCode = openCodeAccounts(overview?.openCodeAccounts);
  if (overviewReadFailed) {
    openCode.source = {
      source: 'opencode',
      state: 'unavailable',
      observedAt: null,
      error: curatedError('service'),
    };
  }
  const nativeTimestamps = native
    .map((account) => account.usageObservedAt)
    .filter((value): value is string => value !== null)
    .sort();
  const nativeObservedAt =
    nativeTimestamps[nativeTimestamps.length - 1] ?? null;
  // Failed discovery may have no account identity. It still affects source
  // health even though it must not create an inventory account.
  const failedNativeSummary = overview?.providers.find(
    (summary) =>
      NATIVE_QUOTA_PROVIDERS.has(summary.provider) &&
      (summary.errorInfo !== undefined || summary.authState === 'error'),
  );
  const nativeError = overviewReadFailed
    ? curatedError('service')
    : failedNativeSummary === undefined
      ? undefined
      : curatedError(
          failedNativeSummary.errorInfo?.kind ?? 'unknown',
          failedNativeSummary.errorInfo?.retryAt,
        );
  const nativeSource: UsageLimitSourceStatus = {
    source: 'native',
    state:
      nativeError !== undefined
        ? 'unavailable'
        : native.length > 0 || nativeInventoryWasObserved(overview)
          ? 'observed'
          : 'not_observed',
    observedAt: nativeObservedAt,
    ...(nativeError === undefined ? {} : { error: nativeError }),
  };
  let proxyUsageReadFailed = false;
  let proxyUsageError: UsageLimitsReadError | undefined;
  // Private identities are used only to stabilize ties; never serialize them.
  const proxyInventoryAccounts = [...proxyInventory.accounts].sort(
    (left, right) =>
      compareKeys(
        [left.provider, left.label ?? '', left.connectionId, left.authIndex],
        [
          right.provider,
          right.label ?? '',
          right.connectionId,
          right.authIndex,
        ],
      ),
  );
  const proxyAccounts = proxyInventoryAccounts.map((account, index) => {
    let cachedUsage: AccountProxyUsageSnapshot | undefined;
    try {
      cachedUsage = sources.getAccountProxyUsage(
        account.connectionId,
        account.authIndex,
      );
    } catch {
      cachedUsage = undefined;
      proxyUsageReadFailed = true;
      proxyUsageError ??= curatedError('service');
    }
    if (cachedUsage?.errorInfo !== undefined)
      proxyUsageError ??= curatedError(
        cachedUsage.errorInfo.kind,
        cachedUsage.errorInfo.retryAt,
      );
    return proxyAccount(account, index, proxyInventory, cachedUsage);
  });
  const accountProxyError = proxyUsageError ?? proxyError(proxyInventory);
  const proxyHasReadError =
    proxyUsageReadFailed || proxyUsageError !== undefined;
  const proxySource: UsageLimitSourceStatus = {
    source: 'account_proxy',
    state: proxyHasReadError ? 'unavailable' : proxyInventory.state,
    observedAt: proxyInventory.observedAt,
    ...(accountProxyError !== undefined
      ? { error: accountProxyError }
      : proxyUsageReadFailed
        ? { error: curatedError('service') }
        : {}),
  };
  const sourceStatuses = [nativeSource, proxySource, openCode.source];
  // Stable sort preserves the privately ordered source identities for ties.
  // Assign snapshot-local IDs only after ordering, never from credential keys.
  const accounts = [...native, ...proxyAccounts, ...openCode.accounts]
    .sort((left, right) =>
      compareKeys(
        [left.provider, left.source, left.label ?? ''],
        [right.provider, right.source, right.label ?? ''],
      ),
    )
    .map((account, index) => ({
      ...account,
      accountId: `account-${index + 1}`,
    }));
  return {
    schemaVersion: 1,
    snapshotAt: sources.now().toISOString(),
    accounts,
    sources: sourceStatuses,
    completeness: sourceCompleteness(sourceStatuses),
  };
}

/** Desktop passive usage host. It only peeks already-created memory caches. */
export function createDesktopUsageLimitsHost(
  sourceOverrides?: Partial<DesktopUsageLimitsHostSources>,
): WorkerAgentUsageLimitsHost {
  const sources = { ...desktopSources, ...sourceOverrides };
  return {
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
    get: () => getPassiveUsageLimitsSnapshot(sources),
  };
}
