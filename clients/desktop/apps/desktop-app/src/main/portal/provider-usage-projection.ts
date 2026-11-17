import {
  antigravityAccountSnapshotSchema,
  openCodeAccountSnapshotSchema,
} from '@canopy/protocol/portal';
/**
 * Remote Control projection of the desktop's provider plan usage (CAN-3635).
 * The observability service stays the only usage authority; this module maps
 * its cached overview, plus the multi-account proxy's accounts while the proxy
 * serves a provider, into the portable `provider_usage` singleton and
 * republishes it as an overview delta whenever either changes.
 */
import type {
  AgentUsageOverview,
  PortalEntityEnvelope,
  PortalEventEnvelope,
  ProviderUsageSummary,
  UsageFetchErrorKind,
} from '@canopy/desktop-shared/types';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import {
  PORTAL_PROVIDER_USAGE_LOCAL_ID,
  PORTAL_PROVIDER_USAGE_MAX_ACCOUNT_LABEL_LENGTH,
  PORTAL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS,
  PORTAL_PROVIDER_USAGE_MAX_ACCOUNTS,
  PORTAL_PROVIDER_USAGE_PROVIDERS,
  type PortalProviderUsageAccount,
  type PortalProviderUsageEntry,
  type PortalProviderUsageProjection,
  type PortalProviderUsageProvider,
} from '@canopy/protocol/portal';
import {
  accountProxyAccountsForHarness,
  resolveProviderAccountSource,
  type AccountProxyHarness,
} from '@canopy/desktop-shared/lib/account-proxy';
import {
  projectAccountProxyUsageAccount,
  projectProviderUsageError,
  projectProviderUsageWindows,
  toPortalIsoTimestamp,
} from '@canopy/desktop-shared/lib/account-proxy-usage-projection';
import { classifyUsageFetchErrorMessage } from '@canopy/desktop-shared/lib/usage-fetch-error';
import {
  getAccountProxyStatus,
  onAccountProxyInventoryChanged,
} from '../account-proxy/service';
import {
  isAiCreditsChosenOverAccountProxy,
  subscribeAiCreditsRoutingModeChanges,
} from '../agents/ai-credits-routing';
import { logMainProcessError } from '../lib/main-process-logging';
import { getObservabilityService } from '../observability';
import { createPortalEvent } from './portal-event-bus';

const PROVIDER_LABELS: Record<PortalProviderUsageProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
};

/** The multi-account proxy state a projection reads, without provider I/O. */
export interface PortalProviderUsageAccountProxySource {
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
  provider: PortalProviderUsageProvider,
  summary: ProviderUsageSummary | undefined,
): PortalProviderUsageEntry {
  if (!summary) {
    return { provider, authState: 'unknown', windows: [] };
  }
  const lastUpdatedAt = toPortalIsoTimestamp(summary.lastUpdatedAt);
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
  provider: PortalProviderUsageProvider,
): AccountProxyHarness | null {
  return provider === 'claude' || provider === 'codex' ? provider : null;
}

/**
 * Whether the proxy serves a provider's new work on this device, as main
 * routes it: AI Credits chosen over the proxy come first, then the proxy's
 * connection, routing, and local runtime.
 */
export function isPortalProviderUsageServedByAccountProxy(
  provider: PortalProviderUsageProvider,
  source: PortalProviderUsageAccountProxySource | undefined,
): source is PortalProviderUsageAccountProxySource & {
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
  provider: PortalProviderUsageProvider,
  source: PortalProviderUsageAccountProxySource | undefined,
): PortalProviderUsageAccount[] | undefined {
  const harness = accountProxyHarness(provider);
  if (
    harness === null ||
    !isPortalProviderUsageServedByAccountProxy(provider, source)
  ) {
    return undefined;
  }
  const seen = new Set<string>();
  const accounts: PortalProviderUsageAccount[] = [];
  for (const account of accountProxyAccountsForHarness(
    source.status.accounts,
    harness,
  )) {
    if (accounts.length >= PORTAL_PROVIDER_USAGE_MAX_ACCOUNTS) break;
    if (seen.has(account.authIndex)) continue;
    seen.add(account.authIndex);
    accounts.push(boundForWire(projectAccountProxyUsageAccount(account)));
  }
  return accounts;
}

function boundLabel(label: string | undefined): string | undefined {
  return label === undefined
    ? undefined
    : label.slice(0, PORTAL_PROVIDER_USAGE_MAX_ACCOUNT_LABEL_LENGTH);
}

/**
 * The wire bounds only, so one long label or a large window list never
 * invalidates the whole projection; the desktop's own views show it all.
 */
