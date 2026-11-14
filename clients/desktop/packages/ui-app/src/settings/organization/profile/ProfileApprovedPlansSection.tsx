'use client';

import type { JSX } from 'react';
import { SettingsLink, useSettingsPrivacy } from '../../host';
import { joinClassNames } from '../join-class-names';
import { ListChecks } from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  LoadingSpinner,
  Skeleton,
} from '@canopy/ui-shared/components';
import type { ApprovedPlanSummary } from '@canopy/protocol/plans';
import { formatApprovedPlanMeta } from '@canopy/protocol/settings/plan-display';
import { fetchMemberApprovedPlans } from './profile-api';
import { useMemberPagedResource } from './use-member-paged-resource';
import { Surface } from '@canopy/ui-shared/components';

/** Plain sample rows the loading skeleton measures. */
const SAMPLE_APPROVED_PLANS: readonly ApprovedPlanSummary[] = [
  {
    id: 'sample-approved-plan-1',
    title: 'Checkout retry fix',
    reviewStatus: null,
    planVersion: 1,
    implementationStartedAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
  },
  {
    id: 'sample-approved-plan-2',
    title: 'Billing page cleanup',
    reviewStatus: null,
    planVersion: 1,
    implementationStartedAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
  },
];

/** The approved plans, each linking to its read-only viewer. */
function ApprovedPlanList({
  plans,
}: {
  plans: readonly ApprovedPlanSummary[];
}): JSX.Element {
  return (
    <ul
      className="flex flex-col gap-2"
      data-testid="profile-approved-plans-list"
    >
      {plans.map((plan) => {
        const meta = formatApprovedPlanMeta(plan);
        return (
          <li key={plan.id}>
            <SettingsLink
              href={`/plans/implemented/${encodeURIComponent(plan.id)}`}
              data-testid="profile-approved-plan-row"
              className="flex items-start gap-3 rounded-xl bg-card p-4 shadow-sm transition-colors hover:bg-secondary/40"
            >
              <span className="mt-0.5 shrink-0 fg-accent">
                <ListChecks size={18} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-s font-medium fg-primary">
                  {plan.title}
                </span>
                {meta.length > 0 && (
                  <span className="mt-0.5 block truncate text-xs fg-secondary">
                    {meta.join(' · ')}
                  </span>
                )}
              </span>
            </SettingsLink>
          </li>
        );
      })}
    </ul>
  );
}

interface ProfileApprovedPlansSectionProps {
  orgId: string;
  userId: string;
  /** Display name of the subject, used in the empty-state copy. */
  memberName: string;
}

/**
 * The approved (telemetry) plans a member has started implementing in this org,
 * newest-first. Each row links to the read-only `/plans/implemented/{id}` viewer.
 * These are point-in-time snapshots distinct from the shared plans above, gated
 * by the same membership check the API enforces.
 */
export function ProfileApprovedPlansSection({
  orgId,
  userId,
  memberName,
}: ProfileApprovedPlansSectionProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const {
    items: plans,
    initialLoaded,
    loadingMore,
    error,
    hasMore,
    loadMore,
    retry,
  } = useMemberPagedResource(orgId, userId, fetchMemberApprovedPlans);

  if (!initialLoaded) {
    return (
      <div data-testid="profile-approved-plans-loading">
        <DelayedLoadingPlaceholder>
          <Skeleton
            loading
            label="Loading approved plans"
            testId="settings-skeleton-list"
          >
            <ApprovedPlanList plans={SAMPLE_APPROVED_PLANS} />
          </Skeleton>
        </DelayedLoadingPlaceholder>
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {error ? (
          <ErrorBanner
            errorSource="profile-approved-plans-section"
            error={error?.copy}
            details={error?.details}
            onRetry={retry}
          />
        ) : (
          <Surface variant="dashed">
            <p
              className={joinClassNames(
                'px-4 py-12 text-center text-s fg-secondary',
                blockClassName,
              )}
              data-testid="profile-approved-plans-empty"
            >
              {memberName} hasn&apos;t started implementing any plans yet.
            </p>
          </Surface>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ApprovedPlanList plans={plans} />

      {error && (
        <ErrorBanner
          errorSource="profile-approved-plans-section"
          error={error?.copy}
          details={error?.details}
          onRetry={retry}
        />
      )}

      {hasMore && (
        <div className="flex justify-center py-2">
          <Button
            size="compact"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            data-testid="profile-approved-plans-load-more"
          >
            {loadingMore ? (
              <>
                <LoadingSpinner />
                <span className="sr-only">Loading more</span>
              </>
            ) : (
              'Load more'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
