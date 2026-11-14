'use client';

import { SettingsChartLoading } from '../../pages/loading-skeletons';
import { type JSX } from 'react';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Heading,
} from '@canopy/ui-shared/components';
import type { OrganizationMember } from '@canopy/protocol/settings';
import { HeadlineCards } from '../statistics/HeadlineCards';
import { useMemberUsage } from './useMemberUsage';
import { UsageRangeSelect } from './UsageRangeSelect';
import { ProfileActivitySection } from './ProfileActivitySection';
import { useSettingsPrivacy } from '../../host';
import { Surface } from '@canopy/ui-shared/components';

interface ProfileOverviewSectionProps {
  orgId: string;
  userId: string;
  /**
   * Whether the viewer clears the org's `usageStatsMinRole`. When false the
   * gated headline-stats block is hidden entirely; the activity feed below
   * stays visible to every member.
   */
  viewerCanViewStats: boolean;
  memberName: string;
  /** The subject, used to resolve the actor avatar on every feed card. */
  subject: OrganizationMember;
}

/**
 * Overview tab — the profile landing surface. Leads with the subject's headline
 * usage rollups (gated on the org's usage-stats threshold) and then gives the
 * activity feed the prime real estate, since a person's recent work is the more
 * interesting thing to land on. The dedicated Runs tab carries the deeper
 * most-expensive-runs breakdown. When the viewer can't see stats the headline
 * block is simply omitted (no leakage) and the feed becomes the whole tab.
 */
export function ProfileOverviewSection({
  orgId,
  userId,
  viewerCanViewStats,
  memberName,
  subject,
}: ProfileOverviewSectionProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const { usage, loading, error, rangeMs, setRangeMs, retry } = useMemberUsage(
    orgId,
    userId,
    viewerCanViewStats,
  );

  return (
    <div className="flex flex-col gap-8" data-testid="profile-overview">
      {viewerCanViewStats && (
        <section
          className="flex flex-col gap-5"
          data-testid="profile-overview-stats"
        >
          <div className="flex items-end justify-between gap-3">
            <Heading level={2} variant="title">
              <span
                className={blockClassName === '' ? undefined : blockClassName}
              >
                Usage for {memberName}
              </span>
            </Heading>
            <UsageRangeSelect
              rangeMs={rangeMs}
              onChange={setRangeMs}
              testId="profile-overview-range"
            />
          </div>

          <ErrorBanner
            errorSource="profile-overview-section"
            error={error?.copy}
            details={error?.details}
            onRetry={retry}
          />

          {loading && !usage ? (
            <div data-testid="profile-overview-loading">
              <DelayedLoadingPlaceholder>
                <SettingsChartLoading />
              </DelayedLoadingPlaceholder>
            </div>
          ) : error ? null : !usage ? (
            <Surface variant="dashed">
              <p
                className="px-4 py-12 text-center text-s fg-secondary"
                data-testid="profile-overview-empty"
              >
                No usage data available for this range.
              </p>
            </Surface>
          ) : (
            <HeadlineCards cards={usage.headline} />
          )}
        </section>
      )}

      <section
        className="flex flex-col gap-3"
        data-testid="profile-overview-activity"
      >
        <Heading level={2} variant="title">
          Recent activity
        </Heading>
        <ProfileActivitySection
          orgId={orgId}
          userId={userId}
          subject={subject}
        />
      </section>
    </div>
  );
}
