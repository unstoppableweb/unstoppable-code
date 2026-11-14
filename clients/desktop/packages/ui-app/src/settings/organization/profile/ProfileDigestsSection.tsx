'use client';

import { useEffect, useState, type JSX } from 'react';
import { SettingsLink, useSettingsClient } from '../../host';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Heading,
  Skeleton,
} from '@canopy/ui-shared/components';
import type { DigestArchiveItem } from '@canopy/protocol/settings';
import { DigestList } from '../../digests/digest-list';
import { useSettingsErrorCopy, type SettingsFailure } from '../../errors';
import { fetchMemberProfileDigests } from './profile-api';
import { MEMBER_PROFILE_ERROR_SCOPE } from './use-member-paged-resource';

interface ProfileDigestsSectionProps {
  orgId: string;
  userId: string;
  /** Display name of the subject, used in the other-viewer empty copy. */
  memberName: string;
  /**
   * The viewer IS the subject. Changes the heading, the empty copy, and — most
   * importantly — where rows link: the owner goes to their own canonical
   * archive, everyone else to the member-scoped protected route.
   */
  isOwnProfile: boolean;
}

/** Plain sample rows the loading skeleton measures. */
const SAMPLE_DIGESTS: readonly DigestArchiveItem[] = [
  {
    externalId: 'sample-digest-1',
    cadence: 'WEEKLY',
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-01-08T00:00:00.000Z',
    headline: 'Shipped the checkout fix',
    variant: 'FULL',
    status: 'READY',
    billedCredits: null,
    createdAt: '2026-01-08T00:00:00.000Z',
  },
  {
    externalId: 'sample-digest-2',
    cadence: 'WEEKLY',
    periodStart: '2026-01-08T00:00:00.000Z',
    periodEnd: '2026-01-15T00:00:00.000Z',
    headline: 'Cleaned up billing',
    variant: 'FULL',
    status: 'READY',
    billedCredits: null,
    createdAt: '2026-01-15T00:00:00.000Z',
  },
];

/** The loaded tab: the heading, the archive link, and the digest rows. */
function ProfileDigestsView({
  digests,
  orgId,
  userId,
  memberName,
  isOwnProfile,
}: ProfileDigestsSectionProps & {
  digests: readonly DigestArchiveItem[];
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="profile-digests-tab">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading level={2} variant="title">
          {isOwnProfile ? 'Your work digests' : 'Shared digests'}
        </Heading>
        {isOwnProfile && (
          <SettingsLink
            href="/account/digests"
            className="text-s font-medium fg-accent hover:underline"
            data-testid="profile-digests-archive-link"
          >
            Open digest archive
          </SettingsLink>
        )}
      </div>
      <DigestList
        digests={digests}
        // The owner's rows go to the canonical personal permalink; another
        // member's go to the member-scoped route, which is the only one that
        // applies the share-safe projection.
        basePath={
          isOwnProfile
            ? '/account/digests'
            : `/organization/${orgId}/members/${userId}/digests`
        }
        emptyMessage={
          isOwnProfile
            ? 'No work digests yet. Generated and requested digests will appear here.'
            : // Reachable as a race: the tab was rendered because a feature
              // existed, and it was removed before this fetch resolved.
              `${memberName} hasn't shared any work digests with this organization.`
        }
      />
    </div>
  );
}

/**
 * The Digests tab body on an organization member profile.
 *
 * Fetches lazily (the tab only mounts this when selected) and renders whatever
 * the server decided the viewer may see. It deliberately does NO filtering of
 * its own: for the owner the route returns their complete archive, and for any
 * other member it returns only the READY digests explicitly featured for THIS
 * organization. Duplicating that rule here would create a second, drift-prone
 * definition of who can see what.
 *
 * There are no feature controls on these rows. Sharing is managed from the
 * digest detail Share popover, so this surface stays a read view.
 */
export function ProfileDigestsSection({
  orgId,
  userId,
  memberName,
  isOwnProfile,
}: ProfileDigestsSectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(MEMBER_PROFILE_ERROR_SCOPE);
  // Bumped by Retry to fetch again.
  const [reloadToken, setReloadToken] = useState(0);
  // The result carries the subject it belongs to rather than being reset by the
  // effect. Two reasons: clearing state from an effect body is a cascading
  // render (`react-hooks/set-state-in-effect`), and stamping the key makes a
  // response from a PREVIOUS org/member unusable rather than merely late — the
  // profile shell keeps this component mounted across those prop changes.
  const [result, setResult] = useState<
    | { key: string; items: DigestArchiveItem[] }
    | { key: string; items: null; error: SettingsFailure }
    | null
  >(null);
  const key = `${orgId}:${userId}`;

  useEffect(() => {
    let active = true;
    void (async (): Promise<void> => {
      try {
        const items = await fetchMemberProfileDigests(client, orgId, userId);
        if (active) setResult({ key, items });
      } catch (err: unknown) {
        // The route answers 404 for every authorization failure, so a specific
        // message here would be a guess. The generic load copy covers it.
        if (active)
          setResult({ key, items: null, error: errorCopy.loadFailure(err) });
      }
    })();
    return (): void => {
      active = false;
    };
  }, [client, orgId, userId, key, errorCopy, reloadToken]);

  // A result for a different subject reads as "still loading" for this one.
  const current = result?.key === key ? result : null;
  const digests = current?.items ?? null;

  if (current !== null && current.items === null) {
    return (
      <div data-testid="profile-digests-error">
        <ErrorBanner
          errorSource="profile-digests-section-current"
          error={current.error.copy}
          details={current.error.details}
          onRetry={() => {
            // Back to the loading placeholder while the fetch runs again.
            setResult(null);
            setReloadToken((token) => token + 1);
          }}
        />
      </div>
    );
  }

  if (digests === null) {
    return (
      <div data-testid="profile-digests-loading">
        <DelayedLoadingPlaceholder>
          <Skeleton
            loading
            label="Loading digests"
            testId="settings-skeleton-list"
          >
            <ProfileDigestsView
              digests={SAMPLE_DIGESTS}
              orgId={orgId}
              userId={userId}
              memberName={memberName}
              isOwnProfile={isOwnProfile}
            />
          </Skeleton>
        </DelayedLoadingPlaceholder>
      </div>
    );
  }

  return (
    <ProfileDigestsView
      digests={digests}
      orgId={orgId}
      userId={userId}
      memberName={memberName}
      isOwnProfile={isOwnProfile}
    />
  );
}
