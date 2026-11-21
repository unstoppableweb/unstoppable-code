import { useCallback, useContext, useSyncExternalStore } from 'react';
import {
  DEFAULT_LAYOUT_TIER,
  MOBILE_MEDIA_QUERY,
  PHONE_MEDIA_QUERY,
  isMobileLayoutTier,
  isPhoneLayoutTier,
  type LayoutTier,
} from '../lib/layout-tier';
import { LayoutTierContext } from './LayoutTierProvider';

// SSR-safe media-query hooks. No `window` access happens during server render:
// the server snapshot is a fixed value and the live snapshot/subscription only
// touch `window.matchMedia` on the client, so hydration stays consistent.

function hasMatchMedia(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  );
}

// ---------------------------------------------------------------------------
// Shared per-query subscription registry.
//
// WHY THIS EXISTS. These hooks are called from leaf components that render once
// per transcript row — `UserBubble` is the worst case, one call per user
// message. The naive shape (allocate a `MediaQueryList` inside `subscribe`, and
// call `window.matchMedia(...)` again inside `getSnapshot`) makes both the
// listener count and the per-render allocation scale with transcript length: a
// 500-turn conversation registers ~1000 native `change` listeners, and a resize
// across a tier boundary fans out to every bubble individually. That is the same
// shape as the `formatDate`/`Intl.DateTimeFormat` regression this repo records
// as the single hottest renderer frame.
//
// Instead every distinct query string owns exactly ONE cached `MediaQueryList`
// and exactly ONE native `change` listener, no matter how many components
// subscribe. Component-level callbacks live in a plain `Set` that the single
// native listener fans out to.
//
// KEYED ON THE `matchMedia` IDENTITY, not just the query string. Tests install a
// fresh `window.matchMedia` mock per case; a cache keyed only by query string
// would hand the next test the previous mock's list and silently assert against
// a dead object. Re-checking identity costs one reference comparison and makes
// the cache self-invalidating. In a browser the identity never changes, so this
// branch never runs in production.
// ---------------------------------------------------------------------------

interface QuerySubscription {
  list: MediaQueryList;
  listeners: Set<() => void>;
  notify: () => void;
}

const mediaQueryListCache = new Map<string, MediaQueryList>();
const querySubscriptions = new Map<string, QuerySubscription>();
let cachedMatchMedia: typeof window.matchMedia | null = null;

function syncCacheOwner(): void {
  if (window.matchMedia === cachedMatchMedia) {
    return;
  }
  // The `matchMedia` implementation was swapped out from under us (only ever a
  // test reinstalling its mock). Drop every cached list and subscription so the
  // next read rebuilds against the new implementation.
  for (const subscription of querySubscriptions.values()) {
    subscription.list.removeEventListener('change', subscription.notify);
  }
  querySubscriptions.clear();
  mediaQueryListCache.clear();
  cachedMatchMedia = window.matchMedia;
}

function getMediaQueryList(query: string): MediaQueryList | null {
  if (!hasMatchMedia()) {
    return null;
  }
  syncCacheOwner();
  const cached = mediaQueryListCache.get(query);
  if (cached) {
    return cached;
  }
  const created = window.matchMedia(query);
  mediaQueryListCache.set(query, created);
  return created;
}

function queryMatches(query: string): boolean {
  return getMediaQueryList(query)?.matches ?? false;
}

/**
 * Registers `onStoreChange` against the single shared listener for `query`.
 *
 * Returns an unsubscribe that removes the native listener only once the last
 * component subscribed to that query has gone away, so the registry does not
 * accumulate dead entries across navigation.
 */
function subscribeToQuery(
  query: string,
  onStoreChange: () => void,
): () => void {
  const list = getMediaQueryList(query);
  if (!list) {
    return (): void => {};
  }

  let subscription = querySubscriptions.get(query);
  if (!subscription) {
    const listeners = new Set<() => void>();
    const notify = (): void => {
      // Copy before iterating: a listener may unsubscribe during the fan-out.
      for (const listener of Array.from(listeners)) {
        listener();
      }
    };
    subscription = { list, listeners, notify };
    list.addEventListener('change', notify);
    querySubscriptions.set(query, subscription);
  }
  subscription.listeners.add(onStoreChange);

  return (): void => {
    // Re-read rather than closing over `subscription`: `syncCacheOwner()` may
    // have replaced the entry between subscribe and cleanup.
    const active = querySubscriptions.get(query);
    if (!active) {
      return;
    }
    active.listeners.delete(onStoreChange);
    if (active.listeners.size === 0) {
      active.list.removeEventListener('change', active.notify);
      querySubscriptions.delete(query);
    }
  };
}

