/**
 * Products listed in OpenAI's official plugin marketplace, keyed by the plugin
 * name that lists them.
 *
 * This is product identity, not publisher identity, and the mark and the
 * attribution answer it from one table because they are the same question
 * asked twice. OpenAI maintains the connectors for Microsoft's, Google's and
 * GitHub's products, so its feed lists itself as the `author` of all of them
 * and ships no `logoUrl` at all. Rendered verbatim that reads "Teams, by
 * OpenAI" under a Microsoft logo — and says OpenAI twice over, because the
 * source line already names the marketplace.
 *
 * Products absent from this table keep whatever the feed declared and fall
 * through to their own source avatar or the neutral monogram, rather than
 * wearing the misleading OpenAI publisher mark.
 *
 * The marketplace id is what makes this safe: these names are trusted only
 * inside OpenAI's own curated feed, so an arbitrary plugin merely named
 * `github` cannot impersonate GitHub.
 *
 * Lives in `ui-shared` because many surfaces render this attribution — the
 * discovery card, the catalog detail, the marketplace table, the shared plugin
 * detail, the MCP server details, command-palette search, and the web portal —
 * and a table that corrected only some of them would leave the same plugin
 * credited two different ways in one app.
 */

/** The marketplace whose names this table is allowed to interpret. */
export const OPENAI_PLUGIN_MARKETPLACE_ID = 'openai-curated';
export const CLAUDE_PLUGIN_MARKETPLACE_ID = 'claude-plugins-official';

// GitHub org slugs are globally unique. Only exact matches to known org slugs
// receive a display name, so lookalikes keep their original handles.
const PUBLISHER_NAMES = new Map([
  ['anthropic', 'Anthropic'],
  ['anthropics', 'Anthropic'],
  ['asana', 'Asana'],
  ['atlassian', 'Atlassian'],
  ['aws', 'AWS'],
  ['awslabs', 'AWS Labs'],
  ['getsentry', 'Sentry'],
  ['github', 'GitHub'],
  ['google', 'Google'],
  ['grafana', 'Grafana'],
  ['microsoft', 'Microsoft'],
  ['mongodb', 'MongoDB'],
  ['openai', 'OpenAI'],
  ['pendo-io', 'Pendo'],
  ['shopify', 'Shopify'],
  ['spotify', 'Spotify'],
  ['unstoppabledomains', 'Unstoppable Domains'],
  ['upstash', 'Upstash'],
  ['vercel', 'Vercel'],
]);

export function marketplacePublisherDisplayName(name: string): string {
  const trimmed = name.trim();
  return PUBLISHER_NAMES.get(trimmed.toLowerCase()) ?? trimmed;
}

/** Providers report these catalogs by their repo name; people read these. */
const OFFICIAL_MARKETPLACE_NAMES: ReadonlyMap<string, string> = new Map([
  [CLAUDE_PLUGIN_MARKETPLACE_ID, 'Claude official'],
]);

/** A marketplace's name for display: tidy when a provider reports a raw id. */
export function marketplaceDisplayName(name: string): string {
  return OFFICIAL_MARKETPLACE_NAMES.get(name) ?? name;
}

/** One product in OpenAI's official marketplace, as Canopy identifies it. */
export interface OfficialMarketplaceProduct {
  /**
   * Key into `MCP_BRAND_LOGOS`, when the app ships that product mark.
   *
   * Deliberately the key rather than the resolved data URL: this module stays
   * free of the ~150 embedded logo blobs so it can sit in the `lib` barrel.
   */
  logoKey?: string;
  /** Who makes the product, when that is not the marketplace publisher. */
  vendor?: string;
}

/** The minimum a caller must know about a plugin to identify its product. */
export interface OfficialProductLookup {
  name: string;
  author?: string;
}

const OPENAI_CURATED_PRODUCTS: Readonly<
  Record<string, OfficialMarketplaceProduct>
