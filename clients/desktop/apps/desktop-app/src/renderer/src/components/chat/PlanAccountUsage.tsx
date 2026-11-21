import { useEffect, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { UsageIndicatorAccountSummary } from '@canopy/ui-shared/components';
import { buildSubCards } from '@/components/pages/usage/usage-sub-cards';
import { useUsageRetryWait } from '@/components/pages/usage/UsageErrorNotice';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useUsageRefreshOnOpen } from './usageRefreshOnOpen';

export type PlanAccountProvider = 'claude' | 'codex';

const PROVIDER_LABELS: Record<PlanAccountProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * Claude and Codex subscription limits for the composer's usage popover.
 * Mounted only while the popover is open; reads the same observability
 * snapshot, and the same window titles, as the Usage page.
 */
export function PlanAccountUsage({
  provider: providerType,
}: {
  provider: PlanAccountProvider;
}): JSX.Element {
  const label = PROVIDER_LABELS[providerType];
  const provider = useObservabilityStore(
    useShallow((state) =>
      state.usage.providers.find((entry) => entry.provider === providerType),
    ),
  );
  const initialize = useObservabilityStore((state) => state.initialize);
  const refresh = useObservabilityStore(
    (state) => state.refreshProviderUsageDetails,
  );
  const [refreshFailed, setRefreshFailed] = useState(false);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  useUsageRefreshOnOpen(providerType);

  const errorKind = provider?.errorInfo?.kind;
  const retryAt =
    errorKind === 'rate_limited' ? provider?.errorInfo?.retryAt : undefined;
  const waitingForRetry = useUsageRetryWait(retryAt);
  const needsConnection =
    errorKind === 'auth' || provider?.authState === 'unauthenticated';
  const authenticated =
    provider?.authState === 'authenticated' && !needsConnection;
  const rateLimited =
    authenticated && errorKind === 'rate_limited' && !refreshFailed;
  const failed =
    refreshFailed ||
    (!rateLimited && Boolean(provider?.error || provider?.errorInfo));
  const limits =
    authenticated && !failed
      ? buildSubCards(providerType, provider.rateLimits)
      : [];
  const lastUpdatedTime = rateLimited
    ? formatUsageLimitTimeLabel(provider?.lastUpdatedAt)
    : null;
  const retryTime = waitingForRetry ? formatUsageLimitTimeLabel(retryAt) : null;
  let rateLimitedStatus: string | undefined;
  if (rateLimited) {
    if (limits.length > 0 && lastUpdatedTime) {
      rateLimitedStatus =
        waitingForRetry && retryTime
          ? `${label} is limiting usage checks. Showing limits from ${lastUpdatedTime}; checking again after ${retryTime}.`
          : `${label} is limiting usage checks. Showing limits from ${lastUpdatedTime}.`;
    } else if (limits.length > 0) {
      rateLimitedStatus = `${label} is limiting usage checks. Showing the last limits ${label} reported.${waitingForRetry && retryTime ? ` Checking again after ${retryTime}.` : ''}`;
    } else {
      rateLimitedStatus = `${label} is limiting usage checks.${waitingForRetry && retryTime ? ` Checking again after ${retryTime}.` : ''}`;
    }
  }
  const status = needsConnection
    ? `Sign in to ${label} to see plan limits.`
    : errorKind === 'unsupported'
      ? `${label} doesn't report plan limits for this account.`
      : failed
        ? `${label} plan limits are unavailable.`
        : !provider || provider.authState === 'unknown'
          ? `Checking ${label} plan limits…`
          : rateLimited
            ? rateLimitedStatus
            : limits.length === 0
              ? `${label} hasn't reported plan limits yet.`
              : undefined;

  return (
    <UsageIndicatorAccountSummary
      providerLabel={label}
      account={
        authenticated
          ? (provider.accountLabel ?? provider.accountEmail)
          : undefined
      }
      plan={authenticated ? provider.subscriptionLabel : undefined}
      status={status}
      limits={limits.map((limit) => {
        // Codex repeats one limit's credits on both of its windows; the
        // balance belongs under the first window only.
        const credits = limit.key.endsWith('-secondary')
          ? undefined
          : limit.credits;
        return {
          id: limit.key,
          label: limit.title,
          usedPercent: limit.usedPercent,
          resetsAt: limit.resetsAt,
          usedUsd: credits?.usedUsd,
          totalUsd: credits?.totalUsd,
          // Codex reports its balance in credits (stored in the shared
          // `remainingUsd` slot); Claude's extra usage is dollars.
          ...(providerType === 'codex'
            ? { remainingCredits: credits?.remainingUsd }
            : { remainingUsd: credits?.remainingUsd }),
        };
      })}
      {...((failed || (rateLimited && !waitingForRetry)) &&
      !needsConnection &&
      errorKind !== 'unsupported'
        ? {
            onRetry: (): Promise<void> => {
              setRefreshFailed(false);
              return refresh(providerType)
                .then(() => undefined)
                .catch(() => setRefreshFailed(true));
            },
          }
        : {})}
    />
  );
}
