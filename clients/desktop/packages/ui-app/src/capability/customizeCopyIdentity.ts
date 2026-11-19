import { useMemo } from 'react';
import { useCustomizeDiscoveryEnabled } from './CustomizeDiscoveryProvider';
import { customizePublisherLogoKey } from '@canopy/ui-shared/components';
import { entryIsBuiltIn, type UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import { curatedLogoKey } from '@canopy/ui-shared/lib/curated-logo-key';
import { curatedPluginLogo } from '@canopy/ui-shared/lib/curated-plugin-logos';
import { CUSTOMIZE_BRAND_LOGOS as MCP_BRAND_LOGOS } from '@canopy/ui-shared/lib/mcp-brand-logos';
import { siteBrandKey, siteIconUrl } from './catalogIntegrationKey';
import {
  githubOwnerAvatarUrl,
  marketplacePluginListingWithCopies,
  type UnifiedMarketplaceInput,
} from './unifiedPluginEntries';

/**
 * New Customize's identity for a tile (Sergii's Customize QA): its publisher
 * and its logo, by one shared rule for every kind, on desktop and Portal.
 * Only New Customize applies it; with the Labs experiment off every entry
 * keeps the projection's own publisher and logo.
 *
 * Logo chain:
 *   1. the item's own logo (bundled, declared, the product mark for a
 *      built-in item, a curated catalog mark)
 *   2. a merged copy's or its catalog entry's logo (`withCopiesIdentity`)
 *   3. the publisher's logo when it is a known org with one
 *   4. its GitHub owner's avatar (package source, GitHub homepage or a
 *      single-publisher marketplace's repository), else the site icon of its
 *      homepage or MCP server domain, else a one-word org publisher's GitHub
 *      avatar
 *   5. the letter avatar
 */

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function catalogMark(entry: UnifiedPluginEntry): string | undefined {
  const key = curatedLogoKey(entry);
  return key !== undefined &&
    Object.prototype.hasOwnProperty.call(MCP_BRAND_LOGOS, key)
    ? MCP_BRAND_LOGOS[key]
    : undefined;
}

/** Orgs whose logo is known though their name is not a bundled brand key. */
const KNOWN_PUBLISHER_LOGOS: Readonly<
  Record<string, { readonly brand?: string; readonly github?: string }>
> = {
  anthropic: { github: 'anthropics' },
  openai: { brand: 'openai' },
  github: { brand: 'github' },
  microsoft: { brand: 'microsoft-365' },
  google: { github: 'google' },
  vercel: { brand: 'vercel' },
};

type LogoFields = Pick<
  UnifiedPluginEntry,
  'logoUrl' | 'bundledLogo' | 'brandMark' | 'logoDerived'
>;

/** Step 3: a known publisher's logo, marked as a guess. */
function publisherLogo(publisher: string | undefined): LogoFields | undefined {
  const name = publisher?.trim();
  if (!name) return undefined;
  const known = KNOWN_PUBLISHER_LOGOS[name.toLowerCase()];
  if (known?.brand !== undefined && MCP_BRAND_LOGOS[known.brand] !== undefined)
    return { bundledLogo: MCP_BRAND_LOGOS[known.brand], logoDerived: true };
  if (known?.github !== undefined) {
    const avatar = githubOwnerAvatarUrl(`https://github.com/${known.github}`);
    if (avatar !== undefined) return { logoUrl: avatar, logoDerived: true };
  }
  const key = customizePublisherLogoKey({ authorName: name });
  return key !== undefined
    ? { bundledLogo: MCP_BRAND_LOGOS[key], logoDerived: true }
    : undefined;
}

/** Corporate suffixes dropped before reading a publisher as a GitHub org. */
const CORPORATE_SUFFIX =
  /[\s,]+(inc\.?|llc|ltd\.?|corp\.?|corporation|co\.?)$/i;

/**
 * Step 4, last resort: a one-word organization publisher ("HashiCorp",
 * "Apple Inc.") as its GitHub org's avatar. A person's two-word name is
 * never guessed. A missing org fails quietly to the letter.
 */
function publisherOrgAvatar(
  publisher: string | undefined,
): LogoFields | undefined {
  const name = publisher?.trim().replace(CORPORATE_SUFFIX, '');
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) return undefined;
  const avatar = githubOwnerAvatarUrl(
    `https://github.com/${name.toLowerCase()}`,
  );
  return avatar !== undefined
    ? { logoUrl: avatar, logoDerived: true }
    : undefined;
}

function hasOwnLogo(entry: UnifiedPluginEntry): boolean {
  return (
    entry.bundledLogo !== undefined ||
    entry.brandMark === true ||
    hasText(entry.logoUrl) ||
    catalogMark(entry) !== undefined
  );
}

