import { SECRET_ASSIGNMENT_KEYS_SOURCE } from '@canopy/execution-engine/lib/redaction';
import {
  RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX,
  type DesktopInstrumentationConfig,
} from './config';
import { redactText, redactUrl } from './privacy';
import { normalizePostHogEmailDomain } from './posthog-account';
import { POSTHOG_CLICK_EVENTS } from './client/posthog-autocapture-options';
import { POSTHOG_HEATMAP_DATA_PROPERTY } from './client/posthog-heatmaps';
import {
  maskClickAttribute,
  maskClickText,
} from './client/posthog-replay-masking';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from './posthog-replay-privacy';
import {
  buildPostHogRouteProperties,
  isPostHogRoute,
  POSTHOG_APP_ADVISOR_ROUTE,
  POSTHOG_MAIN_ROUTE,
} from './posthog-routes';

/** Exact names for the SDK's property_denylist; the sanitizer also checks
 * spelling variants and nested properties. Content must be dropped, since
 * arbitrary private prose need not match a secret or PII pattern. */
export const POSTHOG_PROPERTY_DENYLIST: readonly string[] = Object.freeze([
  'prompt',
  'prompt_text',
  'messages',
  'message',
  'chat_excerpt',
  'transcript',
  'transcript_content',
  'file_content',
  'file_contents',
  'terminal_output',
  'stdout',
  'stderr',
  'command',
  'command_line',
  'git_remote',
  'remote_url',
  'workspace_id',
  'workspace_path',
  'worktree_path',
  'absolute_path',
  'install_path',
  'email',
  'usr',
  'usr.email',
  'usr.id',
  'dd_session_id',
  'dd_view_id',
  'username',
  'authorization',
  'cookie',
  'set-cookie',
  '$ip',
  'ip',
  // Click events also send `$elements` as one unstructured string, where an
  // href would escape URL redaction. `$elements` is sanitized field by field
  // and PostHog derives the chain from it when this copy is absent.
  '$elements_chain',
]);

function normalizePropertyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const DENIED_PROPERTIES = new Set(
  POSTHOG_PROPERTY_DENYLIST.map(normalizePropertyName),
);
const SECRET_PROPERTY = new RegExp(
  `^(?:${SECRET_ASSIGNMENT_KEYS_SOURCE})$`,
  'i',
);
const LOCATION_PROPERTIES = new Set([
  '$current_url',
  '$pathname',
  '$host',
  '$referrer',
  '$referring_domain',
  '$initial_current_url',
  '$initial_pathname',
  '$initial_host',
  '$initial_referrer',
  '$initial_referring_domain',
  '$session_entry_url',
  '$session_entry_pathname',
  '$session_entry_referrer',
  '$session_entry_referring_domain',
  '$prev_pageview_pathname',
  '$prev_pageview_url',
]);
const URL_ATTRIBUTES = new Set(['attr__href', 'attr__src', 'attr__action']);
const CLICK_MASK_CLASSES = new Set([
  POSTHOG_REPLAY_MASK_CLASS,
  POSTHOG_REPLAY_BLOCK_CLASS,
]);

