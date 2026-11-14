'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  Button,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  LoadingSpinner,
} from '@canopy/ui-shared/components';
import type { FeedItem } from '@canopy/protocol';
import type { OrganizationMember } from '@canopy/protocol/settings';
import { useSettingsClient } from '../../host';
import { getTeamFeed } from '../team-api';
import { FeedItemCard } from '../team-feed-cards';
import { TeamFeedSkeleton } from '../team-feed-skeleton';
import { useSettingsErrorCopy } from '../../errors';
import { MEMBER_PROFILE_ERROR_SCOPE } from './use-member-paged-resource';
import type { SettingsFailure } from '../../errors';
import { Surface } from '@canopy/ui-shared/components';

interface ProfileActivitySectionProps {
  orgId: string;
  userId: string;
  /** The subject, used to resolve the actor avatar on every card. */
  subject: OrganizationMember;
}

/**
 * This member's slice of the team activity feed, fetched with `?actorId=` so
 * the server attributes items to the subject. A trimmed-down feed: newest page
 * plus a "Load more" affordance, no live stream or filters (the full feed lives
 * on the team page). Visible to every org member.
 */
export function ProfileActivitySection({
  orgId,
  userId,
  subject,
}: ProfileActivitySectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(MEMBER_PROFILE_ERROR_SCOPE);
  // Bumped by Retry to run the first-page load again.
  const [reloadToken, setReloadToken] = useState(0);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const fetchingRef = useRef(false);

  useEffect(() => {
    let ignore = false;
    // All state updates live inside the async closure (not the synchronous
    // effect body) so the kickoff doesn't trigger a cascading re-render.
    void (async (): Promise<void> => {
      setInitialLoaded(false);
      setError(null);
      try {
        const page = await getTeamFeed(client, orgId, undefined, {
          actorId: userId,
        });
        if (!ignore) {
          setItems(page.items);
          setNextCursor(page.nextCursor);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setError(errorCopy.loadFailure(err));
        }
      } finally {
        if (!ignore) {
          setInitialLoaded(true);
        }
      }
    })();
    return (): void => {
      ignore = true;
    };
  }, [client, orgId, userId, errorCopy, reloadToken]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (fetchingRef.current || nextCursor === null) {
      return;
    }
    fetchingRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await getTeamFeed(client, orgId, nextCursor, {
        actorId: userId,
      });
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err: unknown) {
      setError(errorCopy.loadFailure(err));
    } finally {
      fetchingRef.current = false;
      setLoadingMore(false);
    }
  }, [client, orgId, userId, nextCursor, errorCopy]);

  // A failed "Load more" retries that page; a failed first load starts over.
  const hasItems = items.length > 0;
  const retry = useCallback((): void => {
    if (hasItems && nextCursor !== null) {
      void loadMore();
      return;
    }
    setReloadToken((token) => token + 1);
  }, [hasItems, nextCursor, loadMore]);

  if (!initialLoaded) {
    return (
      <DelayedLoadingPlaceholder>
        <TeamFeedSkeleton orgId={orgId} label="Loading activity" />
      </DelayedLoadingPlaceholder>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {error ? (
          <ErrorBanner
            errorSource="profile-activity-section"
            error={error?.copy}
            details={error?.details}
            onRetry={retry}
          />
        ) : (
          <Surface variant="dashed">
            <p
              className="px-4 py-12 text-center text-s fg-secondary"
              data-testid="profile-activity-empty"
            >
              {subject.name} doesn&apos;t have any activity yet.
            </p>
          </Surface>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="profile-activity-list">
      {items.map((item) => (
        <FeedItemCard
          key={item.id}
          item={item}
          orgId={orgId}
          member={item.actor.userId === subject.id ? subject : null}
        />
      ))}

      {error && (
        <ErrorBanner
          errorSource="profile-activity-section"
          error={error?.copy}
          details={error?.details}
          onRetry={retry}
        />
      )}

      {nextCursor !== null && (
        <div className="flex justify-center py-2">
          <Button
            size="compact"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            data-testid="profile-activity-load-more"
          >
            {loadingMore ? <LoadingSpinner /> : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
