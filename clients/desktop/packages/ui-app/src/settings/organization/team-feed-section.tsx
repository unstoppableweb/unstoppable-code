'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  ArrowUp,
  FeedIcon,
  Pause,
  Play,
  RefreshCw,
  UserPlus,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  buttonClassName,
  CenteredLoadingSpinner,
  Chip,
  DelayedLoadingPlaceholder,
  FilterDropdown,
  PageSearchControls,
  PageSearchField,
  PageSearchRow,
  EmptyState,
  ErrorBanner,
  SearchEmptyState,
  Dot,
  StatusGlyph,
  TextLinkButton,
  Tooltip,
} from '@canopy/ui-shared/components';
import type { FeedItem, FeedItemType } from '@canopy/protocol';
import { FEED_ITEM_TYPES } from '@canopy/protocol';
import type { OrganizationMember } from '@canopy/protocol/settings/organization';
import { useSettingsFeedSubscription } from '@canopy/app-state/settings';
import {
  SettingsLink,
  useSettingsClient,
  useSettingsPrivacy,
  useSettingsScrollElement,
} from '../host';
import {
  feedItemMatchesClientFilters,
  mergeLiveFeedItem,
} from './merge-live-feed-item';
import {
  getTeamFeed,
  getTeamFeedItem,
  TeamApiError,
  type TeamFeedFilters,
} from './team-api';
import { useSettingsLoadFailure } from '../errors';
import { FeedActorProfileLinksProvider, FeedItemCard } from './team-feed-cards';
import { TeamFeedSkeleton } from './team-feed-skeleton';
import { TeamPageHeaderActions } from './team-page-header-slot';
import { useViewerDataSharing } from './use-viewer-data-sharing';
import { OrganizationDataSharingOptIn } from './web-data-sharing-opt-in';
import type { SettingsFailure } from '../errors';
import { Surface } from '@canopy/ui-shared/components';

interface TeamFeedSectionProps {
  /** Org id used to fetch the feed and link the empty-state CTA. */
  orgId: string;
  /** Org display name for the data-sharing hint. */
  organizationName: string;
  /** Session identity supplied by the page; invalidates viewer evidence. */
  viewerIdentity?: string;
  /** Server-derived from the request user agent; mobile gets text guidance. */
  mobileBrowser: boolean;
  /** Whether the viewer can add members (controls the empty-state CTA). */
  canManageMembers: boolean;
  /** Current org members — drives actor avatars and the member filter. */
  members?: OrganizationMember[];
  /** When set, the feed opens anchored on this item's id and highlights it. */
  highlightItemId?: string;
  /**
   * The org is the viewer's personal organization: the feed is their own
   * activity, so there is no member filter, invitation, or member profile.
   */
  personal?: boolean;
}

/** Friendly labels for the activity-type filter chips. */
const FEED_TYPE_LABELS: Record<FeedItemType, string> = {
  pr_opened: 'PR opened',
  pr_merged: 'PR merged',
  plan_approved: 'Plan started',
  plan_shared: 'Plan shared',
  plan_updated: 'Plan updated',
  run_shared: 'Session shared',
  worktree_started: 'Worktree started',
  worktree_updated: 'Worktree updated',
  agent_session: 'Agent session',
  pipeline_run: 'Workflow run',
  run_failed: 'Run failed',
};

const SEARCH_DEBOUNCE_MS = 300;

/**
 * The feed's data-sharing hint (CAN-3383) waits for the first page and hides
 * under any filter, including a search the debounce has not applied yet.
 */
function isFeedSharingHintVisible(
  initialLoaded: boolean,
  hasActiveFilters: boolean,
  searchInput: string,
): boolean {
  return initialLoaded && !hasActiveFilters && searchInput.trim() === '';
}

