import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import {
  fetchPinnedHttpGetResponse,
  type PinnedHttpAddress,
} from './pinned-http-fetch';
import { isNonPublicIpAddress } from './network-address';

const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Distinct image URLs held before the least recently used one is dropped.
 *
 * Sized for the working set, not arbitrarily: this cache was written for the
 * curated MCP catalog's few dozen logos, but plugin entries now resolve a
 * publisher avatar PER PLUGIN, which is ~181 distinct owners across a real
 * marketplace catalog. At the old 128 the set no longer fit, so simply
 * browsing evicted and refetched in a loop. Entries are base64 rasters of a
 * couple of KB, so 512 costs on the order of a megabyte and leaves headroom
 * for the catalog to grow.
 */
export const MAX_CACHE_ENTRIES = 512;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

const cache = new Map<string, Promise<string | null>>();

/** Largest page read while looking for a site's icon links. */
const MAX_PAGE_BYTES = 256 * 1024;
/**
 * How long a miss is left alone before trying again: a day for a throttle,
 * a bot check or a refusal (429, 403, a challenge page), which may clear;
 * a week for a plain miss (no icon, a 404, not an image).
 */
const THROTTLED_RETRY_MS = 24 * 60 * 60 * 1000;
const MISS_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a stored image is used before it is fetched again. */
const IMAGE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** What a throttled miss writes to the disk cache. */
const THROTTLED_MARKER = '#retry';

/**
 * Set when the last fetch of a URL met a throttle or a bot check, so its
 * miss is kept only for a day. Read and cleared by `resolveUncached`.
 */
const throttledUrls = new Set<string>();

/**
 * Set when a server answered that a URL has no usable image (404, 410, not
 * an image, empty, too large, a page with no icon links). Only these misses
 * persist; no answer at all (DNS, timeout, a refused connection) or a server
 * error is tried again next launch. Read and cleared by `resolveUncached`.
 */
const answeredMissUrls = new Set<string>();

/** A status that means "nothing here" rather than "try again". */
function isAnsweredMissStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** A response that says "not now" rather than "nothing here". */
function isThrottleResponse(response: Response): boolean {
  if (response.status === 429 || response.status === 403) return true;
  if (response.status !== 503) return false;
  // A challenge page answers with HTML (Cloudflare and similar).
  return (
    response.headers
      .get('content-type')
      ?.toLowerCase()
      .includes('text/html') === true || response.headers.has('cf-mitigated')
  );
}

/**
 * Where resolved logos persist across launches. Set once by main at startup;
 * unset (tests, other hosts), the cache is memory-only.
 */
let diskCacheDir: string | undefined;

export function configureRemoteImageDiskCache(dir: string): void {
  diskCacheDir = dir;
}

function diskCachePath(rawUrl: string): string | undefined {
  if (diskCacheDir === undefined) return undefined;
  const key = createHash('sha256').update(rawUrl).digest('hex');
  return join(diskCacheDir, `${key}.txt`);
}

/**
 * A disk hit: a stored image (`fresh` while inside its refresh window), a
 * recent miss (`image: null`), or `undefined` when nothing usable is
 * stored. Any read failure is a miss of the disk only.
 */
async function readDiskCache(
  rawUrl: string,
): Promise<{ image: string | null; fresh: boolean } | undefined> {
  const file = diskCachePath(rawUrl);
  if (file === undefined) return undefined;
  try {
    const text = await readFile(file, 'utf8');
    const { mtimeMs } = await stat(file);
    const age = Date.now() - mtimeMs;
    if (text.startsWith('data:image/'))
      return { image: text, fresh: age < IMAGE_REFRESH_MS };
    const ttl = text === THROTTLED_MARKER ? THROTTLED_RETRY_MS : MISS_RETRY_MS;
    return age < ttl ? { image: null, fresh: true } : undefined;
  } catch {
    return undefined;
  }
}

async function writeDiskCache(
  rawUrl: string,
  value: string | null,
  throttled: boolean,
): Promise<void> {
  const file = diskCachePath(rawUrl);
  if (file === undefined || diskCacheDir === undefined) return;
  try {
    await mkdir(diskCacheDir, { recursive: true });
    await writeFile(file, value ?? (throttled ? THROTTLED_MARKER : ''), 'utf8');
  } catch {
    // A logo that cannot be cached is still shown this session.
  }
}

async function resolvePublicTarget(
  rawUrl: string,
): Promise<{ url: URL; addresses: PinnedHttpAddress[] } | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  const resolved = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    resolved.length === 0 ||
    resolved.some(
      ({ address }) => isIP(address) === 0 || isNonPublicIpAddress(address),
    )
  ) {
    return null;
  }
  return {
    url,
    addresses: resolved.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    })),
  };
}

