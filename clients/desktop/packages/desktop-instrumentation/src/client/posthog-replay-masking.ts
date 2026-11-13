import { POSTHOG_REPLAY_MASK_CLASS } from '../posthog-replay-privacy';

const MAX_MASKED_ATTRIBUTE_LENGTH = 256;
const MASKED_TITLE_SELECTOR = `.${POSTHOG_REPLAY_MASK_CLASS}`;
/** Attributes that can carry what a masked element shows. */
const MASKED_CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'data-value',
  'placeholder',
  'title',
]);
const LOCAL_FILE_URL = /file:\/\//i;
const CSS_URL = /url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi;

// Matches maskInputFn in posthog-replay-options.ts.
const INPUT_VALUE_MASK = '********';

const secretMask = (value: string): string =>
  '*'.repeat(Math.min(value.length, MAX_MASKED_ATTRIBUTE_LENGTH));

const REDACTED = '***';
// Cheap gate: every pattern below needs one of these.
const MAY_HOLD_SECRET = /[=@]|bearer|authorization|--/i;
const CREDENTIAL_NAME =
  '(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)';
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // URL userinfo: https://user:pass@host
  [/(\b[a-z][\w+.-]*:\/\/)[^\s/?#@]+@/gi, `$1${REDACTED}@`],
  // URL query values: ?key=value&other=value
  [/([?&][^\s=&#]+=)[^\s&#"'<>]+/g, `$1${REDACTED}`],
  // Authorization header values, quoted or not, up to the closing quote or
  // line end: Authorization: Basic abc, "Authorization": "AWS4-HMAC-SHA256 …"
  [/(\bauthorization["']?\s*:\s*["']?)[^"'\n]+/gi, `$1${REDACTED}`],
  // Bearer tokens: Bearer abc123...
  [/\b(bearer)\s+[\w~+/.-]{8,}=*/gi, `$1 ${REDACTED}`],
  // Credential-named assignments: API_KEY=abc, token="abc"
  [
    new RegExp(
      String.raw`\b([\w.-]*${CREDENTIAL_NAME}[\w.-]*\s*=\s*)("[^"]*"|'[^']*'|[^\s&"']+)`,
      'gi',
    ),
    `$1${REDACTED}`,
  ],
  // Credential-named flags: --token abc, --api-key=abc
  [
    new RegExp(
      String.raw`(?<![\w-])(--[\w-]*${CREDENTIAL_NAME}[\w-]*)(=|\s+)(?!-)("[^"]*"|'[^']*'|\S+)`,
      'gi',
    ),
    `$1$2${REDACTED}`,
  ],
];

/**
 * Redact credentials that ride inside otherwise readable text, so a recorded
 * command line or URL keeps its shape but loses the secret part.
 */
function redactReplaySecrets(value: string): string {
  if (!MAY_HOLD_SECRET.test(value)) return value;
  return SECRET_PATTERNS.reduce(
    (redacted, [pattern, replacement]) =>
      redacted.replace(pattern, replacement),
    value,
  );
}

/**
 * Replay records text, with credentials redacted. `maskTextSelector: '*'`
 * routes every text node through this callback with its parent element; text
 * inside a {@link POSTHOG_REPLAY_MASK_CLASS} title is replaced with `*`,
 * keeping spaces. User content that is private as a whole is kept out by
 * blocking its subtree.
 */
export function recordReplayText(
  text: string,
  element?: HTMLElement | null,
): string {
  if (element?.closest(MASKED_TITLE_SELECTOR)) return text.replace(/\S/g, '*');
  return redactReplaySecrets(text);
}

/** Empty every CSS `url(...)` that points at a local file. */
function emptyLocalCssUrls(value: string): string {
  return value.replace(CSS_URL, (url) =>
    LOCAL_FILE_URL.test(url) ? 'url()' : url,
  );
}

/** Keep CSS while dropping local URLs that rrweb expands from relative font paths. */
function sanitizeCssText(value: string): string {
  const withoutLocalUrls = emptyLocalCssUrls(value);
  // A file URL outside url() (for example @import) is not safe to retain.
  return LOCAL_FILE_URL.test(withoutLocalUrls)
    ? secretMask(withoutLocalUrls)
    : withoutLocalUrls;
}

/**
 * rrweb absolutizes relative URLs against the page's `file://` base, which
 * names the install path (and, for per-user installs, the OS account). The
 * replay player cannot load local files, so dropping them loses nothing.
 */
function stripLocalFileUrls(value: string): string {
  if (!LOCAL_FILE_URL.test(value)) return value;
  return emptyLocalCssUrls(value)
    .replace(/file:\/\/\S*/gi, '')
    .trim();
}

/**
 * rrweb calls this for both snapshot and attribute mutations. Every attribute
 * is recorded except `value`, which carries form and input values, and, on
 * or inside a {@link POSTHOG_REPLAY_MASK_CLASS} element, the attributes that
 * can carry its content (`placeholder`, `title`, `aria-label`, `data-value`
 * and the like). Local file URLs are dropped and credentials redacted from
 * every other attribute.
 */
export function maskReplayAttribute(
  name: string,
  value: string,
  element?: Element,
): string;
export function maskReplayAttribute(
  name: string,
  value: null,
  element?: Element,
): null;
export function maskReplayAttribute(
  name: string,
  value: string | null,
  element?: Element,
): string | null {
  if (!value) return value;
  const normalizedName = name.toLowerCase();
  // Same fixed placeholder as typed input, so the length stays hidden.
  if (normalizedName === 'value') return INPUT_VALUE_MASK;
  if (
    MASKED_CONTENT_ATTRIBUTES.has(normalizedName) &&
    element?.closest(MASKED_TITLE_SELECTOR)
  )
    return INPUT_VALUE_MASK;
  if (normalizedName === '_csstext') return sanitizeCssText(value);
  return redactReplaySecrets(stripLocalFileUrls(value));
}
