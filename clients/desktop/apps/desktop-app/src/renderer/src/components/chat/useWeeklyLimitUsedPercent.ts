import { useEffect } from 'react';
import { selectWeeklyLimitUsedPercent } from '@canopy/desktop-shared/lib/provider-usage-windows';
import { resolveRuntimeModel } from '@canopy/desktop-shared/types';
import { useObservabilityStore } from '@/stores/observabilityStore';
import type { PlanAccountProvider } from './PlanAccountUsage';
import { useProviderUsageAutoRefresh } from './usageAutoRefresh';

/**
 * The share of the 7-day plan limit that binds this chat's model on the
 * signed-in plan, for the composer's usage ring. Reads the observability
 * snapshot the Usage page and the usage popover read. While the ring is
 * mounted, the signed-in plan's usage is re-read after turns, on focus and
 * every few minutes (`useProviderUsageAutoRefresh`), so the ring follows
 * without the popover being opened. `undefined` without a plan provider, a signed-in account, or an
 * applicable weekly limit with a known share: the ring then shows the
 * context fill.
 */
export function useWeeklyLimitUsedPercent(
  provider: PlanAccountProvider | undefined,
  model: string | undefined,
  /** True while this composer's chat runs a turn; its end re-reads usage. */
  turnActive = false,
): number | undefined {
  const initialize = useObservabilityStore((state) => state.initialize);
  const providerUsage = useObservabilityStore((state) =>
    provider === undefined
      ? undefined
      : state.usage.providers.find((entry) => entry.provider === provider),
  );
  useEffect(() => {
    if (provider !== undefined) void initialize();
  }, [initialize, provider]);
  useProviderUsageAutoRefresh(
    providerUsage?.authState === 'authenticated' ? provider : undefined,
    turnActive,
  );
  if (
    provider === undefined ||
    model === undefined ||
    providerUsage?.authState !== 'authenticated'
  ) {
    return undefined;
  }
  // An Agent runs on its base model, so its base model's weekly limit binds.
  return selectWeeklyLimitUsedPercent(
    provider,
    providerUsage.rateLimits,
    resolveRuntimeModel(model) ?? model,
  );
}
