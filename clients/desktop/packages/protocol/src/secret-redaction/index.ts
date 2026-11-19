// ---------------------------------------------------------------------------
// Pure secret/PII scrubber (CAN-374 / CAN-402).
//
// The single source of truth for masking secrets and PII out of free text:
// telemetry and instrumentation through `@canopy/execution-engine/lib/redaction`
// (which re-exports it), and local memory through `@canopy/memory-consolidation`,
// which the desktop and Canopy Cloud share. Only regular expressions: no Node
// APIs, no Electron, no filesystem.
//
// `redactText()` in `packages/desktop-instrumentation/src/privacy.ts` layers
// URL/home-path normalization on top of this and then delegates here, so the
// secret/PII vocabulary lives in exactly one place.
// ---------------------------------------------------------------------------

const REDACTED = '<redacted>';

/**
 * The complete secret-bearing assignment-key vocabulary, as a regex
 * alternation source string. This is the single source of truth for which
 * key names mark an assignment value as a secret; the `key: value` and
 * `key=value` passes below and downstream consumers (e.g. the local-memory
 * pre-persistence redactor) must all derive their key matching from this
 * constant rather than hand-maintaining subsets.
 */
export const SECRET_ASSIGNMENT_KEYS_SOURCE =
  'api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd';

/**
 * The placeholders written by the passes from the header pass on, and by the
 * memory redactor built on this module (`@canopy/memory-consolidation/redaction`),
 * which runs after them all. The header and key passes leave a value made of
 * them alone, so a second run changes nothing. A token placeholder written
 * before those passes is still masked there as `<redacted>`, as it always
 * was, since no later pass can write one after a key.
 */
const LATER_PLACEHOLDERS = [
  REDACTED,
  '<redacted-email>',
  '<redacted-ip>',
  '<user-home>',
  '<CONNECTION_STRING>',
  '<API_KEY>',
  '<SECRET>',
  '<TOKEN>',
] as const;

const LATER_PLACEHOLDER_SOURCE = LATER_PLACEHOLDERS.join('|');

/**
 * A lookahead that fails where placeholders alone, after `lead`, run to the
 * end of what a pass would consume: `end` is a class of the characters that
 * stop its match. `lead` covers optional whitespace the pass could otherwise
 * give back to start its value before the placeholders.
 */
function notPlaceholdersBefore(end: string, lead = ''): string {
  return `(?!${lead}(?:${LATER_PLACEHOLDER_SOURCE})+(?:${end}|$))`;
}

/**
 * Ordered list of redaction passes. Order matters: multi-line/structured
 * blocks (PEM) run before token-shaped patterns, and the generic
 * `key: value` / `key=value` masks run after the specific token shapes so a
 * specific replacement is not clobbered by a broader one.
 */
interface RedactionPass {
  readonly pattern: RegExp;
  readonly replacement:
    | string
    | ((match: string, target: string | undefined) => string);
  /**
   * The capture group holding the secret itself, for {@link findSecretSpans}:
   * 0 (the default) for the whole match. A `(target)|skip` pattern names its
   * target, so a skipped run is never reported. The group must end the match
   * (a value after its key), which is how its position is found.
   */
  readonly secretGroup?: number;
}

/**
 * The replacement for a `(target)|skip` pattern, which keeps a `skip` match
 * as it is. `skip` only matches where the target just failed, and consumes
 * the rest of a run in which every later start fails the same way. The scan
 * then resumes after the run instead of retrying each position in it, which
 * takes quadratic time on a long run.
 */
function replaceTarget(
  replacement: string,
): (match: string, target: string | undefined) => string {
  return (match, target) => (target === undefined ? match : replacement);
}

