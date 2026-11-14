'use client';

import type { JSX } from 'react';
import { SettingsLink, useSettingsPrivacy } from '../../host';
import { joinClassNames } from '../join-class-names';
import { FileText } from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  LoadingSpinner,
  Skeleton,
} from '@canopy/ui-shared/components';
import type { SharedPlanSummary } from '@canopy/protocol/plans';
import { formatPlanDate } from '@canopy/protocol/settings/plan-display';
import { fetchMemberSharedPlans } from './profile-api';
import { useMemberPagedResource } from './use-member-paged-resource';
import { Surface } from '@canopy/ui-shared/components';

/** The fields a plan row shows. */
type PlanRowItem = Pick<
  SharedPlanSummary,
  'id' | 'title' | 'updatedAt' | 'repositories'
>;

/** Plain sample rows the loading skeleton measures. */
const SAMPLE_PLANS: readonly PlanRowItem[] = [
  {
    id: 'sample-plan-1',
    title: 'Checkout retry fix',
    updatedAt: '2026-01-01T12:00:00.000Z',
    repositories: [],
  },
  {
    id: 'sample-plan-2',
    title: 'Billing page cleanup',
    updatedAt: '2026-01-01T12:00:00.000Z',
    repositories: [],
  },
];

/** The shared plans, each linking to its plan page. */
function PlanList({ plans }: { plans: readonly PlanRowItem[] }): JSX.Element {
  return (
    <ul className="flex flex-col gap-2" data-testid="profile-plans-list">
      {plans.map((plan) => {
        const updated = formatPlanDate(plan.updatedAt);
        const repoNames = plan.repositories
          .map((repo) => repo.repoName)
          .filter((name): name is string => Boolean(name));
        return (
          <li key={plan.id}>
            <SettingsLink
              href={`/plans/${encodeURIComponent(plan.id)}`}
              data-testid="profile-plan-row"
              className="flex items-start gap-3 rounded-xl bg-card p-4 shadow-sm transition-colors hover:bg-secondary/40"
            >
              <span className="mt-0.5 shrink-0 fg-accent">
                <FileText size={18} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-s font-medium fg-primary">
                  {plan.title}
                </span>
                <span className="mt-0.5 block truncate text-xs fg-secondary">
                  {repoNames.length > 0
                    ? repoNames.join(', ')
                    : 'No repository'}
                  {updated ? ` · Updated ${updated}` : ''}
                </span>
              </span>
            </SettingsLink>
          </li>
        );
      })}
    </ul>
  );
}

interface ProfilePlansSectionProps {
  orgId: string;
  userId: string;
  /** Display name of the subject, used in the empty-state copy. */
  memberName: string;
}

/**
 * The member's TEAM/ORGANIZATION-shared plans in this org, newest-updated
 * first. Each row links through to the plan detail route. The list is gated by
 * the same membership check the API enforces, so it is visible to every org
 * member regardless of the usage-stats threshold.
 */
export function ProfilePlansSection({
  orgId,
  userId,
  memberName,
}: ProfilePlansSectionProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const {
    items: plans,
    initialLoaded,
    loadingMore,
    error,
    hasMore,
    loadMore,
    retry,
  } = useMemberPagedResource(orgId, userId, fetchMemberSharedPlans);

  if (!initialLoaded) {
    return (
      <div data-testid="profile-plans-loading">
        <DelayedLoadingPlaceholder>
          <Skeleton
            loading
            label="Loading plans"
            testId="settings-skeleton-list"
          >
            <PlanList plans={SAMPLE_PLANS} />
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
            errorSource="profile-plans-section"
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
              data-testid="profile-plans-empty"
            >
              {memberName} hasn&apos;t shared any plans with this team yet.
            </p>
          </Surface>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <PlanList plans={plans} />

      {error && (
        <ErrorBanner
          errorSource="profile-plans-section"
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
            data-testid="profile-plans-load-more"
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