function isDeniedProperty(key: string): boolean {
  const normalized = normalizePropertyName(key);
  return (
    DENIED_PROPERTIES.has(normalized) ||
    SECRET_PROPERTY.test(normalized) ||
    normalized.startsWith('geoip') ||
    normalized.startsWith('initialgeoip')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasClickMaskClass(value: unknown): boolean {
  if (typeof value === 'string') {
    return value
      .trim()
      .split(/\s+/)
      .some((token) => CLICK_MASK_CLASSES.has(token));
  }
  if (Array.isArray(value)) {
    return value.some(
      (entry) => typeof entry === 'string' && CLICK_MASK_CLASSES.has(entry),
    );
  }
  return false;
}

function elementHasClickMask(element: unknown): boolean {
  if (!isRecord(element)) return false;
  return (
    hasClickMaskClass(element.attr__class) || hasClickMaskClass(element.classes)
  );
}

/**
 * PostHog orders `$elements` innermost-first (`[target, parent, ...]`). Walk
 * from the outermost ancestor inward so every element at or beneath a
 * `ph-mask` / `ph-no-capture` container inherits masked click sanitization.
 */
function computeClickElementMaskFlags(elements: readonly unknown[]): boolean[] {
  const flags = new Array<boolean>(elements.length).fill(false);
  let masked = false;
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    if (elementHasClickMask(elements[index])) masked = true;
    flags[index] = masked;
  }
  return flags;
}

function sanitizeValue(
  value: unknown,
  key: string,
  location: string,
  ancestors: WeakSet<object>,
  depth: number,
  maskClickContent: boolean,
  inMaskedClickSubtree = false,
): unknown {
  if (normalizePropertyName(key) === 'emaildomain') {
    return key === 'email_domain'
      ? normalizePostHogEmailDomain(value)
      : undefined;
  }
  if (LOCATION_PROPERTIES.has(key)) return location;
  if (key === POSTHOG_HEATMAP_DATA_PROPERTY) {
    return sanitizeHeatmapData(value, location);
  }
  if (typeof value === 'string') {
    const maskedValue = maskClickContent
      ? key === '$el_text'
        ? maskClickText(value, inMaskedClickSubtree)
        : key.startsWith('attr__')
          ? maskClickAttribute(
              key.slice('attr__'.length),
              value,
              inMaskedClickSubtree,
            )
          : value
      : value;
    if (key.endsWith('_url') || URL_ATTRIBUTES.has(key)) {
      // Normalize URLs after text redaction as well, so URL-encoded redaction
      // markers are stable on a second pass. No provider-specific patterns.
      return redactUrl(redactText(redactUrl(maskedValue)));
    }
    return redactText(maskedValue);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (typeof value !== 'object' || depth >= 32 || ancestors.has(value))
    return undefined;

  // Only JSON data is supported. Never retain an object's toJSON hook, which
  // could serialize unsanitized data after this pass.
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return undefined;
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    const elementMaskFlags =
      maskClickContent && key === '$elements'
        ? computeClickElementMaskFlags(value)
        : null;
    result = value.map(
      (entry, index) =>
        sanitizeValue(
          entry,
          key,
          location,
          ancestors,
          depth + 1,
          maskClickContent,
          elementMaskFlags
            ? elementMaskFlags[index] === true
            : inMaskedClickSubtree,
        ) ?? null,
    );
  } else {
    result = Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !isDeniedProperty(name))
        .map(([name, entry]) => [
          name,
          sanitizeValue(
            entry,
            name,
            location,
            ancestors,
            depth + 1,
            maskClickContent,
            inMaskedClickSubtree,
          ),
        ])
        .filter(([, entry]) => entry !== undefined),
    );
  }
  ancestors.delete(value);
  return result;
}

const HEATMAP_SAMPLE_TYPES = new Set([
  'click',
  'rageclick',
  'deadclick',
  'mousemove',
]);

interface HeatmapSample {
  x: number;
  y: number;
  target_fixed: boolean;
  type: string;
}

function toHeatmapSample(value: unknown): HeatmapSample | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, target_fixed: targetFixed, type } = value;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof targetFixed !== 'boolean' ||
    typeof type !== 'string' ||
    !HEATMAP_SAMPLE_TYPES.has(type)
  )
    return undefined;
  return { x, y, target_fixed: targetFixed, type };
}

/** The SDK keys heatmap samples by `window.location.href`, which names the
 * local install. Every sample moves under the synthetic route and keeps only
 * its coordinates and type. */
function sanitizeHeatmapData(
  value: unknown,
  location: string,
): Record<string, HeatmapSample[]> | undefined {
  if (!isRecord(value)) return undefined;
  const samples = Object.values(value).flatMap((entries) =>
    Array.isArray(entries)
      ? entries.map(toHeatmapSample).filter((sample) => sample !== undefined)
      : [],
  );
  return samples.length > 0 ? { [location]: samples } : undefined;
}