/**
 * The organization Timeline — the primary team view. Streams already-synced
 * agent activity (PRs, plans, worktrees, agent sessions, pipeline runs,
 * failures) newest-first with cursor-based infinite scroll. When
 * {@link highlightItemId} is set, the feed opens on a permalink window around
 * that item and scrolls it into view.
 *
 * The header carries a live pause/play toggle and server-side filters (free-text
 * search, activity type, and member). New activity streams in through the
 * host's settings client ({@link useSettingsFeedSubscription}) and prepends
 * live by default; while paused — or while a search query is active (which
 * the client can't replicate locally) — inbound items are counted and
 * surfaced as an "N new" affordance. Resuming,
 * reconnecting, the "N new" button, and any filter change all route through
 * {@link reloadFeed}, which replaces the list with page 1 for the current
 * filters; subsequent infinite-scroll pages re-send the same filters. When the
 * stream is gated off, or stops for good (the session ended or access was
 * lost), the toggle degrades to a manual refresh control.
 */
export function TeamFeedSection({
  orgId,
  organizationName,
  viewerIdentity,
  mobileBrowser,
  canManageMembers,
  members,
  highlightItemId,
  personal = false,
}: TeamFeedSectionProps): JSX.Element {
  const client = useSettingsClient();
  const loadErrorCopy = useSettingsLoadFailure(
    'settings.organization.timeline',
  );
  const { blockClassName } = useSettingsPrivacy();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  // Which load failed, so Retry runs it again: the newest page, or the next.
  const [failedLoad, setFailedLoad] = useState<'page' | 'more'>('page');

  // Live subscription state. `live` is the pause/play toggle (live by default);
  // while paused (or while a search query masks client-side matching) inbound
  // items are counted in `bufferedCount` and surfaced as an "N new" affordance
  // instead of mutating the list. `liveRef` mirrors `live` so the stable
  // `handleLiveItem` callback reads the latest value without re-subscribing.
  const [live, setLive] = useState(true);
  const liveRef = useRef(true);
  const [bufferedCount, setBufferedCount] = useState(0);

  // Filter state. `searchInput` is the live input value; `debouncedQuery` is
  // what actually hits the server, so typing doesn't fire a request per keystroke.
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<Set<FeedItemType>>(
    () => new Set(),
  );
  const [selectedMember, setSelectedMember] = useState('');

  // The host's settings scrolling region, or `null` when this section renders
  // outside it. Drives the infinite-scroll observer's `root` below.
  const contentScrollElement = useSettingsScrollElement();

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Guards against overlapping fetches racing the IntersectionObserver.
  const fetchingRef = useRef(false);
  // Monotonic request token. A fresh load (loadInitial/reloadFeed) or a
  // loadMore bumps this and captures the value; results and the shared
  // fetchingRef are only applied/cleared by the request that still owns the
  // latest token. This invalidates a superseded in-flight request — e.g. a
  // filter-change reloadFeed firing mid loadMore — so a stale page can no
  // longer overwrite the newer list/cursor or leave fetchingRef stuck.
  const requestIdRef = useRef(0);
  const didScrollToAnchor = useRef(false);
  // Skips the filter-driven reload on first mount (the initial load handles it).
  const filtersInitialized = useRef(false);

  const filters = useMemo<TeamFeedFilters>(
    () => ({
      q: debouncedQuery.trim() || undefined,
      types: selectedTypes.size > 0 ? [...selectedTypes] : undefined,
      // selectedMember holds OrganizationMember.id, which is the User
      // externalId UUID; the server resolves it to the internal User.id for the
      // actor predicate (resolveActorInternalId), so this is the right value.
      actorId: selectedMember || undefined,
    }),
    [debouncedQuery, selectedTypes, selectedMember],
  );

  const hasActiveFilters =
    filters.q !== undefined ||
    (filters.types?.length ?? 0) > 0 ||
    filters.actorId !== undefined;

  // The data-sharing hint speaks about the unfiltered feed only.
  const viewerSharing = useViewerDataSharing(
    personal ? null : orgId,
    viewerIdentity,
  );
  const showSharingHint =
    isFeedSharingHintVisible(initialLoaded, hasActiveFilters, searchInput) &&
    !personal;

  const memberByUserId = useMemo(() => {
    const map = new Map<string, OrganizationMember>();
    for (const member of members ?? []) {
      map.set(member.id, member);
    }
    return map;
  }, [members]);

  // Debounce the search box into the query that drives the fetch.
  useEffect(() => {
    const id = window.setTimeout(
      () => setDebouncedQuery(searchInput),
      SEARCH_DEBOUNCE_MS,
    );
    return (): void => window.clearTimeout(id);
  }, [searchInput]);

  const loadInitial = useCallback(async (): Promise<void> => {
    // The component is remounted (via a `key`) whenever orgId/highlightItemId
    // change, so state starts clean and all setState here happens post-await —
    // no synchronous cascading renders inside the effect.
    //
    // Note: this deliberately calls getTeamFeed(orgId) with NO filters, unlike
    // reloadFeed below which always sends the active filters. That is safe only
    // because the re-key guarantees filter state is empty on mount. If you ever
    // reach loadInitial without re-keying, add the current filters here too or
    // the initial page will come back unfiltered.
    const requestId = ++requestIdRef.current;
    fetchingRef.current = true;
    try {
      if (highlightItemId) {
        try {
          const permalink = await getTeamFeedItem(
            client,
            orgId,
            highlightItemId,
          );
          if (requestId !== requestIdRef.current) {
            return;
          }
          setItems([...permalink.newer, permalink.anchor, ...permalink.older]);
          setNextCursor(permalink.backwardCursor);
          return;
        } catch (err) {
          // A missing/expired anchor degrades to the newest page rather than
          // dead-ending the whole feed.
          if (!(err instanceof TeamApiError) || err.status !== 404) {
            throw err;
          }
        }
      }
      const page = await getTeamFeed(client, orgId);
      if (requestId !== requestIdRef.current) {
        return;
      }
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      setFailedLoad('page');
      setError(loadErrorCopy(err));
    } finally {
      // Only the latest request owns the shared in-flight flag.
      if (requestId === requestIdRef.current) {
        fetchingRef.current = false;
      }
      setInitialLoaded(true);
    }
  }, [client, orgId, highlightItemId, loadErrorCopy]);

  /**
   * Reload-from-scratch with the current filters: replaces the list with the
   * newest page, ignoring any `highlightItemId` anchor. Shared by the refresh
   * button and every filter/search change.
   */
  const reloadFeed = useCallback(async (): Promise<void> => {
    // A reload preempts any in-flight loadMore: bumping the token invalidates
    // that older request so its stale page can't overwrite this filtered list.
    const requestId = ++requestIdRef.current;
    fetchingRef.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const page = await getTeamFeed(client, orgId, undefined, filters);
      if (requestId !== requestIdRef.current) {
        return;
      }
      setItems(page.items);
      setNextCursor(page.nextCursor);
      // The newest page already includes anything that was buffered, so any
      // reload (including filter/search changes) authoritatively drops the
      // "N new" badge — the optimistic clears at the call sites are just for
      // instant feedback.
      setBufferedCount(0);
    } catch (err) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      setFailedLoad('page');
      setError(loadErrorCopy(err));
    } finally {
      // Only the latest request owns the shared in-flight flag.
      if (requestId === requestIdRef.current) {
        fetchingRef.current = false;
      }
      setRefreshing(false);
      setInitialLoaded(true);
    }
  }, [client, orgId, filters, loadErrorCopy]);

  // Keep the ref in sync so `handleLiveItem` (stable across the subscription's
  // lifetime) reads the current pause/play state without re-subscribing.
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  // Fold an inbound live item into the list when live and unfiltered by search;
  // otherwise count it toward the "N new" affordance. Type/member filters are
  // applied client-side (in `mergeLiveFeedItem`); search (`q`) cannot be, so a
  // search query forces the buffered path.
  const handleLiveItem = useCallback(
    (item: FeedItem): void => {
      if (liveRef.current && filters.q === undefined) {
        setItems((prev) => mergeLiveFeedItem(prev, item, filters));
        return;
      }
      if (feedItemMatchesClientFilters(item, filters)) {
        setBufferedCount((count) => count + 1);
      }
    },
    [filters],
  );

  // On reconnect, refetch the newest page to reconcile any gap beyond the
  // gateway's cursor replay, and clear the buffered count (the fresh page
  // already includes whatever arrived while disconnected).
  const handleReconnect = useCallback((): void => {
    setBufferedCount(0);
    void reloadFeed();
  }, [reloadFeed]);

  // A terminal stream error (the session ended or access was lost) stops the
  // stream for good: the subscription is disabled, which closes it, and the
  // toolbar keeps the manual refresh control. Remounting (a new org) resets it.
  const [streamStopped, setStreamStopped] = useState(false);
  const subscription = useSettingsFeedSubscription({
    client,
    orgId,
    enabled: !streamStopped,
    onItem: handleLiveItem,
    onReconnect: handleReconnect,
  });
  if (
    !streamStopped &&
    subscription.state === 'disabled' &&
    subscription.error !== null
  ) {
    setStreamStopped(true);
  }
  const subscriptionState = subscription.state;

  // The "N new" affordance: catch up to the newest page and drop the buffer.
  const showBufferedItems = useCallback((): void => {
    setBufferedCount(0);
    void reloadFeed();
  }, [reloadFeed]);

  // Pause/play toggle. Resuming flushes via a newest-page catch-up so nothing
  // buffered while paused is lost; pausing keeps the connection open.
  const toggleLive = useCallback((): void => {
    setLive((prev) => {
      const next = !prev;
      // Keep the ref consistent immediately: an SSE event arriving between this
      // click and the `live`-syncing effect must observe the new mode, not the
      // stale one (the effect below is only a backstop for external `live`
      // changes). Assigning the derived value is idempotent under double-invoke.
      liveRef.current = next;
      if (next) {
        setBufferedCount(0);
        void reloadFeed();
      }
      return next;
    });
  }, [reloadFeed]);

  // Initial fetch. This is a genuine external sync (network call); the
  // success path eventually calls setState, which is the whole point of the
  // load.
  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  // Reload whenever filters change. Skipped on first mount so it doesn't race
  // (or duplicate) the initial load above.
  useEffect(() => {
    if (!filtersInitialized.current) {
      filtersInitialized.current = true;
      return;
    }
    void reloadFeed();
  }, [reloadFeed]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (fetchingRef.current || nextCursor === null) {
      return;
    }
    const requestId = ++requestIdRef.current;
    fetchingRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await getTeamFeed(client, orgId, nextCursor, filters);
      // If a reload preempted this loadMore, drop the stale page rather than
      // appending it to (and overwriting the cursor of) the newer list.
      if (requestId !== requestIdRef.current) {
        return;
      }
      // Dedupe by id: an item syncing between the first page load and this
      // call could otherwise appear in both pages.
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      setFailedLoad('more');
      setError(loadErrorCopy(err));
    } finally {
      // Only the latest request owns the shared in-flight flag.
      if (requestId === requestIdRef.current) {
        fetchingRef.current = false;
      }
      setLoadingMore(false);
    }
  }, [client, orgId, nextCursor, filters, loadErrorCopy]);

  /**
   * Run the failed load again. With nothing listed yet, the list goes back
   * to its placeholder until the newest page lands.
   */
  const retryLoad = useCallback((): void => {
    setError(null);
    if (failedLoad === 'more') {
      void loadMore();
      return;
    }
    if (items.length === 0) setInitialLoaded(false);
    void reloadFeed();
  }, [failedLoad, items.length, loadMore, reloadFeed]);

  // Infinite-scroll sentinel.
  //
  // `root` is REQUIRED, not cosmetic. Since the app collapsed onto the shared
  // sidebar chrome, this page renders inside a fixed-height scrolling region
  // rather than the document viewport. An observer left to its default root
  // watches the viewport, against which the sentinel — clipped inside the
  // nested scroller — never intersects, so paging stops dead after the first
  // page. `useAppContentScrollElement()` returns `null` outside the chrome
  // (a bare unit render), and `root: null` is exactly the old viewport
  // behavior, so the fallback is the previous semantics rather than a break.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || nextCursor === null) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMore();
        }
      },
      { root: contentScrollElement, rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return (): void => observer.disconnect();
  }, [contentScrollElement, loadMore, nextCursor]);

  // Scroll the permalink anchor into view once it has rendered.
  useEffect(() => {
    if (!highlightItemId || didScrollToAnchor.current || items.length === 0) {
      return;
    }
    const target = document.getElementById(`feed-item-${highlightItemId}`);
    if (target) {
      didScrollToAnchor.current = true;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [highlightItemId, items]);

  const toggleType = useCallback((type: FeedItemType): void => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const clearFilters = useCallback((): void => {
    setSearchInput('');
    setDebouncedQuery('');
    setSelectedTypes(new Set());
    setSelectedMember('');
  }, []);

  const header = (
    <div className="flex flex-col gap-3" data-testid="team-feed-header">
      {/* The page header above already names this page, so the toolbar
          leads with search and filters rather than an "Activity" title. Its
          live controls sit in the page header's actions. */}
      <TeamPageHeaderActions>
        {bufferedCount > 0 && (
          <Button
            variant="secondary"
            size="compact"
            onClick={showBufferedItems}
            data-testid="team-feed-new-items"
            aria-label={`Show ${bufferedCount > 99 ? '99+' : bufferedCount} new ${
              bufferedCount === 1 ? 'item' : 'items'
            }`}
          >
            <ArrowUp size={14} />
            {bufferedCount > 99 ? '99+' : bufferedCount} new
          </Button>
        )}

        {subscriptionState === 'disabled' ? (
          // Stream gated off or refused: fall back to manual refresh so the
          // feed is never worse than the poll-only experience.
          <Button
            variant="secondary"
            size="compact"
            onClick={() => void reloadFeed()}
            disabled={refreshing}
            data-testid="team-feed-refresh"
            aria-label="Refresh activity"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </Button>
        ) : (
          <Tooltip
            label={
              subscriptionState === 'reconnecting'
                ? 'Reconnecting…'
                : live
                  ? 'Live — pause updates'
                  : 'Paused — resume updates'
            }
          >
            <Button
              variant="secondary"
              size="compact"
              pressedHover
              onClick={toggleLive}
              data-testid="team-feed-live-toggle"
              aria-pressed={live}
              aria-label={live ? 'Pause live updates' : 'Resume live updates'}
            >
              {subscriptionState === 'open' ? (
                <Dot tone="success" />
              ) : subscriptionState === 'reconnecting' ? (
                <StatusGlyph state="running" size={12} />
              ) : (
                <StatusGlyph state="paused" size={12} />
              )}
              {live ? <Pause size={14} /> : <Play size={14} />}
              {live ? 'Live' : 'Paused'}
            </Button>
          </Tooltip>
        )}
      </TeamPageHeaderActions>
      <PageSearchRow>
        <PageSearchField
          value={searchInput}
          onValueChange={setSearchInput}
          placeholder="Search activity"
          aria-label="Search activity"
          data-testid="team-feed-search"
          clearTestId="team-feed-search-clear"
        />
        {!personal && (members?.length ?? 0) > 0 && (
          <PageSearchControls>
            <FilterDropdown<string>
              title="Member"
              label={
                members?.find((member) => member.id === selectedMember)?.name ??
                'All members'
              }
              anyLabel="All members"
              options={(members ?? []).map((member) => ({
                value: member.id,
                label: member.name,
              }))}
              selected={selectedMember === '' ? [] : [selectedMember]}
              onToggle={(memberId): void =>
                setSelectedMember(memberId === selectedMember ? '' : memberId)
              }
              onClear={(): void => setSelectedMember('')}
              testId="team-feed-member-filter"
              replayPrivacy={{ blockClassName }}
            />
          </PageSearchControls>
        )}
        {hasActiveFilters && (
          <span className="shrink-0 whitespace-nowrap text-s">
            <TextLinkButton
              onClick={clearFilters}
              data-testid="team-feed-clear-filters"
            >
              Clear filters
            </TextLinkButton>
          </span>
        )}
      </PageSearchRow>

      <div
        className="flex flex-wrap gap-1.5"
        data-testid="team-feed-type-filter"
        role="group"
        aria-label="Filter by activity type"
      >
        {FEED_ITEM_TYPES.map((type) => {
          const active = selectedTypes.has(type);
          return (
            <Chip
              key={type}
              onClick={() => toggleType(type)}
              selected={active}
              actionTestId={`team-feed-type-${type}`}
            >
              {FEED_TYPE_LABELS[type]}
            </Chip>
          );
        })}
      </div>
    </div>
  );

  let body: JSX.Element;
  if (!initialLoaded) {
    body = (
      <DelayedLoadingPlaceholder slowNote="Still loading the timeline…">
        <TeamFeedSkeleton orgId={orgId} label="Loading the timeline" />
      </DelayedLoadingPlaceholder>
    );
  } else if (items.length === 0) {
    body = (
      <Surface variant="raised">
        {error && (
          <div className="px-6 pt-6">
            <ErrorBanner
              errorSource="team-feed-section"
              error={error?.copy}
              details={error?.details}
              onRetry={retryLoad}
            />
          </div>
        )}
        {hasActiveFilters ? (
          <div className="px-6">
            <SearchEmptyState
              testId="team-feed-no-results"
              title="No activity matches these filters"
              actionLabel="Clear filters"
              onAction={clearFilters}
              actionTestId="team-feed-no-results-clear"
            />
          </div>
        ) : (
          <div className="px-6">
            <EmptyState
              icon={
                <FeedIcon
                  size={24}
                  aria-hidden="true"
                  className="fg-tertiary"
                />
              }
              title="No activity yet"
              subtitle={
                personal
                  ? 'Your agent runs, plans, commits, and updates will appear here as you work.'
                  : "This is your organization's timeline. As people get to work, their agent runs, plans, commits, and updates will stream in here so everyone stays in sync."
              }
              action={
                !personal && canManageMembers ? (
                  <SettingsLink
                    href={`/organization/${orgId}/members?invite=1`}
                    data-testid="team-feed-invite-cta"
                    className={buttonClassName({
                      variant: 'secondary',
                      size: 'compact',
                    })}
                  >
                    <UserPlus size={14} />
                    Invite people
                  </SettingsLink>
                ) : undefined
              }
            />
          </div>
        )}
      </Surface>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <FeedItemCard
            key={item.id}
            item={item}
            orgId={orgId}
            highlighted={item.id === highlightItemId}
            member={memberByUserId.get(item.actor.userId) ?? null}
          />
        ))}

        {error && (
          <ErrorBanner
            errorSource="team-feed-section"
            error={error?.copy}
            details={error?.details}
            onRetry={retryLoad}
          />
        )}

        {nextCursor !== null && (
          <div
            ref={sentinelRef}
            data-testid="team-feed-sentinel"
            className="py-4"
          >
            {loadingMore && (
              <DelayedLoadingPlaceholder>
                <CenteredLoadingSpinner />
              </DelayedLoadingPlaceholder>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <FeedActorProfileLinksProvider value={!personal}>
      <section data-testid="team-feed-section" className="flex flex-col gap-4">
        {header}
        {showSharingHint && (
          <OrganizationDataSharingOptIn
            feature="feed-activity"
            orgId={orgId}
            organizationName={organizationName}
            mobileBrowser={mobileBrowser}
            sharing={viewerSharing}
          />
        )}
        {body}
      </section>
    </FeedActorProfileLinksProvider>
  );
}