/**
 * Reactively tracks whether a CSS media query currently matches.
 *
 * Returns `false` during server render and the first client paint (before the
 * effectful subscription resolves), then the real match state. Built on
 * `useSyncExternalStore` so it is concurrent-safe and hydration-safe.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      return subscribeToQuery(query, onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback((): boolean => {
    return queryMatches(query);
  }, [query]);

  const getServerSnapshot = (): boolean => false;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Reads the current responsive tier: `phone`, `tablet`, or `desktop`.
 *
 * WHY A TIER AND NOT ANOTHER BOOLEAN. Until this hook, the entire `/chat`
 * surface had exactly one breakpoint — `useIsMobile()`'s `(max-width: 1023px)`
 * — so a 360px phone and a 1000px tablet received byte-identical layout. A
 * phone is not a narrow tablet: it has one thumb's reach, no room for a tab
 * strip above the transcript, and no room for six composer controls. Three
 * named bands let a phone be treated as a phone without a second boolean that
 * can drift out of agreement with the first. The boundaries live in
 * `lib/layout-tier` so the server, this hook, and the tests cannot disagree
 * about them.
 *
 * WHICH QUERIES IT SUBSCRIBES TO, and why not the obvious pair. It watches the
 * phone query and the historical mobile (`max-width: 1023px`) query, rather
 * than phone and tablet. Deriving tablet as "mobile but not phone" keeps the
 * exact query string `useIsMobile()` has always used in the subscription set,
 * which is what makes {@link useIsMobile} re-expressible on top of this hook
 * with no behaviour change at any existing call site.
 *
 * FIRST PAINT. With a {@link LayoutTierProvider} above it, the seeded tier is
 * the server snapshot and the hydration value, so a phone hydrates the mobile
 * layout instead of painting the desktop one and snapping. Without a provider
 * the hook falls back to {@link DEFAULT_LAYOUT_TIER} for that one render,
 * which is `desktop` — precisely what `useMediaQuery` already returned — so an
 * unprovided tree (the marketing homepage's `ssr: false` composer, the
 * Electron renderer, every existing jsdom test) is unchanged. It must never
 * throw for a missing provider, and it must never ignore `matchMedia` in
 * favour of the seed.
 */
export function useLayoutTier(): LayoutTier {
  const seededTier = useContext(LayoutTierContext);

  const subscribe = useCallback((onStoreChange: () => void): (() => void) => {
    if (!hasMatchMedia()) {
      return (): void => {};
    }
    const unsubscribePhone = subscribeToQuery(PHONE_MEDIA_QUERY, onStoreChange);
    const unsubscribeMobile = subscribeToQuery(
      MOBILE_MEDIA_QUERY,
      onStoreChange,
    );
    return (): void => {
      unsubscribePhone();
      unsubscribeMobile();
    };
  }, []);

  const getSnapshot = useCallback((): LayoutTier => {
    if (!hasMatchMedia()) {
      // A client with no `matchMedia` (jsdom without the mock, an unusual
      // embedder) keeps whatever the server decided rather than being forced
      // to desktop.
      return seededTier ?? DEFAULT_LAYOUT_TIER;
    }
    if (queryMatches(PHONE_MEDIA_QUERY)) {
      return 'phone';
    }
    return queryMatches(MOBILE_MEDIA_QUERY) ? 'tablet' : 'desktop';
  }, [seededTier]);

  const getServerSnapshot = useCallback((): LayoutTier => {
    return seededTier ?? DEFAULT_LAYOUT_TIER;
  }, [seededTier]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * True on viewports narrower than Tailwind's `lg` breakpoint (1024px), i.e.
 * `(max-width: 1023px)`. Use to switch between the desktop layout and the
 * mobile drawer/sheet layout.
 *
 * Re-expressed on {@link useLayoutTier} rather than owning its own query, so
 * the two cannot answer differently about the same viewport. The query string,
 * the boundary, and the answer are all unchanged; the only new behaviour is
 * that a server-seeded tree now gets the right answer on its first paint
 * instead of `false`.
 */
export function useIsMobile(): boolean {
  return isMobileLayoutTier(useLayoutTier());
}

/**
 * True only on the phone tier (`<= 639px`). The narrow-only escape hatch for
 * treatments that must NOT reach a tablet, which the historical
 * {@link useIsMobile} could not express.
 */
export function useIsPhone(): boolean {
  return isPhoneLayoutTier(useLayoutTier());
}

/**
 * Whether the primary pointer is touch right now. Call it from an effect or a
 * handler before focusing a field on mount: focusing on touch opens the
 * on-screen keyboard before the user asks for it.
 */
export function isCoarsePointerNow(): boolean {
  return hasMatchMedia() && window.matchMedia('(pointer: coarse)').matches;
}