function boundForWire(
  account: PortalProviderUsageAccount,
): PortalProviderUsageAccount {
  const label = boundLabel(account.label);
  const planLabel = boundLabel(account.planLabel);
  return {
    ...account,
    ...(label === undefined ? {} : { label }),
    ...(planLabel === undefined ? {} : { planLabel }),
    windows: account.windows.slice(
      0,
      PORTAL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS,
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
export function projectPortalProviderUsage(
  overview: AgentUsageOverview,
  accountProxy?: PortalProviderUsageAccountProxySource,
): PortalProviderUsageProjection {
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
    providers: PORTAL_PROVIDER_USAGE_PROVIDERS.filter(
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
): Pick<PortalProviderUsageProjection, 'antigravityAccount'> {
  if (!overview.antigravityAccount) return {};
  const parsed = antigravityAccountSnapshotSchema.safeParse(
    overview.antigravityAccount,
  );
  return parsed.success ? { antigravityAccount: parsed.data } : {};
}

export function portalProviderUsageEntityEnvelope(
  projection: PortalProviderUsageProjection,
): PortalEntityEnvelope {
  return {
    entityType: 'provider_usage',
    localId: PORTAL_PROVIDER_USAGE_LOCAL_ID,
    payload: projection,
  };
}

/**
 * The proxy state the projection reads: the last account list and the
 * canonical usage merged into it, never a new read from the proxy or the
 * providers. A failed read withdraws the proxy's accounts.
 */
export async function readPortalProviderUsageAccountProxySource(): Promise<PortalProviderUsageAccountProxySource> {
  let status: AccountProxyStatus | null = null;
  try {
    status = await getAccountProxyStatus({ refresh: false });
  } catch (error: unknown) {
    logMainProcessError('Portal provider usage proxy status failed', error);
  }
  return {
    status,
    aiCreditsChosen: isAiCreditsChosenOverAccountProxy(undefined),
  };
}

/** Overview snapshot entity built from cached usage, without provider I/O. */
export async function listPortalProviderUsageEntities(): Promise<
  PortalEntityEnvelope[]
> {
  try {
    const accountProxy = await readPortalProviderUsageAccountProxySource();
    return [
      portalProviderUsageEntityEnvelope(
        projectPortalProviderUsage(
          getObservabilityService().getUsageOverview(),
          accountProxy,
        ),
      ),
    ];
  } catch (error: unknown) {
    logMainProcessError('Portal provider usage snapshot failed', error);
    return [];
  }
}

/**
 * Publish the projection as an overview delta on every usage, proxy account
 * list, routing, or AI Credits mode change while a Portal session can consume
 * it. Reads are serialized latest-wins, so a slow earlier read never
 * republishes accounts a later change withdrew. The returned function stops
 * publishing, even from a read already in flight.
 */
export function subscribePortalProviderUsage(
  emit: (event: PortalEventEnvelope) => void,
): () => void {
  let active = true;
  let lastProviders: string | null = null;
  let latestRequest = 0;
  let latestOverview: AgentUsageOverview | null = null;

  const publish = async (): Promise<void> => {
    latestRequest += 1;
    const request = latestRequest;
    const accountProxy = await readPortalProviderUsageAccountProxySource();
    if (!active || request !== latestRequest) {
      return;
    }
    const projection = projectPortalProviderUsage(
      latestOverview ?? getObservabilityService().getUsageOverview(),
      accountProxy,
    );
    const providers = JSON.stringify({
      providers: projection.providers,
      openCodeAccounts: projection.openCodeAccounts,
      // The snapshot keeps its time while what the card shows is unchanged,
      // so this adds no publishes beyond real Antigravity changes.
      antigravityAccount: projection.antigravityAccount,
    });
    if (providers === lastProviders) {
      return;
    }
    lastProviders = providers;
    emit(
      createPortalEvent('portal.state.delta', {
        scope: 'overview',
        entities: [portalProviderUsageEntityEnvelope(projection)],
        generatedAt: new Date().toISOString(),
      }),
    );
  };
  const schedule = (): void => {
    if (!active) {
      return;
    }
    publish().catch((error: unknown): void => {
      logMainProcessError('Portal provider usage projection failed', error);
    });
  };

  const unsubscribeUsage = getObservabilityService().subscribe(
    (event): void => {
      if (!active || event.type !== 'usage') {
        return;
      }
      latestOverview = event.usage;
      schedule();
    },
  );
  const unsubscribeInventory = onAccountProxyInventoryChanged(schedule);
  const unsubscribeRoutingMode = subscribeAiCreditsRoutingModeChanges(schedule);
  return (): void => {
    active = false;
    unsubscribeUsage();
    unsubscribeInventory();
    unsubscribeRoutingMode();
  };
}
