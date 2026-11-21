import {
  antigravityAccountSnapshotSchema,
  openCodeAccountSnapshotSchema,
} from '@canopy/protocol/remote-control/shell';
/**
 * Remote Control projection of the desktop's provider plan usage (CAN-3635).
 * The observability service stays the only usage authority; this module maps
 * its cached overview, plus the multi-account proxy's accounts while the proxy
 * serves a provider, into the portable `provider_usage` singleton.
 */
import type {
  AgentUsageOverview,
  ProviderUsageSummary,
  UsageFetchErrorKind,
} from '@canopy/desktop-shared/types';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import {
  REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_LABEL_LENGTH,
  REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS,
  REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNTS,
  REMOTE_CONTROL_PROVIDER_USAGE_PROVIDERS,
  type RemoteControlProviderUsageAccount,
  type RemoteControlProviderUsageEntry,
  type RemoteControlProviderUsageProjection,
  type RemoteControlProviderUsageProvider,
} from '@canopy/protocol/remote-control/shell';
import {
  accountProxyAccountsForHarness,
  resolveProviderAccountSource,
  type AccountProxyHarness,
} from '@canopy/desktop-shared/lib/account-proxy';
import {
  projectAccountProxyUsageAccount,
  projectProviderUsageError,
  projectProviderUsageWindows,
  toRemoteControlIsoTimestamp,
} from '@canopy/desktop-shared/lib/account-proxy-usage-projection';
import { classifyUsageFetchErrorMessage } from '@canopy/desktop-shared/lib/usage-fetch-error';
import { getAccountProxyStatus } from '../account-proxy/service';
import { isAiCreditsChosenOverAccountProxy } from '../agents/ai-credits-routing';
import { logMainProcessError } from '../lib/main-process-logging';

const PROVIDER_LABELS: Record<RemoteControlProviderUsageProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
};

/** The multi-account proxy state a projection reads, without provider I/O. */
export interface RemoteControlProviderUsageAccountProxySource {
  readonly status: AccountProxyStatus | null;
  /** AI Credits outrank the proxy for the device's new work. */
  readonly aiCreditsChosen: boolean;
}

function fetchErrorKind(
  summary: ProviderUsageSummary,
): UsageFetchErrorKind | undefined {
  if (summary.errorInfo) {
    return summary.errorInfo.kind;
  }
  if (summary.error) {
    return classifyUsageFetchErrorMessage(summary.error);
  }
  return summary.authState === 'error' ? 'unknown' : undefined;
}

function projectEntry(
  provider: RemoteControlProviderUsageProvider,
  summary: ProviderUsageSummary | undefined,
): RemoteControlProviderUsageEntry {
  if (!summary) {
    return { provider, authState: 'unknown', windows: [] };
  }
  const lastUpdatedAt = toRemoteControlIsoTimestamp(summary.lastUpdatedAt);
  const base = {
    provider,
    ...(lastUpdatedAt === undefined ? {} : { lastUpdatedAt }),
  };
  if (summary.authState === 'unauthenticated') {
    return { ...base, authState: 'unauthenticated', windows: [] };
  }
  const account = {
    ...(provider === 'copilot' && summary.accountLabel
      ? { accountLabel: summary.accountLabel }
      : {}),
    ...(summary.accountEmail ? { accountEmail: summary.accountEmail } : {}),
    ...(summary.subscriptionLabel
      ? { planLabel: summary.subscriptionLabel }
      : {}),
  };
  const errorKind = fetchErrorKind(summary);
  if (errorKind === 'rate_limited') {
    const windows = projectProviderUsageWindows(provider, summary.rateLimits);
    if (windows.length > 0) {
      return { ...base, ...account, authState: 'authenticated', windows };
    }
  }
  if (errorKind !== undefined) {
    // Only curated copy crosses the wire: never the raw provider message,
    // its diagnostics detail or a credential-store explanation.
    return {
      ...base,
      ...account,
      authState: 'error',
      error: projectProviderUsageError(errorKind, PROVIDER_LABELS[provider]),
      windows: [],
    };
  }
  return {
    ...base,
    ...account,
    authState:
      summary.authState === 'authenticated' ? 'authenticated' : 'unknown',
    windows: projectProviderUsageWindows(provider, summary.rateLimits),
  };
}

function accountProxyHarness(
  provider: RemoteControlProviderUsageProvider,
): AccountProxyHarness | null {
  return provider === 'claude' || provider === 'codex' ? provider : null;
}

/**
 * Whether the proxy serves a provider's new work on this device, as main
 * routes it: AI Credits chosen over the proxy come first, then the proxy's
 * connection, routing, and local runtime. The usage refresh
 * (`provider-usage-refresh.ts`) routes by the same rule.
 */