async function fetchRemoteImage(
  rawUrl: string,
  /** New Customize also accepts .ico, for site icons. */
  acceptIcons = false,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let nextUrl = rawUrl;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const target = await resolvePublicTarget(nextUrl);
      if (!target) return null;
      const response = await fetchPinnedHttpGetResponse(
        target.url,
        target.addresses,
        {
          Accept: acceptIcons
            ? 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/x-icon'
            : 'image/png,image/jpeg,image/gif,image/webp,image/avif',
        },
        controller.signal,
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === MAX_REDIRECTS) {
          answeredMissUrls.add(rawUrl);
          return null;
        }
        try {
          nextUrl = new URL(location, target.url).toString();
        } catch {
          answeredMissUrls.add(rawUrl);
          return null;
        }
        continue;
      }
      if (!response.ok) {
        if (isThrottleResponse(response)) throttledUrls.add(rawUrl);
        else if (isAnsweredMissStatus(response.status))
          answeredMissUrls.add(rawUrl);
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      const contentLength = Number(response.headers.get('content-length'));
      if (
        !contentType ||
        !ALLOWED_IMAGE_TYPES.has(contentType) ||
        (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES)
      ) {
        answeredMissUrls.add(rawUrl);
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.body) {
        answeredMissUrls.add(rawUrl);
        return null;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_IMAGE_BYTES) {
          answeredMissUrls.add(rawUrl);
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
      if (totalBytes === 0) {
        answeredMissUrls.add(rawUrl);
        return null;
      }
      return `data:${contentType};base64,${Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        totalBytes,
      ).toString('base64')}`;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reads a public page's start as text, for its icon links, following a
 * bounded chain of redirects (each hop validated and pinned like an image
 * fetch). Returns the page and its final URL, which icon links resolve
 * against.
 */
async function fetchPageHead(
  rawUrl: string,
): Promise<{ html: string; url: URL } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let nextUrl = rawUrl;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const target = await resolvePublicTarget(nextUrl);
      if (!target) return null;
      const response = await fetchPinnedHttpGetResponse(
        target.url,
        target.addresses,
        { Accept: 'text/html' },
        controller.signal,
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === MAX_REDIRECTS) {
          answeredMissUrls.add(rawUrl);
          return null;
        }
        try {
          nextUrl = new URL(location, target.url).toString();
        } catch {
          answeredMissUrls.add(rawUrl);
          return null;
        }
        continue;
      }
      if (!response.ok || !response.body) {
        if (isThrottleResponse(response)) throttledUrls.add(rawUrl);
        else if (!response.ok && isAnsweredMissStatus(response.status))
          answeredMissUrls.add(rawUrl);
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < MAX_PAGE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        chunks.push(value);
      }
      await reader.cancel().catch(() => undefined);
      return {
        html: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
          'utf8',
        ),
        url: target.url,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Icon hrefs a page declares, apple-touch-icon first. */
function pageIconHrefs(html: string, base: URL): string[] {
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  const found: { href: string; touch: boolean }[] = [];
  for (const link of links) {
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(link)?.[1]?.toLowerCase();
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(link)?.[1];
    if (!rel || !href || !/\bicon\b|apple-touch-icon/.test(rel)) continue;
    // `data:` icons (`href="data:,"` declares none) are never fetched or kept.
    if (/^\s*data:/i.test(href)) continue;
    if (/\.svg(?:$|[?#])/i.test(href)) continue;
    try {
      found.push({
        href: new URL(href, base).toString(),
        touch: rel.includes('apple-touch-icon'),
      });
    } catch {
      // A malformed href is skipped.
    }
  }
  return [
    ...found.filter((icon) => icon.touch),
    ...found.filter((icon) => !icon.touch),
  ].map((icon) => icon.href);
}

/**
 * A site's icon (Sergii's Customize QA, logo step 4): a request for a site's
 * `/favicon.ico` tries its apple-touch-icon first, then the favicon, then the
 * raster icons its home page declares. Every fetch goes through the same
 * public-address and size checks; any failure is quiet.
 */
async function fetchSiteIcon(rawUrl: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const origin = url.origin;
  const page = `${origin}/`;
  const tried: string[] = [];
  const attempt = async (candidate: string): Promise<string | null> => {
    tried.push(candidate);
    return fetchRemoteImage(candidate, true);
  };
  // The whole miss is an answered one only when every try was answered;
  // a home page that loaded is an answer, whatever icons it declares.
  let pageAnswered = false;
  const result = await (async (): Promise<string | null> => {
    for (const candidate of [`${origin}/apple-touch-icon.png`, rawUrl]) {
      const image = await attempt(candidate);
      if (image) return image;
    }
    tried.push(page);
    const fetched = await fetchPageHead(page);
    if (!fetched) return null;
    pageAnswered = true;
    const hrefs = pageIconHrefs(fetched.html, fetched.url).slice(0, 4);
    for (const href of hrefs) {
      const image = await attempt(href);
      if (image) return image;
    }
    return null;
  })();
  const everyTryAnswered = tried.every(
    (candidate) =>
      answeredMissUrls.has(candidate) || (candidate === page && pageAnswered),
  );
  // Each try's own marker goes, the requested URL's included (its favicon
  // try may have set it); only a miss every try answered persists.
  for (const candidate of tried) answeredMissUrls.delete(candidate);
  if (result === null && everyTryAnswered) answeredMissUrls.add(rawUrl);
  // A throttle on any try (DeepWiki answers 429) makes the whole miss a
  // retry-later one.
  if (
    result === null &&
    tried.some((candidate) => throttledUrls.has(candidate))
  )
    throttledUrls.add(rawUrl);
  for (const candidate of tried)
    if (candidate !== rawUrl) throttledUrls.delete(candidate);
  return result;
}

function isSiteIconRequest(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).pathname === '/favicon.ico';
  } catch {
    return false;
  }
}

/**
 * New Customize's resolution (the customize-discovery Labs experiment): a
 * disk cache across launches and site icons. With it off, a logo resolves
 * exactly as before: one fetch, kept in memory for the session.
 */
async function resolveUncached(
  rawUrl: string,
  enhanced: boolean,
): Promise<string | null> {
  if (!enhanced) {
    const image = await fetchRemoteImage(rawUrl);
    throttledUrls.delete(rawUrl);
    answeredMissUrls.delete(rawUrl);
    return image;
  }
  const stored = await readDiskCache(rawUrl);
  if (stored?.fresh === true) return stored.image;
  const image = isSiteIconRequest(rawUrl)
    ? await fetchSiteIcon(rawUrl)
    : await fetchRemoteImage(rawUrl, true);
  const throttled = throttledUrls.delete(rawUrl);
  const answered = answeredMissUrls.delete(rawUrl);
  // An expired image is refetched; when the refetch gets no answer the
  // stored image keeps showing (and is tried again next time).
  if (image === null && !throttled && !answered && stored?.image)
    return stored.image;
  // An image, a throttle or a server's "nothing here" persists; no answer
  // (offline, a timeout, a server error) is tried again next launch.
  if (image !== null || throttled || answered)
    await writeDiskCache(rawUrl, image, throttled);
  return image;
}

async function enhancedResolution(): Promise<boolean> {
  try {
    const { isCustomizeDiscoveryEnabledInMain } =
      await import('../lib/customize-discovery-enabled');
    return await isCustomizeDiscoveryEnabledInMain();
  } catch {
    return false;
  }
}

/** Resolve and cache an untrusted remote image as a renderer-safe data URL. */
export function resolveRemoteImageDataUrl(
  rawUrl: unknown,
  /**
   * The caller asked for New Customize's resolution. Used only while the
   * experiment is on here too, so a result is never computed in a mode the
   * caller didn't ask for.
   */
  requestedEnhanced = false,
): Promise<string | null> {
  if (typeof rawUrl !== 'string' || !rawUrl) return Promise.resolve(null);
  if (!requestedEnhanced) return resolveCached(rawUrl, false);
  return enhancedResolution().then((enhanced) =>
    resolveCached(rawUrl, enhanced),
  );
}

function resolveCached(
  rawUrl: string,
  enhanced: boolean,
): Promise<string | null> {
  // Each mode keeps its own entries, so turning New Customize off never
  // serves a result only its resolution found.
  const key = `${enhanced ? 'e' : 'p'}:${rawUrl}`;
  const existing = cache.get(key);
  if (existing) {
    // Re-insert to mark this key most recently used. A Map iterates in
    // insertion order, so without the delete the eviction below is FIFO: a
    // logo visible on every frame would be dropped purely for having been
    // requested early, then refetched, then dropped again.
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const leastRecentlyUsed = cache.keys().next().value;
    if (leastRecentlyUsed !== undefined) cache.delete(leastRecentlyUsed);
  }
  const pending = resolveUncached(rawUrl, enhanced);
  cache.set(key, pending);
  // New Customize keeps no miss in memory: the next request reads the disk
  // entry, whose retry deadline then applies within a long session too.
  if (enhanced)
    void pending.then((image) => {
      if (image === null && cache.get(key) === pending) cache.delete(key);
    });
  return pending;
}
