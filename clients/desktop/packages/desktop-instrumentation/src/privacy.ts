import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
import { RENDERER_SCHEME_ORIGIN } from '@canopy/desktop-shared/lib/renderer-scheme';
import type { DesktopInstrumentationContext } from './types';
import { RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX } from './config';

const HOME_PATH_PATTERNS: RegExp[] = [
  /\/Users\/[^/\s)]+/g,
  /\/home\/[^/\s)]+/g,
  /[A-Za-z]:\\Users\\[^\\\s)]+/g,
];

const RENDERER_ASSET_FILE_URL_PATTERN =
  /file:\/\/\/[^\s'"`?#]*\/out\/renderer\/assets\/([^:\s'"`)?#]+?\.(?:js|css))(?=[:\s'"`)?#]|$)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The same assets served from the renderer scheme (Settings → Labs →
 * "Open windows faster"): `app-renderer://bundle/assets/<name>.js|css`. Only
 * the exact origin matches, so look-alike hosts are not rewritten.
 */
const RENDERER_ASSET_SCHEME_URL_PATTERN = new RegExp(
  `(?<![A-Za-z0-9+.-])${escapeRegExp(RENDERER_SCHEME_ORIGIN)}\\/assets\\/([^:\\s'"\`)?#]+?\\.(?:js|css))(?=[:\\s'"\`)?#]|$)`,
  'g',
);

const SOURCEMAP_MINIFIED_PATH_PREFIX = RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX;

export function normalizeRendererAssetReferences(value: string): string {
  const toSourcemapPath = (_match: string, assetName: string): string =>
    `${SOURCEMAP_MINIFIED_PATH_PREFIX}/${assetName}`;
  return value
    .replace(RENDERER_ASSET_FILE_URL_PATTERN, toSourcemapPath)
    .replace(RENDERER_ASSET_SCHEME_URL_PATTERN, toSourcemapPath);
}

function redactLocalPaths(value: string): string {
  return HOME_PATH_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '<user-home>'),
    value,
  );
}

export function redactUrl(value: string): string {
  const normalized = normalizeRendererAssetReferences(value);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === 'file:') {
      return 'file:///<redacted>';
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return redactLocalPaths(parsed.toString());
  } catch {
    return redactLocalPaths(normalized);
  }
}

export function redactText(value: string): string {
  // URL/home-path normalization stays here; the secret/PII vocabulary is
  // delegated to the shared scrubber so there is a single source of truth.
  return redactSecrets(
    redactLocalPaths(normalizeRendererAssetReferences(value)),
  );
}

export function sanitizeInstrumentationContext(
  context: DesktopInstrumentationContext | undefined,
): DesktopInstrumentationContext | undefined {
  if (!context) {
    return undefined;
  }

  const sanitized: DesktopInstrumentationContext = {};
  for (const [key, value] of Object.entries(context)) {
    sanitized[key] = typeof value === 'string' ? redactText(value) : value;
  }
  return sanitized;
}

const POSTHOG_IDENTITY_PROPERTY_NAMES = new Set([
  'distinctid',
  'posthogdistinctid',
  'sessionid',
  'posthogsessionid',
]);

function normalizeInstrumentationPropertyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Contexts leaving through a non-PostHog sink (the Node host's record sink)
 * must never contain PostHog's person or session identity. PostHog's own
 * outbound adapter uses the generic sanitizer so it can stamp its canonical
 * `distinct_id` and `$session_id` after redaction.
 */
export function sanitizeExternalInstrumentationContext(
  context: DesktopInstrumentationContext | undefined,
): DesktopInstrumentationContext | undefined {
  const sanitized = sanitizeInstrumentationContext(context);
  if (!sanitized) return undefined;
  return Object.fromEntries(
    Object.entries(sanitized).filter(
      ([key]) =>
        !POSTHOG_IDENTITY_PROPERTY_NAMES.has(
          normalizeInstrumentationPropertyName(key),
        ),
    ),
  );
}