export function isRemoteControlProviderUsageServedByAccountProxy(
  provider: RemoteControlProviderUsageProvider,
  source: RemoteControlProviderUsageAccountProxySource | undefined,
): source is RemoteControlProviderUsageAccountProxySource & {
  readonly status: AccountProxyStatus;
} {
  const harness = accountProxyHarness(provider);
  return (
    harness !== null &&
    source !== undefined &&
    source.status !== null &&
    !source.aiCreditsChosen &&
    resolveProviderAccountSource({
      status: source.status,
      harness,
      aiCreditsRoutingMode: null,
    }) === 'account-proxy'
  );
}

/**
 * The proxy's accounts for a provider while the proxy serves its work on this
 * device; undefined when the native sign-in applies.
 */
function projectAccounts(
  provider: RemoteControlProviderUsageProvider,
  source: RemoteControlProviderUsageAccountProxySource | undefined,
): RemoteControlProviderUsageAccount[] | undefined {
  const harness = accountProxyHarness(provider);
  if (
    harness === null ||
    !isRemoteControlProviderUsageServedByAccountProxy(provider, source)
  ) {
    return undefined;
  }
  const seen = new Set<string>();
  const accounts: RemoteControlProviderUsageAccount[] = [];
  for (const account of accountProxyAccountsForHarness(
    source.status.accounts,
    harness,
  )) {
    if (accounts.length >= REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNTS) break;
    if (seen.has(account.authIndex)) continue;
    seen.add(account.authIndex);
    accounts.push(boundForWire(projectAccountProxyUsageAccount(account)));
  }
  return accounts;
}

function boundLabel(label: string | undefined): string | undefined {
  return label === undefined
    ? undefined
    : label.slice(0, REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_LABEL_LENGTH);
}

/**
 * The wire bounds only, so one long label or a large window list never
 * invalidates the whole projection; the desktop's own views show it all.
 */
function boundForWire(
  account: RemoteControlProviderUsageAccount,
): RemoteControlProviderUsageAccount {
  const label = boundLabel(account.label);
  const planLabel = boundLabel(account.planLabel);
  return {
    ...account,
    ...(label === undefined ? {} : { label }),
    ...(planLabel === undefined ? {} : { planLabel }),
    windows: account.windows.slice(
      0,
      REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS,
    ),
  };
}

/**
 * Map the desktop usage overview to the portable projection: the current
 * Claude and Codex accounts plus Copilot when its host gate supplies a summary.
 * While the multi-account proxy serves Claude or Codex, that entry also lists
 * the proxy's accounts. Excludes Cursor, retained accounts, plan tiers and
 * raw provider responses.
 */
export function projectRemoteControlProviderUsage(
  overview: AgentUsageOverview,
  accountProxy?: RemoteControlProviderUsageAccountProxySource,
): RemoteControlProviderUsageProjection {
  return {
    updatedAt: overview.updatedAt,
    ...(overview.openCodeAccounts
      ? {
          openCodeAccounts: openCodeAccountSnapshotSchema.parse(
            overview.openCodeAccounts,
          ),
        }
      : {}),
    ...antigravityAccountField(overview),
    providers: REMOTE_CONTROL_PROVIDER_USAGE_PROVIDERS.filter(
      (provider) =>
        provider !== 'copilot' ||
        overview.providers.some((summary) => summary.provider === 'copilot'),
    ).map((provider) => {
      const entry = projectEntry(
        provider,
        overview.providers.find((summary) => summary.provider === provider),
      );
      const accounts = projectAccounts(provider, accountProxy);
      return accounts === undefined ? entry : { ...entry, accounts };
    }),
  };
}

/** Plan metadata only; an invalid snapshot is withheld, never the quotas. */
function antigravityAccountField(
  overview: AgentUsageOverview,
): Pick<RemoteControlProviderUsageProjection, 'antigravityAccount'> {
  if (!overview.antigravityAccount) return {};
  const parsed = antigravityAccountSnapshotSchema.safeParse(
    overview.antigravityAccount,
  );
  return parsed.success ? { antigravityAccount: parsed.data } : {};
}

/**
 * The proxy state the projection reads: the last account list and the
 * canonical usage merged into it, never a new read from the proxy or the
 * providers. A failed read withdraws the proxy's accounts.
 */
export async function readRemoteControlProviderUsageAccountProxySource(): Promise<RemoteControlProviderUsageAccountProxySource> {
  let status: AccountProxyStatus | null = null;
  try {
    status = await getAccountProxyStatus({ refresh: false });
  } catch (error: unknown) {
    logMainProcessError('Provider usage proxy status failed', error);
  }
  return {
    status,
    aiCreditsChosen: isAiCreditsChosenOverAccountProxy(undefined),
  };
}