const SECRET_REDACTION_PASSES: ReadonlyArray<RedactionPass> = [
  // PEM-encoded private key blocks (RSA/EC/OPENSSH/generic). A header with
  // no footer after it leaves none for a later header either.
  {
    pattern:
      /(-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)|-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*/g,
    replacement: replaceTarget('<redacted-private-key>'),
    secretGroup: 1,
  },
  // JSON Web Tokens (header.payload.signature, header starts with `eyJ`).
  // Every start in one run of token characters ends its header segment at
  // the same place.
  {
    pattern:
      /(\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)|\beyJ[A-Za-z0-9_-]*/g,
    replacement: replaceTarget('<redacted-jwt>'),
    secretGroup: 1,
  },
  // GitHub fine-grained personal access tokens.
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replacement: '<redacted-token>',
  },
  // GitHub classic tokens: ghp_, gho_, ghu_, ghs_, ghr_.
  {
    pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}/g,
    replacement: '<redacted-token>',
  },
  // Slack bot/app/user/configuration tokens.
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replacement: '<redacted-token>',
  },
  // AWS access key IDs.
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '<redacted-aws-key>',
  },
  // OpenAI / Anthropic style secret keys (`sk-`, `sk-ant-...`).
  {
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replacement: '<redacted-token>',
  },
  // Stripe secret and restricted keys (`sk_live_`, `sk_test_`, `rk_live_`).
  {
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
    replacement: '<redacted-token>',
  },
  // Authorization / Cookie / common API-key headers (mask the whole value).
  {
    pattern: new RegExp(
      `\\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token|X-Amz-Security-Token)\\s*:${notPlaceholdersBefore('[\\r\\n]', '\\s*')}\\s*([^\\r\\n]+)`,
      'gi',
    ),
    replacement: `$1: ${REDACTED}`,
    secretGroup: 2,
  },
  // Bearer tokens anywhere in the text.
  {
    pattern: /\bBearer\s+([A-Za-z0-9._~+/-]+=*)/g,
    replacement: `Bearer ${REDACTED}`,
    secretGroup: 1,
  },
  // key: value (quoted or unquoted) for secret-bearing keys.
  {
    pattern: new RegExp(
      `(["']?(?:${SECRET_ASSIGNMENT_KEYS_SOURCE})["']?\\s*:\\s*["']?)${notPlaceholdersBefore(`["',}\\]\\s]`)}([^"',}\\]\\s]+)`,
      'gi',
    ),
    replacement: `$1${REDACTED}`,
    secretGroup: 2,
  },
  // key=value for secret-bearing keys (query strings, env-style, CLI flags).
  {
    pattern: new RegExp(
      `\\b(${SECRET_ASSIGNMENT_KEYS_SOURCE})=${notPlaceholdersBefore(`[\\s&"']`)}([^\\s&"']+)`,
      'gi',
    ),
    replacement: `$1=${REDACTED}`,
    secretGroup: 2,
  },
];

const PII_REDACTION_PASSES: ReadonlyArray<RedactionPass> = [
  // Email addresses (PII). Every start in one run of address characters
  // reaches the same `@`. Runs shorter than 16 are not skipped: retrying
  // them costs little, and ordinary words then never call the replacer.
  {
    pattern:
      /(\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)|\b[A-Za-z0-9._%+-]{16,}/g,
    replacement: replaceTarget('<redacted-email>'),
  },
  // IPv4 addresses (PII).
  {
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    replacement: '<redacted-ip>',
  },
  // User home directories (PII): mask the OS username component while keeping
  // the rest of the path for context. Mirrors the home-path normalization in
  // `packages/desktop-instrumentation/src/privacy.ts` so direct `redactSecrets`
  // callers (telemetry transcript bodies, branch/workspace names, plan/PR
  // titles) do not leak the username. macOS `/Users/<name>`, Linux
  // `/home/<name>`, and Windows `<drive>:\Users\<name>`. A username never
  // starts with `<`, so a segment that does starts with a placeholder: it
  // was already redacted.
  {
    pattern: /\/Users\/(?!<)[^/\s)]+/g,
    replacement: '<user-home>',
  },
  {
    pattern: /\/home\/(?!<)[^/\s)]+/g,
    replacement: '<user-home>',
  },
  // A drive letter glued to the letters and digits before it takes them
  // along: masking from the drive letter alone would leave a token, such as
  // an AWS key, newly ending at a word boundary for a second run to redact.
  // Every start in one run of letters and digits reaches the same drive
  // letter, so a run that holds none is skipped whole.
  {
    pattern: /([A-Za-z0-9]*[A-Za-z]:\\Users\\(?!<)[^\\\s)]+)|[A-Za-z0-9]{16,}/g,
    replacement: replaceTarget('<user-home>'),
  },
];

const REDACTION_PASSES = [
  ...SECRET_REDACTION_PASSES,
  ...PII_REDACTION_PASSES,
] as const;

/**
 * Mask secrets and PII out of an arbitrary string. Pure and idempotent:
 * redacting a redacted text changes nothing.
 *
 * Coverage: API keys / tokens / secrets / passwords expressed as `key: value`
 * or `key=value`, `Authorization`/`Cookie`/`Bearer` headers, JWTs, GitHub
 * tokens, AWS access keys, OpenAI/Anthropic `sk-` keys, PEM private-key blocks,
 * email addresses, IPv4 addresses, and user home-directory paths (the OS
 * username component is masked).
 */
export function redactSecrets(text: string): string {
  if (text.length === 0) {
    return text;
  }
  return REDACTION_PASSES.reduce(
    (current, { pattern, replacement }) =>
      typeof replacement === 'string'
        ? current.replace(pattern, replacement)
        : current.replace(pattern, replacement),
    text,
  );
}

/** Where {@link findSecretSpans} found a secret: `text.slice(start, end)`. */
export interface SecretSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The secrets in `text`, by the same vocabulary {@link redactSecrets} masks
 * (its secret passes, not PII): a token, key, header or `key=value` value
 * where `redactSecrets` would write a placeholder. Sorted, with overlapping
 * spans merged. For guards that must spot a secret before it is sent, such
 * as the composer's paste guard; never returns anything but positions. A
 * span marks where a secret was recognised, not necessarily all of it (an
 * assignment's value stops at whitespace), so a guard keeps the whole text.
 */
export function findSecretSpans(text: string): SecretSpan[] {
  if (text.length === 0) return [];
  const spans: SecretSpan[] = [];
  for (const { pattern, secretGroup = 0 } of SECRET_REDACTION_PASSES) {
    // A fresh copy: the passes' own patterns keep their `lastIndex` state.
    const scan = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(scan)) {
      const secret = match[secretGroup];
      if (secret === undefined || secret.length === 0) continue;
      // Every pass's secret group ends its match (see `secretGroup`).
      const end = (match.index ?? 0) + match[0].length;
      spans.push({ start: end - secret.length, end });
    }
  }
  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: SecretSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start < last.end) {
      merged[merged.length - 1] = {
        start: last.start,
        end: Math.max(last.end, span.end),
      };
      continue;
    }
    merged.push(span);
  }
  return merged;
}

/** Whether `text` holds anything {@link findSecretSpans} reports. */
export function looksLikeSecret(text: string): boolean {
  return findSecretSpans(text).length > 0;
}