function sanitizeProperties(
  properties: Record<string, unknown>,
  location: string,
  preserveProjectToken = false,
  maskClickContent = false,
): Record<string, unknown> {
  // Fail closed on click events that omit `$elements` (for example PostHog's
  // string-only `$elements_chain` mode), so masked header names never leak via
  // top-level `$el_text` or `attr__*` properties.
  const targetInMaskedClickSubtree = maskClickContent
    ? Array.isArray(properties.$elements) && properties.$elements.length > 0
      ? computeClickElementMaskFlags(properties.$elements)[0] === true
      : true
    : false;
  const sanitized = sanitizeValue(
    properties,
    '',
    location,
    new WeakSet(),
    0,
    maskClickContent,
    targetInMaskedClickSubtree,
  );
  if (!isRecord(sanitized)) return {};
  if ('screen_route' in sanitized && !isPostHogRoute(sanitized.screen_route)) {
    Reflect.deleteProperty(sanitized, 'screen_route');
  }
  return preserveProjectToken && typeof properties.token === 'string'
    ? { ...sanitized, token: properties.token }
    : sanitized;
}

const MAX_EXCEPTION_LIST_ENTRIES = 5;
const MAX_EXCEPTION_FRAMES = 50;
const MAX_EXCEPTION_TEXT_LENGTH = 2_000;
const SAFE_EXCEPTION_TYPES = new Set<string>([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
]);
const EXCEPTION_TEXT_FRAME_KEYS = ['function', 'module'] as const;
const EXCEPTION_PATH_FRAME_KEYS = ['filename', 'abs_path'] as const;
// Copied verbatim after the generic pass: PostHog symbolicates by `chunk_id`,
// which text redaction could mangle.
const EXCEPTION_VERBATIM_FRAME_KEYS = [
  'chunk_id',
  'lineno',
  'colno',
  'in_app',
  'platform',
] as const;
const EXCEPTION_MECHANISM_KEYS = ['type', 'handled', 'synthetic'] as const;

function truncateExceptionText(value: string): string {
  return value.length > MAX_EXCEPTION_TEXT_LENGTH
    ? value.slice(0, MAX_EXCEPTION_TEXT_LENGTH)
    : value;
}

const RENDERER_ASSET_PREFIX = `${RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/`;

function sanitizeExceptionPath(
  value: unknown,
  handled: boolean,
  chunkId?: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = redactUrl(value);
  if (!handled) return normalized;
  if (
    typeof chunkId === 'string' &&
    chunkId.length > 0 &&
    normalized.startsWith(RENDERER_ASSET_PREFIX) &&
    /^[a-zA-Z0-9_.-]+\.js$/.test(normalized.slice(RENDERER_ASSET_PREFIX.length))
  )
    return normalized;
  // The SDK can turn private absolute paths into cwd-relative filenames.
  return 'file:///<redacted>';
}

