import { Stack } from '@canopy/ui-shared/components';
import { type JSX, useEffect, useState } from 'react';
import {
  formatUsageUpdatedPhrase,
  UsageRefreshButton,
} from '@canopy/ui-shared';
import { PageTitlebar } from '../shared/PageTitlebar';
import { PageContent } from '../shared/PageContent';
import { PageHeader } from '@canopy/ui-shared/primitives/PageHeader';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { ProviderUsageCards } from './usage/ProviderUsageCards';
import { AiCreditsUsageCard } from './usage/AiCreditsUsageCard';
import { InterruptedSessionsNotice } from './usage/InterruptedSessionsNotice';
import { refreshAllUsage, useUsageRefresh } from './usage/useUsageRefresh';

export function UsagePage(): JSX.Element {
  const usage = useObservabilityStore((s) => s.usage);
  const refreshProviderUsage = useObservabilityStore(
    (s) => s.refreshProviderUsage,
  );
  const refreshProviderUsageDetails = useObservabilityStore(
    (s) => s.refreshProviderUsageDetails,
  );
  const refreshingProviders = useObservabilityStore(
    (s) => s.refreshingProviders,
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const { updatedAt, refreshing, refresh } = useUsageRefresh({
    includeAiCredits: true,
  });

  useEffect(() => {
    let active = true;
    void refreshAllUsage(() => active).catch(() => undefined);
    return (): void => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 30_000);
    return (): void => clearInterval(interval);
  }, []);

  const updated = refreshing
    ? 'Updating…'
    : formatUsageUpdatedPhrase(updatedAt, nowMs);

  return (
    <section
      className="page-scroll-gutter h-full overflow-auto"
      data-testid="page-usage"
    >
      <PageTitlebar />
      <PageContent>
        <div className="flex flex-col mx-auto w-full max-w-160 gap-6">
          <PageHeader
            title="Usage"
            description={
              <span data-testid="usage-updated-line">
                Limits for each account
                {updated ? ` · ${updated}` : ''}
              </span>
            }
            actions={
              <UsageRefreshButton refreshing={refreshing} onRefresh={refresh} />
            }
          />
          <Stack gap="page">
            <InterruptedSessionsNotice />
            <ProviderUsageCards
              nowMs={nowMs}
              usage={usage}
              refreshingProviders={refreshingProviders}
              refreshProviderUsage={refreshProviderUsage}
              refreshProviderUsageDetails={refreshProviderUsageDetails}
            />
            <AiCreditsUsageCard />
          </Stack>
        </div>
      </PageContent>
    </section>
  );
}
