import { useEffect, useState, type JSX } from 'react';
import { UsageIndicatorAccountSummary } from '@canopy/ui-shared/components';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { getCopilotSettingsSection } from '@/lib/copilot-settings';
import { useUsageRefreshOnOpen } from './usageRefreshOnOpen';

/** The popup reads the same account snapshot as the Usage page and panels. */
export function CopilotAccountUsage(): JSX.Element {
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  );
  const provider = useObservabilityStore((state) =>
    state.usage.providers.find((entry) => entry.provider === 'copilot'),
  );
  const initialize = useObservabilityStore((state) => state.initialize);
  const checking = useObservabilityStore(
    (state) => !state.initialized || state.refreshingProviders.has('copilot'),
  );
  const refresh = useObservabilityStore(
    (state) => state.refreshProviderUsageDetails,
  );
  const openSettings = useNavigationStore((state) => state.openSettings);
  const [refreshFailed, setRefreshFailed] = useState(false);
  useEffect(() => {
    if (enabled) void initialize();
  }, [enabled, initialize]);
  useUsageRefreshOnOpen('copilot', enabled);
  const needsConnection =
    (!provider && !checking) ||
    provider?.authState === 'unauthenticated' ||
    provider?.errorInfo?.kind === 'auth';
  const failed =
    refreshFailed || Boolean(provider?.error || provider?.errorInfo);
  const authenticated =
    enabled &&
    provider?.authState === 'authenticated' &&
    !needsConnection &&
    !failed;
  const limits = authenticated ? (provider.rateLimits ?? []) : [];
  const status = !enabled
    ? 'Copilot account usage is unavailable.'
    : needsConnection
      ? 'Connect Copilot to see account usage.'
      : failed
        ? 'Copilot account usage is unavailable.'
        : !provider || provider.authState === 'unknown'
          ? 'Checking Copilot account usage…'
          : !limits.length
            ? 'Copilot has not provided account usage details.'
            : undefined;
  return (
    <UsageIndicatorAccountSummary
      providerLabel="GitHub Copilot"
      account={authenticated ? provider.accountLabel : undefined}
      status={status}
      limits={limits.map((limit, index) => ({
        id: limit.limitId ?? String(index),
        label: limit.limitName ?? 'Account usage',
        usedPercent: limit.primary?.usedPercent,
        unlimited: limit.primary?.unlimited,
        resetsAt: limit.primary?.resetsAt,
      }))}
      {...(enabled && failed && !needsConnection
        ? {
            onRetry: (): Promise<void> => {
              setRefreshFailed(false);
              return refresh('copilot')
                .then(() => undefined)
                .catch(() => setRefreshFailed(true));
            },
          }
        : {})}
      onManage={(): void => openSettings(getCopilotSettingsSection())}
    />
  );
}
