import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/protocol/plugins';
import type { UnifiedPluginEntry } from './unified-plugin-entry';

/**
 * Bundled logos for the Unstoppable Code curated plugins (Sergii's Customize
 * QA, item 8), so they stop rendering as grey letters. Every logo shares one
 * identity: the same rounded-square tile in the Unstoppable Code blue
 * gradient, with one white glyph that says what the plugin does. Keys are the
 * curated catalog's plugin names (`curated/cloud`).
 */

const STROKE =
  'fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';

/** The glyph art, drawn on the 44-unit tile inside a 12–32 safe area. */
const GLYPHS: Readonly<Record<string, string>> = {
  // A lens with a downward chevron: research that goes deep.
  'deep-research': `<g ${STROKE}><circle cx="20" cy="20" r="7.5"/><path d="M25.5 25.5 31.5 31.5"/><path d="M17 18.6l3 3 3-3"/></g>`,
  // A globe: research across the web.
  'web-research': `<g ${STROKE}><circle cx="22" cy="22" r="9.5"/><ellipse cx="22" cy="22" rx="4" ry="9.5"/><path d="M12.5 22h19"/></g>`,
  // A pencil: writing in the author's own voice, not an AI's.
  'avoid-ai-writing': `<g ${STROKE}><path d="M13.5 30.5l1.6-5.6L26.4 13.6a2.3 2.3 0 0 1 3.3 0l.7.7a2.3 2.3 0 0 1 0 3.3L19.1 28.9Z"/><path d="M24.3 15.7l4 4"/><path d="M23 30.5h7.5"/></g>`,
  // Scissors: cutting the slop.
  unslop: `<g ${STROKE}><circle cx="15.5" cy="16.5" r="3.5"/><circle cx="15.5" cy="27.5" r="3.5"/><path d="M18.6 18.2 31 27.2M18.6 25.8 31 16.8"/></g>`,
  // A speech bubble with one short line: short answers.
  'short-answers': `<g ${STROKE}><path d="M16 12.5h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-7.5L16 30.5v-4a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3Z"/><path d="M18 19.5h5"/></g>`,
  // Two overlapping pages: writing a document together.
  'doc-coauthoring': `<g ${STROKE}><path d="M18.5 12.5h8l5 5V27"/><path d="M13 16.5h8.5l4.5 4.5v10.5H13Z"/><path d="M16.5 24.5h6M16.5 28h4"/></g>`,
  // Rising bars with an upward trend: content that ranks.
  'seo-content-creation': `<g ${STROKE}><path d="M15 31.5v-5M22 31.5v-9M29 31.5v-13"/><path d="M13.5 20.5l8-7"/><path d="M17.5 13.5h4v4"/></g>`,
  // A browser window with a sidebar layout: web UI design.
  'ui-design': `<g ${STROKE}><rect x="12.5" y="13.5" width="19" height="17" rx="2.5"/><path d="M12.5 18.5h19M18.5 18.5v12"/></g>`,
  // Code brackets around a design diamond: frontend design.
  'frontend-design': `<g ${STROKE}><path d="M17.5 16 12.5 22l5 6M26.5 16l5 6-5 6"/></g><path d="M22 18.3 25.2 22 22 25.7 18.8 22Z" fill="#FFFFFF"/>`,
};

function tile(glyph: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5470FF"/><stop offset="1" stop-color="#1C30D4"/></linearGradient></defs><rect width="44" height="44" rx="11" fill="url(#g)"/>${glyph}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * The curated catalog's marketplaces: the cloud-synced `curated/cloud` and
 * its provider-facing copy, brand-namespaced as `<brand>-curated`
 * (`unstoppable-code-curated`). Codex's own `openai-curated` is not ours.
 */
export function isCuratedCatalogMarketplaceId(marketplaceId: string): boolean {
  return (
    marketplaceId === CURATED_PLUGIN_MARKETPLACE_ID ||
    (marketplaceId.endsWith('-curated') && marketplaceId !== 'openai-curated')
  );
}

export const CURATED_PLUGIN_LOGOS: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(GLYPHS).map(([key, glyph]) => [key, tile(glyph)]),
  );

/** The bundled logo of a curated plugin row, by catalog key. */
export function curatedPluginLogo(
  entry: Pick<UnifiedPluginEntry, 'ref'>,
): string | undefined {
  const key =
    entry.ref.type === 'curated-plugin'
      ? entry.ref.key
      : entry.ref.type === 'marketplace-plugin' &&
          isCuratedCatalogMarketplaceId(entry.ref.marketplaceId)
        ? entry.ref.pluginName
        : undefined;
  return key !== undefined &&
    Object.prototype.hasOwnProperty.call(CURATED_PLUGIN_LOGOS, key)
    ? CURATED_PLUGIN_LOGOS[key]
    : undefined;
}