function sanitizeExceptionFrame(
  frame: unknown,
  handled: boolean,
): Record<string, unknown> | undefined {
  if (!isRecord(frame)) return undefined;
  // PostHog requires a function string even when privacy hides its name.
  const result: Record<string, unknown> = handled ? { function: '?' } : {};
  for (const key of EXCEPTION_TEXT_FRAME_KEYS) {
    // V8's cached stack text can embed private header labels that look like
    // function names. Handled events keep coordinates and SDK chunk identity.
    if (handled) continue;
    const value = frame[key];
    if (typeof value === 'string') result[key] = redactText(value);
  }
  for (const key of EXCEPTION_VERBATIM_FRAME_KEYS) {
    const value = frame[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      result[key] = value;
  }
  for (const key of EXCEPTION_PATH_FRAME_KEYS) {
    if (handled && key === 'abs_path') continue;
    const path = frame[key];
    if (typeof path !== 'string') continue;
    result[key] = sanitizeExceptionPath(path, handled, frame.chunk_id);
  }
  return result;
}

interface SanitizedExceptionEntry extends Record<string, unknown> {
  stacktrace?: { type?: string; frames: Record<string, unknown>[] };
}

function sanitizeExceptionEntry(
  entry: unknown,
  handled: boolean,
  textReplaced: boolean,
): SanitizedExceptionEntry | undefined {
  if (!isRecord(entry)) return undefined;
  const result: SanitizedExceptionEntry = {};
  const isChained =
    isRecord(entry.mechanism) && entry.mechanism.type === 'chained';
  if (isChained || textReplaced) {
    // Pattern redaction cannot make arbitrary cause prose or custom names safe.
    result.type =
      typeof entry.type === 'string' && SAFE_EXCEPTION_TYPES.has(entry.type)
        ? entry.type
        : 'Error';
    result.value = isChained ? '[cause]' : '[redacted]';
  } else {
    if (typeof entry.type === 'string') result.type = redactText(entry.type);
    if (typeof entry.value === 'string')
      result.value = truncateExceptionText(redactText(entry.value));
  }
  if (isRecord(entry.mechanism)) {
    const mechanism: Record<string, unknown> = {};
    for (const key of EXCEPTION_MECHANISM_KEYS) {
      const value = entry.mechanism[key];
      if (typeof value === 'string' || typeof value === 'boolean')
        mechanism[key] = value;
    }
    result.mechanism = mechanism;
  }
  if (isRecord(entry.stacktrace)) {
    const frames = Array.isArray(entry.stacktrace.frames)
      ? entry.stacktrace.frames
      : [];
    result.stacktrace = {
      ...(typeof entry.stacktrace.type === 'string' && {
        type: entry.stacktrace.type,
      }),
      // Keep the innermost frames; the SDK orders frames outermost first.
      frames: frames
        .slice(-MAX_EXCEPTION_FRAMES)
        .map((frame) => sanitizeExceptionFrame(frame, handled || textReplaced))
        .filter((frame) => frame !== undefined),
    };
  } else if (handled) {
    result.stacktrace = { type: 'raw', frames: [] };
  }
  return result;
}

/** The SDK's `$exception` shape is an allowlist: unknown `$exception_*` keys
 * and frame fields are dropped rather than passed through. `$exception_message`
 * is redacted, not dropped by the `message` denylist entry. Runs before the
 * generic pass, whose output is then overlaid with these fields. */
function sanitizePostHogExceptionProperties(
  properties: Record<string, unknown>,
  replaceUncodedExceptionText: boolean,
): Record<string, unknown> {
  const exceptionProperties: Record<string, unknown> = {};
  const handled = typeof properties.error_reference_id === 'string';
  // An uncaught message can quote parsed input, git output or paths that
  // pattern redaction cannot recognize. The SDK also parses a message line
  // that starts with `at` into a frame, so frames get the handled policy.
  const textReplaced = replaceUncodedExceptionText && !handled;
  const list = properties.$exception_list;
  if (Array.isArray(list)) {
    const entries = list
      .slice(0, MAX_EXCEPTION_LIST_ENTRIES)
      .map((entry) => sanitizeExceptionEntry(entry, handled, textReplaced))
      .filter((entry) => entry !== undefined);
    exceptionProperties.$exception_list = entries;
    if (
      handled &&
      entries.length &&
      entries.every((entry) => !entry.stacktrace?.frames.length)
    ) {
      exceptionProperties.frames_unavailable = true;
    }
  }
  const message = properties.$exception_message;
  if (typeof message === 'string') {
    exceptionProperties.$exception_message = textReplaced
      ? '[redacted]'
      : truncateExceptionText(redactText(message));
  }
  const level = properties.$exception_level;
  if (typeof level === 'string') exceptionProperties.$exception_level = level;
  const fingerprint = properties.$exception_fingerprint;
  if (typeof fingerprint === 'string') {
    exceptionProperties.$exception_fingerprint = redactText(fingerprint);
  }
  const source = sanitizeExceptionPath(properties.$exception_source, handled);
  if (source !== undefined) exceptionProperties.$exception_source = source;
  for (const key of ['$exception_lineno', '$exception_colno'] as const) {
    const value = properties[key];
    if (typeof value === 'number') exceptionProperties[key] = value;
  }
  return exceptionProperties;
}

function withoutExceptionProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => !key.startsWith('$exception')),
  );
}

