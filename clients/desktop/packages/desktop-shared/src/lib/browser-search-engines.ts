/** Compatibility path: these helpers live in `@canopy/protocol/preferences`. */
export {
  BROWSER_SEARCH_QUERY_PLACEHOLDER,
  DEFAULT_BROWSER_SEARCH_ENGINE_ID,
  MAX_CUSTOM_BROWSER_SEARCH_ENGINES,
  MAX_BROWSER_SEARCH_ENGINE_NAME_LENGTH,
  MAX_BROWSER_SEARCH_URL_TEMPLATE_LENGTH,
  BUILT_IN_BROWSER_SEARCH_ENGINES,
  isBuiltInBrowserSearchEngineId,
  resolveBrowserSearchEngine,
  browserSearchUrlTemplateError,
  buildBrowserSearchUrl,
  normalizeCustomBrowserSearchEngines,
} from '@canopy/protocol/preferences';
