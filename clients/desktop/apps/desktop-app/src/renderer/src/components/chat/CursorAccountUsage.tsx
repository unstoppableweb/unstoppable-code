import { getCursorSettingsSection } from '@/lib/cursor-settings';
import { useEffect, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { UsageIndicatorAccountSummary } from '@canopy/ui-shared/components';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useUsageRefreshOnOpen } from './usageRefreshOnOpen';

/** Mounted only while the composer popup is open; reuses the live account store. */
export function CursorAccountUsage(): JSX.Element | null {
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );
  const provider = useObservabilityStore(
    useShallow((state) =>
      state.usage.providers.find((entry) => entry.provider === 'cursor'),
    ),
  );
  const initialize = useObservabilityStore((state) => state.initialize);
  const refresh = useObservabilityStore(
    (state) => state.refreshProviderUsageDetails,
  );
  const openSettings = useNavigationStore((state) => state.openSettings);
  const [refreshFailed, setRefreshFailed] = useState(false);
  useEffect(() => {
    if (enabled) void initialize();
  }, [enabled, initialize]);
  useUsageRefreshOnOpen('cursor', enabled);
  if (!enabled) return null;

  const errorKind = provider?.errorInfo?.kind;
  const needsConnection =
    errorKind === 'auth' || provider?.authState === 'unauthenticated';
  const authenticated =
    provider?.authState === 'authenticated' && !needsConnection;
  const failed =
    refreshFailed || Boolean(provider?.error || provider?.errorInfo);
  const limits = authenticated && !failed ? (provider.rateLimits ?? []) : [];
  const status = needsConnection
    ? 'Connect Cursor to see account usage.'
    : errorKind === 'unsupported'
      ? 'Cursor has not provided usage details for this account.'
      : failed
        ? 'Cursor account usage is unavailable.'
        : !provider || provider.authState === 'unknown'
          ? 'Checking Cursor account usage…'
          : limits.length === 0
            ? 'Cursor has not provided account usage details.'
            : undefined;

  return (
    <UsageIndicatorAccountSummary
      providerLabel="Cursor"
      account={
        authenticated
          ? (provider.accountLabel ?? provider.accountEmail)
          : undefined
      }
      // Cursor reports the bare tier (`Pro`); name the product with it, as
      // the Claude and ChatGPT plan labels do.
      plan={
        authenticated && provider.subscriptionLabel
          ? /^cursor\b/i.test(provider.subscriptionLabel)
            ? provider.subscriptionLabel
            : `Cursor ${provider.subscriptionLabel}`
          : undefined
      }
      status={status}
      limits={limits.map((limit, index) => ({
        id: limit.limitId ?? String(index),
        label: limit.limitName ?? 'Account usage',
        usedPercent: limit.primary?.usedPercent,
        resetsAt: limit.primary?.resetsAt,
        usedUsd: limit.credits?.usedUsd,
        remainingUsd: limit.credits?.remainingUsd,
        totalUsd: limit.credits?.totalUsd,
      }))}
      {...(failed && !needsConnection && errorKind !== 'unsupported'
        ? {
            onRetry: (): Promise<void> => {
              setRefreshFailed(false);
              return refresh('cursor')
                .then(() => undefined)
                .catch(() => setRefreshFailed(true));
            },
          }
        : {})}
      onManage={() => openSettings(getCursorSettingsSection())}
    />
  );
}
