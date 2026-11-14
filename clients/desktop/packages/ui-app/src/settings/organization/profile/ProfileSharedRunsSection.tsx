'use client';

import type { JSX } from 'react';
import { SettingsLink, useSettingsPrivacy } from '../../host';
import { joinClassNames } from '../join-class-names';
import { Bot } from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  LoadingSpinner,
  Skeleton,
} from '@canopy/ui-shared/components';
import type { SharedRunSummary } from '@canopy/protocol/runs';
import { formatPlanDate } from '@canopy/protocol/settings/plan-display';
import { formatCostUsd } from '../feed-format';
import { fetchMemberSharedRuns } from './profile-api';
import { useMemberPagedResource } from './use-member-paged-resource';
import { Surface } from '@canopy/ui-shared/components';

/** Plain sample rows the loading skeleton measures. */
const SAMPLE_RUNS: readonly SharedRunSummary[] = [
  {
    id: 'sample-run-1',
    title: 'Fix the checkout test',
    shareScope: 'organization',
    status: 'completed',
    provider: 'claude',
    model: null,
    turnCount: 3,
    toolUseCount: 0,
    totalCostUsd: null,
    durationMs: null,
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
  },
  {
    id: 'sample-run-2',
    title: 'Clean up billing',
    shareScope: 'organization',
    status: 'completed',
    provider: 'claude',
    model: null,
    turnCount: 2,
    toolUseCount: 0,
    totalCostUsd: null,
    durationMs: null,
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
  },
];

/** The shared sessions, each linking to the run viewer. */
function SharedRunList({
  runs,
}: {
  runs: readonly SharedRunSummary[];
}): JSX.Element {
  return (
    <ul className="flex flex-col gap-2" data-testid="profile-sessions-list">
      {runs.map((run) => {
        const updated = formatPlanDate(run.updatedAt);
        const cost = formatCostUsd(run.totalCostUsd);
        const meta = [
          run.status,
          `${run.turnCount} turn${run.turnCount === 1 ? '' : 's'}`,
          ...(cost ? [cost] : []),
          ...(updated ? [`Updated ${updated}`] : []),
        ].join(' · ');
        return (
          <li key={run.id}>
            <SettingsLink
              href={`/runs/${encodeURIComponent(run.id)}`}
              data-testid="profile-session-row"
              className="flex items-start gap-3 rounded-xl bg-card p-4 shadow-sm transition-colors hover:bg-secondary/40"
            >
              <span className="mt-0.5 shrink-0 fg-accent">
                <Bot size={18} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-s font-medium fg-primary">
                  {run.title}
                </span>
                <span className="mt-0.5 block truncate text-xs fg-secondary">
                  {meta}
                </span>
              </span>
            </SettingsLink>
          </li>
        );
      })}
    </ul>
  );
}

interface ProfileSharedRunsSectionProps {
  orgId: string;
  userId: string;
  /** Display name of the subject, used in the empty-state copy. */
  memberName: string;
}

/**
 * The member's ORGANIZATION-shared runs (sessions) in this org, newest-updated
 * first. Each row links through to the standalone run viewer (`/runs/{id}`). The
 * list is gated by the same membership check the API enforces, so it is visible
 * to every org member regardless of the usage-stats threshold. This is the
 * "profile discovery" counterpart to the org feed's `run_shared` card.
 */
export function ProfileSharedRunsSection({
  orgId,
  userId,
  memberName,
}: ProfileSharedRunsSectionProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const {
    items: runs,
    initialLoaded,
    loadingMore,
    error,
    hasMore,
    loadMore,
    retry,
  } = useMemberPagedResource(orgId, userId, fetchMemberSharedRuns);

  if (!initialLoaded) {
    return (
      <div data-testid="profile-sessions-loading">
        <DelayedLoadingPlaceholder>
          <Skeleton
            loading
            label="Loading sessions"
            testId="settings-skeleton-list"
          >
            <SharedRunList runs={SAMPLE_RUNS} />
          </Skeleton>
        </DelayedLoadingPlaceholder>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {error ? (
          <ErrorBanner
            errorSource="profile-shared-runs-section"
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
              data-testid="profile-sessions-empty"
            >
              {memberName} hasn&apos;t shared any sessions with this team yet.
            </p>
          </Surface>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <SharedRunList runs={runs} />

      {error && (
        <ErrorBanner
          errorSource="profile-shared-runs-section"
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
            data-testid="profile-sessions-load-more"
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
