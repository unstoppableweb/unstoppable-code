import { type JSX, useEffect, useState } from 'react';
import type { UsageTabSummaryResponse } from '@canopy/desktop-shared/types';
import { InfoIcon } from '@canopy/ui-shared/icons';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useObservabilityEntriesInterest } from '@/lib/chat-interest';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { RefreshSpinner } from '@/components/shared/loading';
import {
  Stack,
  Disclosure,
  ErrorBanner,
  Heading,
  Surface,
} from '@canopy/ui-shared/components';
import type { TabSpec } from './tab-specs';
import { HeadlineCardRow } from './HeadlineCardRow';
import { MetricsChart } from './MetricsChart';
import { MetricsBreakdownPanel } from './MetricsBreakdownPanel';

interface MetricsTabProps {
  spec: TabSpec;
  retentionDays: number;
}

export function MetricsTab({
  spec,
  retentionDays,
}: MetricsTabProps): JSX.Element {
  useObservabilityEntriesInterest();
  const title = useEarlyAccessTitle(spec.title);
  const loadUsageTabSummary = useObservabilityStore(
    (s) => s.loadUsageTabSummary,
  );
  const [summary, setSummary] = useState<UsageTabSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError(null);
    loadUsageTabSummary({ tab: spec.id })
      .then((response) => {
        if (cancelled) return;
        setSummary(response);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error ? reason.message : 'Failed to load summary',
        );
      });
    return (): void => {
      cancelled = true;
    };
  }, [spec.id, loadUsageTabSummary]);

  return (
    <section
      className="flex flex-col gap-4"
      data-testid={`usage-metrics-tab-${spec.id}`}
    >
      <Stack gap="tight">
        <Heading level={2} variant="section">
          {title}
        </Heading>
        {spec.subtitle && (
          <p className="max-w-3xl text-s fg-secondary">{spec.subtitle}</p>
        )}
      </Stack>
      {spec.notice && (
        <div role="note">
          <Disclosure
            variant="box"
            label={spec.notice.title}
            leadingIcon={
              <InfoIcon size="sm" className="fg-secondary" aria-hidden="true" />
            }
            dataTestId={`usage-metrics-notice-${spec.id}`}
          >
            <p className="max-w-3xl text-s fg-secondary">{spec.notice.body}</p>
          </Disclosure>
        </div>
      )}
      {error && (
        <ErrorBanner errorSource="metrics-tab" className="" error={error} />
      )}
      {summary === null ? (
        <Surface variant="group">
          <div className="flex items-center gap-2 px-4 py-3 text-s fg-secondary">
            <RefreshSpinner spinning size="sm" />
            <span>Loading summary…</span>
          </div>
        </Surface>
      ) : (
        <HeadlineCardRow specs={spec.cards} summary={summary} />
      )}
      <MetricsChart spec={spec} retentionDays={retentionDays} />
      <MetricsBreakdownPanel spec={spec} />
    </section>
  );
}
