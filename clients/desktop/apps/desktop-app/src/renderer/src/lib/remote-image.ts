import { useEffect, useState } from 'react';
import { allowsRemoteImages } from '@canopy/app-core';
import { useOptionalCanopyClient } from '@canopy/app-state';
import { useCustomizeDiscoveryEnabled } from '@canopy/ui-app/customize-discovery';

const resolvedImages = new Map<string, Promise<string | null>>();

/**
 * Distinct image URLs memoized before the least recently used one is dropped.
 *
 * Matches `MAX_CACHE_ENTRIES` in the main-process cache this delegates to, and
 * sized for the same reason: per-plugin publisher avatars put ~181 distinct
 * owners in the working set, which no longer fit the original 128. A miss here
 * is cheaper than a miss there — it costs an IPC round-trip rather than a
 * network fetch, because main answers from its own cache — but it still
 * re-renders the tile through a null state, so the two are kept in step.
 */
const MAX_RESOLVED_IMAGES = 512;

/** Accept only inert image data URLs returned by the main-process cache. */
export function safeRemoteImageUrl(value: string | undefined): string | null {
  if (!value) return null;
  return /^data:image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/]+=*$/i.test(
    value,
  )
    ? value
    : null;
}

/**
 * Whether this host may load remote images (avatars, favicons, catalog
 * artwork). Off in a local-only build through the `remoteImages` capability;
 * callers then keep their initials or default-icon fallback. Absent a client
 * provider the capability's default (allowed) applies.
 */
export function useRemoteImagesAllowed(): boolean {
  const client = useOptionalCanopyClient();
  return client === null || allowsRemoteImages(client.capabilities);
}

/** Resolve an untrusted image without allowing the renderer to request it. */
export function useSafeRemoteImageUrl(
  value: string | undefined,
): string | null {
  const [safeUrl, setSafeUrl] = useState<string | null>(null);
  const remoteImages = useRemoteImagesAllowed();
  // Main resolves differently while New Customize is on (a disk cache and
  // site icons), so each mode keeps its own entries here too: switching the
  // Labs experiment asks main again instead of reusing the other mode's
  // result.
  const discoveryEnabled = useCustomizeDiscoveryEnabled();
  useEffect(() => {
    let cancelled = false;
    setSafeUrl(null);
    if (!remoteImages || !value || !window.mcpServers?.resolveRemoteImage)
      return;
    const key = `${discoveryEnabled ? 'e' : 'p'}:${value}`;
    let pending = resolvedImages.get(key);
    if (pending) {
      // Re-insert to mark this key most recently used; a Map iterates in
      // insertion order, so without this the eviction below is FIFO and drops
      // entries for being old rather than for being unused.
      resolvedImages.delete(key);
      resolvedImages.set(key, pending);
    } else {
      if (resolvedImages.size >= MAX_RESOLVED_IMAGES) {
        const leastRecentlyUsed = resolvedImages.keys().next().value;
        if (leastRecentlyUsed !== undefined) {
          resolvedImages.delete(leastRecentlyUsed);
        }
      }
      // Wrapped rather than `.catch`ed directly: the bridge is only known to
      // EXIST from the guard above, not to return a thenable. A preload that
      // hands back anything else would otherwise throw inside this effect and
      // take the surrounding tree down, which is a steep price for a decorative
      // image. `Promise.resolve` passes a real promise through untouched.
      // The mode travels with the request, so main computes the result for
      // the mode it is cached under.
      pending = Promise.resolve(
        window.mcpServers.resolveRemoteImage(value, {
          enhanced: discoveryEnabled,
        }),
      )
        .then((resolved) => resolved ?? null)
        .catch(() => null);
      resolvedImages.set(key, pending);
      // New Customize keeps no miss either, so a retry deadline main honours
      // is not hidden behind this cache.
      if (discoveryEnabled) {
        const cached = pending;
        void cached.then((resolved) => {
          if (resolved === null && resolvedImages.get(key) === cached)
            resolvedImages.delete(key);
        });
      }
    }
    void pending.then((resolved) => {
      if (!cancelled) setSafeUrl(safeRemoteImageUrl(resolved ?? undefined));
    });
    return (): void => {
      cancelled = true;
    };
  }, [remoteImages, value, discoveryEnabled]);
  return safeUrl;
}