/** One entry's publisher, product mark and logo chain (steps 1, 3, 4). */
export function customizeDiscoveryIdentity(
  entry: UnifiedPluginEntry,
): UnifiedPluginEntry {
  const next: UnifiedPluginEntry = { ...entry };
  if (!hasText(entry.authorName) && hasText(entry.derivedPublisher)) {
    next.authorName = entry.derivedPublisher;
    next.publisherDerived = true;
    if (!hasText(entry.ownershipLabel))
      next.ownershipLabel = entry.derivedPublisher;
  }
  // One rule for every kind: a built-in item wears the product mark.
  if (entryIsBuiltIn(entry)) next.brandMark = true;
  // A curated catalog plugin wears its Unstoppable Code logo wherever it
  // shows: installed, Browse, merged rows and detail pages alike.
  const curated = curatedPluginLogo(entry);
  if (curated !== undefined) {
    next.bundledLogo = curated;
    next.logoDerived = undefined;
    return next;
  }
  // A catalog mark travels as the row's own art: New Customize's marks are
  // not in the shared lookup the logo component reads on its own.
  const mark = catalogMark(next);
  if (next.bundledLogo === undefined && mark !== undefined)
    next.bundledLogo = mark;
  if (hasOwnLogo(next)) return next;
  // A bundled brand mark for the server or homepage host (DeepWiki, whose
  // site refuses icon fetches).
  const hostKey = siteBrandKey(entry.siteUrl);
  const fallback =
    (hostKey !== undefined &&
    Object.prototype.hasOwnProperty.call(MCP_BRAND_LOGOS, hostKey)
      ? { bundledLogo: MCP_BRAND_LOGOS[hostKey], logoDerived: true as const }
      : undefined) ??
    publisherLogo(next.authorName) ??
    (hasText(entry.derivedLogoUrl)
      ? { logoUrl: entry.derivedLogoUrl, logoDerived: true as const }
      : undefined) ??
    ((): LogoFields | undefined => {
      const icon = siteIconUrl(entry.siteUrl);
      return icon !== undefined
        ? { logoUrl: icon, logoDerived: true }
        : undefined;
    })() ??
    publisherOrgAvatar(next.authorName);
  return fallback !== undefined ? { ...next, ...fallback } : next;
}

/** A copy's logo, best first: bundled art, declared art, then guesses. */
function logoRank(entry: UnifiedPluginEntry): number {
  const guess = entry.logoDerived === true;
  if (entry.brandMark === true || catalogMark(entry) !== undefined) return 0;
  if (entry.bundledLogo !== undefined) return guess ? 2 : 0;
  if (hasText(entry.logoUrl)) return guess ? 3 : 1;
  return 4;
}

function logoOf(entry: UnifiedPluginEntry): LogoFields {
  return {
    logoUrl: entry.logoUrl,
    bundledLogo: entry.bundledLogo ?? catalogMark(entry),
    brandMark: entry.brandMark,
    logoDerived: entry.logoDerived,
  };
}

/**
 * A merged row's publisher and logo (CAN-6811, logo step 2): the best any
 * copy has, not only the copy the row installs. A declared publisher beats
 * a derived one; real art beats a guess.
 */
export function withCopiesIdentity(
  row: UnifiedPluginEntry,
  copies: readonly UnifiedPluginEntry[],
): UnifiedPluginEntry {
  const candidates = [row, ...copies];
  const publisher =
    candidates.find(
      (copy) => hasText(copy.authorName) && copy.publisherDerived !== true,
    ) ?? candidates.find((copy) => hasText(copy.authorName));
  const logo = candidates.reduce((best, copy) =>
    logoRank(copy) < logoRank(best) ? copy : best,
  );
  const next: UnifiedPluginEntry = { ...row };
  if (publisher !== undefined && publisher !== row) {
    next.authorName = publisher.authorName;
    next.publisherDerived = publisher.publisherDerived;
    if (!hasText(row.ownershipLabel) || row.ownershipLabel === row.authorName)
      next.ownershipLabel = publisher.authorName;
  }
  if (logo !== row && logoRank(logo) < logoRank(row))
    Object.assign(next, logoOf(logo));
  return next;
}

/**
 * A marketplace plugin's row with the publisher and logo its Customize tile
 * shows (logo step 2 across the listings grouped into that tile), for a
 * detail page opened on its own.
 */
export function marketplacePluginTileListing(
  marketplaces: readonly UnifiedMarketplaceInput[],
  ref: { marketplaceId: string; pluginName: string },
): UnifiedPluginEntry | undefined {
  const found = marketplacePluginListingWithCopies(marketplaces, ref);
  if (found === undefined) return undefined;
  return found.copies.length > 0
    ? withCopiesIdentity(found.listing, found.copies)
    : found.listing;
}

/**
 * An entry as New Customize shows it, for surfaces outside the section model
 * (detail pages). With the Labs experiment off it is the entry unchanged.
 */
export function useCustomizeEntryIdentity(
  entry: UnifiedPluginEntry,
): UnifiedPluginEntry {
  const enabled = useCustomizeDiscoveryEnabled();
  return useMemo(
    () => (enabled ? customizeDiscoveryIdentity(entry) : entry),
    [enabled, entry],
  );
}