> = {
  airtable: { logoKey: 'airtable', vendor: 'Airtable' },
  asana: { logoKey: 'asana', vendor: 'Asana' },
  'atlassian-rovo': { logoKey: 'atlassian', vendor: 'Atlassian' },
  box: { logoKey: 'box', vendor: 'Box' },
  canva: { logoKey: 'canva', vendor: 'Canva' },
  clickup: { logoKey: 'clickup', vendor: 'ClickUp' },
  cloudflare: { logoKey: 'cloudflare', vendor: 'Cloudflare' },
  'codex-security': { logoKey: 'openai', vendor: 'OpenAI' },
  datadog: { logoKey: 'datadog', vendor: 'Datadog' },
  dropbox: { logoKey: 'dropbox', vendor: 'Dropbox' },
  figma: { logoKey: 'figma', vendor: 'Figma' },
  fireflies: { logoKey: 'fireflies', vendor: 'Fireflies' },
  github: { logoKey: 'github', vendor: 'GitHub' },
  gmail: { logoKey: 'gmail-gmailmcp', vendor: 'Google' },
  'google-calendar': {
    logoKey: 'google-calendar-calendarmcp',
    vendor: 'Google',
  },
  'google-drive': { logoKey: 'google-drive-drivemcp', vendor: 'Google' },
  granola: { logoKey: 'granola', vendor: 'Granola' },
  linear: { logoKey: 'linear', vendor: 'Linear' },
  'mixpanel-headless': { logoKey: 'mixpanel', vendor: 'Mixpanel' },
  notion: { logoKey: 'notion', vendor: 'Notion' },
  'openai-ads-conversions': { logoKey: 'openai', vendor: 'OpenAI' },
  'openai-developers': { logoKey: 'openai', vendor: 'OpenAI' },
  'otter-ai': { logoKey: 'otter-ai', vendor: 'Otter.ai' },
  'outlook-calendar': { logoKey: 'microsoft-365', vendor: 'Microsoft' },
  'outlook-email': { logoKey: 'microsoft-365', vendor: 'Microsoft' },
  plaud: { logoKey: 'plaud', vendor: 'Plaud' },
  posthog: { logoKey: 'posthog', vendor: 'PostHog' },
  reclaim: { logoKey: 'reclaim', vendor: 'Reclaim' },
  sentry: { logoKey: 'sentry', vendor: 'Sentry' },
  sharepoint: { logoKey: 'microsoft-365', vendor: 'Microsoft' },
  shopify: { logoKey: 'shopify', vendor: 'Shopify' },
  slack: { logoKey: 'slack', vendor: 'Slack' },
  stripe: { logoKey: 'stripe', vendor: 'Stripe' },
  supabase: { logoKey: 'supabase', vendor: 'Supabase' },
  teams: { logoKey: 'microsoft-365', vendor: 'Microsoft' },
  todoist: { logoKey: 'todoist', vendor: 'Todoist' },
  trello: { logoKey: 'trello', vendor: 'Trello' },
  'twilio-developer-kit': { logoKey: 'twilio', vendor: 'Twilio' },
  vercel: { logoKey: 'vercel', vendor: 'Vercel' },
  zoom: { logoKey: 'zoom-for-claude', vendor: 'Zoom' },
  // No bundled mark ships for Zotero, so it keeps its favicon or monogram;
  // the listing is still OpenAI's wrapper around Zotero's product.
  zotero: { vendor: 'Zotero' },
};

/**
 * Every listing name the table identifies, so a check over the table cannot
 * drift from a hand-copied list of it.
 */
export const OFFICIAL_MARKETPLACE_PRODUCT_NAMES: readonly string[] =
  Object.freeze(Object.keys(OPENAI_CURATED_PRODUCTS));

/**
 * How the official feed names itself when it authored a wrapper.
 *
 * `author` on these rows answers "who wrote this plugin", which is a different
 * question from "whose product is this". Only that conflation is corrected, so
 * a vendor describing itself — `Linear Orbit, Inc`, `Canva Pty Ltd.` — keeps
 * its own, more precise wording.
 */
const OPENAI_PUBLISHER_NAMES: ReadonlySet<string> = new Set([
  'openai',
  'openai codex',
]);

function officialProduct(
  marketplaceId: string | undefined,
  plugin: OfficialProductLookup,
): OfficialMarketplaceProduct | undefined {
  if (marketplaceId !== OPENAI_PLUGIN_MARKETPLACE_ID) return undefined;
  const key = plugin.name.toLowerCase();
  // Own entries only: the name comes from the feed, and a plain-object lookup
  // would otherwise resolve `constructor` or `__proto__` through the
  // prototype chain rather than returning "not a listed product".
  return Object.prototype.hasOwnProperty.call(OPENAI_CURATED_PRODUCTS, key)
    ? OPENAI_CURATED_PRODUCTS[key]
    : undefined;
}

/** `MCP_BRAND_LOGOS` key for an official listing's product, when one ships. */
export function officialProductLogoKey(
  marketplaceId: string | undefined,
  plugin: OfficialProductLookup,
): string | undefined {
  if (marketplaceId === CLAUDE_PLUGIN_MARKETPLACE_ID) {
    const publisher = marketplacePublisherDisplayName(plugin.author ?? '');
    if (plugin.name.toLowerCase() === 'asana' && publisher === 'Asana')
      return 'asana';
    if (plugin.name.toLowerCase() === 'context7' && publisher === 'Upstash')
      return 'context7';
  }
  return officialProduct(marketplaceId, plugin)?.logoKey;
}

/**
 * Vendor of the product an official listing connects to, when the listing
 * credits the marketplace publisher instead. `undefined` means "keep the
 * author the feed declared".
 */
export function officialProductVendor(
  marketplaceId: string | undefined,
  plugin: OfficialProductLookup,
): string | undefined {
  const vendor = officialProduct(marketplaceId, plugin)?.vendor;
  if (vendor === undefined) return undefined;
  const author = plugin.author?.trim().toLowerCase() ?? '';
  return OPENAI_PUBLISHER_NAMES.has(author) ? vendor : undefined;
}

/** The author to display for a listing: its product's vendor, else its own. */
export function pluginDisplayAuthor(
  marketplaceId: string | undefined,
  plugin: OfficialProductLookup,
): string | undefined {
  return (
    officialProductVendor(marketplaceId, plugin) ??
    (marketplacePublisherDisplayName(plugin.author ?? '') || undefined)
  );
}
