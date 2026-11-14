'use client';

import { type JSX } from 'react';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Heading,
  Skeleton,
} from '@canopy/ui-shared/components';
import type { TelemetryExpensiveRun } from '@canopy/protocol/telemetry';
import { MostExpensiveRuns } from '../statistics/MostExpensiveRuns';
import { useMemberUsage } from './useMemberUsage';
import { UsageRangeSelect } from './UsageRangeSelect';
import { useSettingsPrivacy } from '../../host';
import { joinClassNames } from '../join-class-names';
import { Surface } from '@canopy/ui-shared/components';

/** A plain sample run: a short label, no tokens and no pull request. */
function sampleExpensiveRun(
  sessionId: string,
  label: string,
): TelemetryExpensiveRun {
  return {
    sessionId,
    turnCount: 3,
    label,
    provider: 'claude',
    model: null,
    totalCostUsd: 1,
    startedAtIso: '2026-01-01T12:00:00.000Z',
    worktreeId: sessionId,
    branchName: 'main',
    prUrl: null,
    authorName: 'Sample',
    status: 'SUCCESS',
    eventType: 'WORKTREE_CHAT',
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/** Plain sample rows the loading skeleton measures. */
const SAMPLE_EXPENSIVE_RUNS: readonly TelemetryExpensiveRun[] = [
  sampleExpensiveRun('sample-run-1', 'Fix the checkout test'),
  sampleExpensiveRun('sample-run-2', 'Clean up billing'),
];

interface ProfileRunsSectionProps {
  orgId: string;
  userId: string;
  /**
   * Whether the viewer clears the org's `usageStatsMinRole`. When false the
   * whole tab is the restricted notice — runs are cost data and stay gated.
   */
  viewerCanViewStats: boolean;
  memberName: string;
}

/**
 * Runs tab: the subject's most expensive agent runs for a selectable range,
 * gated on the org's usage-stats threshold (same gate as the Overview headline
 * stats). This is the deeper cost breakdown that used to sit on the Overview
 * before the activity feed took that spot.
 */
export function ProfileRunsSection({
  orgId,
  userId,
  viewerCanViewStats,
  memberName,
}: ProfileRunsSectionProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const { usage, loading, error, rangeMs, setRangeMs, retry } = useMemberUsage(
    orgId,
    userId,
    viewerCanViewStats,
  );

  if (!viewerCanViewStats) {
    return (
      <Surface variant="dashed">
        <p
          className={joinClassNames(
            'px-4 py-12 text-center text-s fg-secondary',
            blockClassName,
          )}
          data-testid="profile-runs-stats-hidden"
        >
          Usage statistics for {memberName} are restricted by this team&apos;s
          settings.
        </p>
      </Surface>
    );
  }

  return (
    <section className="flex flex-col gap-5" data-testid="profile-runs">
      <div className="flex items-end justify-between gap-3">
        <Heading level={2} variant="title">
          Most expensive sessions
        </Heading>
        <UsageRangeSelect
          rangeMs={rangeMs}
          onChange={setRangeMs}
          testId="profile-runs-range"
        />
      </div>

      <ErrorBanner
        errorSource="profile-runs-section"
        error={error?.copy}
        details={error?.details}
        onRetry={retry}
      />

      {loading && !usage ? (
        <div data-testid="profile-runs-loading">
          <DelayedLoadingPlaceholder>
            <Skeleton
              loading
              label="Loading sessions"
              testId="settings-skeleton-list"
            >
              <Surface variant="raised" padding="default">
                <MostExpensiveRuns runs={SAMPLE_EXPENSIVE_RUNS} />
              </Surface>
            </Skeleton>
          </DelayedLoadingPlaceholder>
        </div>
      ) : error ? null : !usage ? (
        <Surface variant="dashed">
          <p
            className="px-4 py-12 text-center text-s fg-secondary"
            data-testid="profile-runs-empty"
          >
            No usage data available for this range.
          </p>
        </Surface>
      ) : (
        <Surface variant="raised" padding="default">
          <MostExpensiveRuns runs={usage.mostExpensiveRuns} />
        </Surface>
      )}
    </section>
  );
}
