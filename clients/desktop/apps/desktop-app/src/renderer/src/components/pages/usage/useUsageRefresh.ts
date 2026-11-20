import { useCallback, useState } from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { newestUsageUpdate } from '@canopy/ui-shared';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  refreshAccountProxyStatus,
  useAccountProxyStore,
} from '@/stores/accountProxyStore';
import {
  refreshAiCreditsUsage,
  useAiCreditsUsage,
} from '@/hooks/useAiCreditsUsage';
import { selectAccountProviderUsageSummaries } from './ProviderUsageCards';

function harnessEnabled(
  flag: Parameters<
    ReturnType<typeof useFeatureFlagsStore.getState>['isEnabled']
  >[0],
): boolean {
  return useFeatureFlagsStore.getState().isEnabled(flag);
}

/**
 * Read every usage group a Usage surface shows again: each provider, the
 * account proxy when it serves one, OpenCode, Antigravity, and AI Credits. Groups keep
 * their current values while the reads run. Resolves once the provider,
 * OpenCode, Antigravity and proxy reads settle; AI Credits reports its own read through
 * its hook.
 */
export async function refreshAllUsage(isActive: () => boolean): Promise<void> {
  refreshAiCreditsUsage();
  const { initialize } = useObservabilityStore.getState();
  await initialize();
  if (!isActive()) {
    return;
  }
  const { usage, refreshProviderUsage } = useObservabilityStore.getState();
  const reads: Promise<unknown>[] = selectAccountProviderUsageSummaries(
    usage,
    harnessEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
    harnessEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  ).map((provider) => refreshProviderUsage(provider.provider));
  if (
    usage.openCodeAccounts &&
    harnessEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key)
  ) {
    reads.push(refreshProviderUsage('opencode'));
  }
  // Antigravity's plan is held only in memory, so a restart leaves it empty
  // until this read; main skips it once a plan was read this launch.
  if (
    harnessEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key)
  ) {
    reads.push(refreshProviderUsage('antigravity'));
  }
  if (useAccountProxyStore.getState().status !== null) {
    reads.push(refreshAccountProxyStatus());
  }
  await Promise.allSettled(reads);
}

export interface UsageRefreshState {
  /** The newest read across the groups shown, or null before any read. */
  readonly updatedAt: number | null;
  readonly refreshing: boolean;
  readonly refresh: () => void;
}

/**
 * The one Updated line and refresh control a Usage surface shows. It reads
 * as refreshing until every group it refreshed has settled, including AI
 * Credits when the surface shows them.
 */
export function useUsageRefresh({
  includeAiCredits,
}: {
  /** Whether the surface shows the AI Credits group. */
  includeAiCredits: boolean;
}): UsageRefreshState {
  const usage = useObservabilityStore((s) => s.usage);
  // Shares the AI Credits card's cached read, so this adds no request.
  const aiCreditsRefreshing = useAiCreditsUsage(undefined, {
    enabled: includeAiCredits,
  }).refreshing;
  const providerRefreshing = useObservabilityStore(
    (s) => s.refreshingProviders.size > 0,
  );
  const proxyRefreshedAt = useAccountProxyStore(
    (state) => state.status?.refreshedAt ?? null,
  );
  const [pending, setPending] = useState(false);

  const refresh = useCallback((): void => {
    setPending(true);
    void refreshAllUsage(() => true)
      .catch(() => undefined)
      .finally(() => setPending(false));
  }, []);

  return {
    updatedAt: newestUsageUpdate([
      ...usage.providers.map((provider) => provider.lastUpdatedAt),
      usage.openCodeAccounts?.updatedAt,
      proxyRefreshedAt,
    ]),
    refreshing: pending || providerRefreshing || aiCreditsRefreshing,
    refresh,
  };
}
