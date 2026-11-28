import type { BrowserSearchEngine } from './types';

// ---------------------------------------------------------------------------
// Browser-bar search engines
// ---------------------------------------------------------------------------
//
// Like Chrome, a search engine is a name and a URL template with `%s` where
// the typed words go. The built-in list is fixed; people can add their own,
// which live in preferences next to the chosen engine's id.

/** The query placeholder in a search URL template, as in Chrome. */
export const BROWSER_SEARCH_QUERY_PLACEHOLDER = '%s';

export const DEFAULT_BROWSER_SEARCH_ENGINE_ID = 'google';

/** At most this many search engines of your own are kept. */
export const MAX_CUSTOM_BROWSER_SEARCH_ENGINES = 50;

/** Longest search engine name kept, in characters. */
export const MAX_BROWSER_SEARCH_ENGINE_NAME_LENGTH = 80;

/** Longest search URL template kept, in characters. */
export const MAX_BROWSER_SEARCH_URL_TEMPLATE_LENGTH = 2048;

const GOOGLE: BrowserSearchEngine = {
  id: DEFAULT_BROWSER_SEARCH_ENGINE_ID,
  name: 'Google',
  urlTemplate: 'https://www.google.com/search?q=%s',
};

export const BUILT_IN_BROWSER_SEARCH_ENGINES: readonly BrowserSearchEngine[] = [
  GOOGLE,
  {
    id: 'bing',
    name: 'Bing',
    urlTemplate: 'https://www.bing.com/search?q=%s',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    urlTemplate: 'https://duckduckgo.com/?q=%s',
  },
  {
    id: 'brave',
    name: 'Brave Search',
    urlTemplate: 'https://search.brave.com/search?q=%s',
  },
  {
    id: 'ecosia',
    name: 'Ecosia',
    urlTemplate: 'https://www.ecosia.org/search?q=%s',
  },
];

export function isBuiltInBrowserSearchEngineId(id: string): boolean {
  return BUILT_IN_BROWSER_SEARCH_ENGINES.some((engine) => engine.id === id);
}

/**
 * The engine the Browser bar searches with: the chosen one when it still
 * exists, otherwise Google. Returns a stored object, never a copy, so a
 * store selector can use it directly.
 */
export function resolveBrowserSearchEngine(
  id: string | undefined,
  custom: readonly BrowserSearchEngine[],
): BrowserSearchEngine {
  if (id === undefined) {
    return GOOGLE;
  }
  return (
    BUILT_IN_BROWSER_SEARCH_ENGINES.find((engine) => engine.id === id) ??
    custom.find((engine) => engine.id === id) ??
    GOOGLE
  );
}

/**
 * Why a search URL template cannot be used, or `null` when it can. A template
 * is an http(s) URL with `%s` where the search words go.
 */
export function browserSearchUrlTemplateError(template: string): string | null {
  const trimmed = template.trim();
  if (!trimmed.includes(BROWSER_SEARCH_QUERY_PLACEHOLDER)) {
    return 'Include %s where the search words go.';
  }
  if (trimmed.length > MAX_BROWSER_SEARCH_URL_TEMPLATE_LENGTH) {
    return 'Enter a shorter URL.';
  }
  try {
    const parsed = new URL(
      trimmed.split(BROWSER_SEARCH_QUERY_PLACEHOLDER).join('query'),
    );
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0
    ) {
      return null;
    }
  } catch {
    // Not a URL; reported below.
  }
  return 'Enter an http or https URL, like https://example.com/search?q=%s.';
}

/**
 * The search URL for `query`: every `%s` in the template replaced with the
 * encoded words. In the query string spaces become `+`, as Chrome sends them;
 * in the path they stay `%20`.
 */
export function buildBrowserSearchUrl(
  urlTemplate: string,
  query: string,
): string {
  const encoded = encodeURIComponent(query);
  const queryStart = urlTemplate.indexOf('?');
  return urlTemplate.replace(/%s/g, (_placeholder, offset: number) =>
    queryStart !== -1 && offset > queryStart
      ? encoded.replace(/%20/g, '+')
      : encoded,
  );
}

function isBrowserSearchEngine(value: unknown): value is BrowserSearchEngine {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.urlTemplate === 'string'
  );
}

/**
 * Stored search engines of your own, cleaned on load: usable templates only,
 * trimmed names, no ids that collide with a built-in engine or each other.
 */
export function normalizeCustomBrowserSearchEngines(
  value: unknown,
): BrowserSearchEngine[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const engines: BrowserSearchEngine[] = [];
  for (const entry of value) {
    if (!isBrowserSearchEngine(entry)) {
      continue;
    }
    const id = entry.id.trim();
    const name = entry.name.trim();
    const urlTemplate = entry.urlTemplate.trim();
    if (
      id.length === 0 ||
      seen.has(id) ||
      isBuiltInBrowserSearchEngineId(id) ||
      name.length === 0 ||
      name.length > MAX_BROWSER_SEARCH_ENGINE_NAME_LENGTH ||
      browserSearchUrlTemplateError(urlTemplate) !== null
    ) {
      continue;
    }
    seen.add(id);
    engines.push({ id, name, urlTemplate });
    if (engines.length >= MAX_CUSTOM_BROWSER_SEARCH_ENGINES) {
      break;
    }
  }
  return engines;
}