interface SanitizePostHogEventOptions {
  exceptionBuild?: Pick<
    DesktopInstrumentationConfig,
    'appVersion' | 'appBrand' | 'releaseChannel'
  >;
  preserveBrowserProjectToken?: boolean;
  /** Renderer only: an `$exception` without a catalog `error_reference_id`
   * gets an allowlisted type, a fixed message and the handled frame policy. */
  replaceUncodedExceptionText?: boolean;
  /** Recorder payloads are already masked and may contain gzip latin1 bytes. */
  passthroughProperties?: readonly string[];
  /** Current renderer route. Runtime validation is intentional: callers may
   * cross an untyped SDK boundary before reaching this pure sanitizer. */
  screenRoute?: unknown;
}

/** Pure outbound property sanitizer shared by the future browser and Node
 * adapters. Event-envelope fields (including timestamp) are preserved. This
 * does not enable capture or replace replay/DOM masking. */
export function sanitizePostHogEvent<
  T extends {
    properties?: Record<string, unknown>;
    $set?: Record<string, unknown>;
    $set_once?: Record<string, unknown>;
  },
>(event: T | null, options: SanitizePostHogEventOptions = {}): T | null {
  if (event === null) return null;
  const surface =
    event.properties?.surface === 'app-advisor' ? 'app-advisor' : 'main';
  const fallbackLocation =
    surface === 'app-advisor' ? POSTHOG_APP_ADVISOR_ROUTE : POSTHOG_MAIN_ROUTE;
  // Resolution order is the capture-time event route, then the caller's
  // current route, then the existing safe-surface fallback. Keeping a valid
  // event route first makes retries and session-buffer replays idempotent.
  const incomingRoute = event.properties?.screen_route;
  const eventRoute = isPostHogRoute(incomingRoute) ? incomingRoute : undefined;
  const optionRoute = isPostHogRoute(options.screenRoute)
    ? options.screenRoute
    : undefined;
  const rendererRoute = eventRoute ?? optionRoute;
  const location = rendererRoute ?? fallbackLocation;
  const passthroughKeys = options.passthroughProperties ?? [];
  const exceptionProperties =
    'event' in event && event.event === '$exception' && event.properties
      ? sanitizePostHogExceptionProperties(
          event.properties,
          options.replaceUncodedExceptionText === true,
        )
      : undefined;
  let propertiesToSanitize: Record<string, unknown> | undefined =
    exceptionProperties && event.properties
      ? withoutExceptionProperties(event.properties)
      : event.properties;
  if (propertiesToSanitize && passthroughKeys.length > 0) {
    propertiesToSanitize = { ...propertiesToSanitize };
    for (const key of passthroughKeys) {
      Reflect.deleteProperty(propertiesToSanitize, key);
    }
  }
  const sanitizedProperties = propertiesToSanitize
    ? sanitizeProperties(
        propertiesToSanitize,
        location,
        options.preserveBrowserProjectToken,
        'event' in event &&
          typeof event.event === 'string' &&
          POSTHOG_CLICK_EVENTS.has(event.event),
      )
    : undefined;
  if (sanitizedProperties && event.properties) {
    for (const key of passthroughKeys) {
      if (Object.prototype.hasOwnProperty.call(event.properties, key)) {
        sanitizedProperties[key] = event.properties[key];
      }
    }
    Object.assign(sanitizedProperties, exceptionProperties);
    if (exceptionProperties && options.exceptionBuild) {
      sanitizedProperties.app_version =
        options.exceptionBuild.appVersion ?? 'unknown';
      sanitizedProperties.app_brand =
        options.exceptionBuild.appBrand ?? 'unknown';
      sanitizedProperties.release_channel =
        options.exceptionBuild.releaseChannel ?? 'unknown';
    }
  }
  const sanitizedEvent = {
    ...event,
    ...((sanitizedProperties || rendererRoute) && {
      properties: {
        ...sanitizedProperties,
        ...(rendererRoute && buildPostHogRouteProperties(rendererRoute)),
      },
    }),
    ...(event.$set && {
      $set: sanitizeProperties(event.$set, location),
    }),
    ...(event.$set_once && {
      $set_once: sanitizeProperties(event.$set_once, location),
    }),
  };
  Reflect.deleteProperty(sanitizedEvent, 'toJSON');
  return sanitizedEvent;
}
