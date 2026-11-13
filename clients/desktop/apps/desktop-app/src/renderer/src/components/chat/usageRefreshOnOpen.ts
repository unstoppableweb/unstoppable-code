import { useEffect } from 'react';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import {
  requestProviderUsageRefresh,
  resetUsageAutoRefresh,
} from './usageAutoRefresh';

/**
 * Refreshes a provider's plan usage as the composer's usage popover opens,
 * so the numbers are current without a refresh button. Hosts mount this only
 * while the popover is open. It shares the automatic refresh's per-provider
 * floor (`requestProviderUsageRefresh`): reopening, or opening just after a
 * turn's automatic read, reuses the numbers instead of asking again.
 */
export function useUsageRefreshOnOpen(
  provider: AgentProviderType,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    requestProviderUsageRefresh(provider);
  }, [enabled, provider]);
}

/** Forgets every provider's last refresh (tests start from a clean slate). */
export function resetUsageRefreshOnOpen(): void {
  resetUsageAutoRefresh();
}
