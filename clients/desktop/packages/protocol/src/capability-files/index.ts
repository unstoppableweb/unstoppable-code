import { CANOPY_ISSUED_TOKEN_SOURCE } from '../secret-redaction';

/** Shared file metadata used by capability-package and capability-bundle manifests. */
export interface CapabilityFileEntryBase {
  path: string;
  sha256: string;
  size: number;
}

export const CAPABILITY_FILE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

const WINDOWS_RESERVED_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_SEGMENT_CHARACTER_PATTERN = /[<>:"\\|?*]/;

/** Whether a single path segment materializes portably on POSIX and Windows. */
export function isPortableCapabilityPathSegment(
  value: unknown,
  options: { maxLength?: number } = {},
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    (options.maxLength === undefined || value.length <= options.maxLength) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.endsWith('.') &&
    !value.endsWith(' ') &&
    !WINDOWS_INVALID_SEGMENT_CHARACTER_PATTERN.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f) &&
    !WINDOWS_RESERVED_NAME_PATTERN.test(value)
  );
}

/** Whether a relative POSIX path is safe and portable to materialize. */
export function isSafeCapabilityRelativePath(
  value: unknown,
  options: { maxPathLength?: number; maxSegmentLength?: number } = {},
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    (options.maxPathLength !== undefined &&
      value.length > options.maxPathLength) ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value.split('/').every((segment) =>
    isPortableCapabilityPathSegment(segment, {
      maxLength: options.maxSegmentLength,
    }),
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(bytes),
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

export function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(combined >>> 18) & 63];
    output += alphabet[(combined >>> 12) & 63];
    output += second === undefined ? '=' : alphabet[(combined >>> 6) & 63];
    output += third === undefined ? '=' : alphabet[combined & 63];
  }
  return output.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Every pattern must stay linear on adversarial input: untrusted shared
// documents are scanned synchronously in the main process. A private-key
// header alone is high-confidence, and a JWT match starts only at the first
// `eyJ` of a token run, so neither rescans the remainder from every start.
/** Which high-confidence secret signature a text matched. */
export type SecretMaterialRule =
  | 'private_key'
  | 'jwt'
  | 'github_token'
  | 'slack_token'
  | 'npm_token'
  | 'aws_access_key'
  | 'api_key_prefix'
  | 'auth_header'
  | 'bearer_token'
  | 'credential_assignment';

const SECRET_RULES: readonly {
  readonly rule: SecretMaterialRule;
  readonly pattern: RegExp;
}[] = [
  // PEM forms, and PGP's armored block, whose header ends in KEY BLOCK.
  {
    rule: 'private_key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/,
  },
  // The SSH2 (SSH.com) key file, and PuTTY's .ppk, which opens with its
  // format and version: neither has a PEM header. A header alone is enough.
  // No word boundary before PuTTY: the package profile drops line breaks.
  {
    rule: 'private_key',
    pattern: /---- BEGIN SSH2 (?:ENCRYPTED )?PRIVATE KEY ----/,
  },
  { rule: 'private_key', pattern: /PuTTY-User-Key-File-[0-9]+:/ },
  {
    rule: 'jwt',
    pattern:
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  },
  { rule: 'github_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { rule: 'github_token', pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}/ },
  { rule: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'npm_token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { rule: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'api_key_prefix', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { rule: 'api_key_prefix', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { rule: 'api_key_prefix', pattern: new RegExp(CANOPY_ISSUED_TOKEN_SOURCE) },
  {
    rule: 'auth_header',
    pattern:
      /\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token|X-Amz-Security-Token)\s*:\s*[^\r\n]+/i,
  },
  { rule: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/ },
  {
    rule: 'credential_assignment',
    pattern:
      /["']?(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)["']?\s*:\s*["']?[^"',}\]\s]+/i,
  },
  {
    rule: 'credential_assignment',
    pattern:
      /\b(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)=[^\s&"']+/i,
  },
];

// An escape written as text, such as `\n` in a JSON or YAML string, `%0A` or
// `\u000a`, leaves a letter or digit right before a token, so the token's
// leading word boundary fails. The spaced reading puts a space where each
// such escape was: the single-letter escapes of JSON, YAML and C strings,
// `\uXXXX`, `\UXXXXXXXX`, `\xNN`, `%XX` and `%uXXXX` (CAN-7627). Regex
// classes such as `\s` and `\w` stay as written.
const BOUNDARY_ESCAPE_SOURCE =
  '\\\\(?:[nrtbfv0aeNLP_]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|x[0-9A-Fa-f]{2})|%(?:u[0-9A-Fa-f]{4}|[0-9A-Fa-f]{2})';
const BOUNDARY_ESCAPE = new RegExp(BOUNDARY_ESCAPE_SOURCE);
const BOUNDARY_ESCAPES = new RegExp(BOUNDARY_ESCAPE_SOURCE, 'g');

/** How a secret check reads escapes written as text (CAN-7627). */
export interface EscapeReadingOptions {
  /**
   * `as-written` reads text only as written, as every check did before
   * CAN-7627. A check built from other checks passes it to them, so only its
   * own two passes read escapes.
   */
  readonly escapes?: 'as-written';
}

/** For a check built from other checks: read the text only as written. */
export const ESCAPES_AS_WRITTEN: EscapeReadingOptions = {
  escapes: 'as-written',
};

function spacedEscapeReading(text: string): string {
  return text.replace(BOUNDARY_ESCAPES, ' ');
}

/**
 * Runs a check on its texts as written and, only when that finds nothing and
 * one of them holds an escape, once more with each escape read as a space
 * (CAN-7627). The check reads every text through `read`. Each secret check
 * that reads escapes goes through this one function, so each returns exactly
 * its as-written result whenever that finds anything, and the spaced pass
 * only ever adds findings.
 */
export function asWrittenThenSpaced<Finding>(
  options: EscapeReadingOptions,
  check: (read: (text: string) => string) => Finding | null,
): Finding | null {
  let escaped = false;
  const asWritten = check((text) => {
    if (!escaped && BOUNDARY_ESCAPE.test(text)) escaped = true;
    return text;
  });
  if (asWritten !== null || !escaped || options.escapes === 'as-written')
    return asWritten;
  return check(spacedEscapeReading);
}

/**
 * The rule a label (a file, path, name, key or other shown value) trips as
 * written or with each escape read as a space, or null (CAN-7627). `check`
 * reads text as written. A site that names the rule in its message uses
 * this; one that only shows or hides the label uses displayableLabel.
 */
export function labelSecretRule<Rule>(
  label: string,
  check: (text: string) => Rule | null,
): Rule | null {
  return check(label) ?? check(spacedEscapeReading(label));
}

/**
 * A label a secret check may show, or `redacted` when labelSecretRule finds
 * it trips `check` either way (CAN-7627). Every site that shows a label goes
 * through this, whichever pass made a finding, so a label is never shown
 * after only one reading of it was checked.
 */
export function displayableLabel<Redacted, Rule>(
  label: string,
  redacted: Redacted,
  check: (text: string) => Rule | null,
): string | Redacted {
  return labelSecretRule(label, check) === null ? label : redacted;
}

function firstSecretRule(text: string): SecretMaterialRule | null {
  for (const { rule, pattern } of SECRET_RULES) {
    if (pattern.test(text)) return rule;
  }
  return null;
}

/**
 * The first high-confidence secret signature in text, or null. Names the
 * rule only: callers report the rule, never the matched text. Text that
 * trips nothing as written is read once more with each escape written as
 * text read as a space (asWrittenThenSpaced, CAN-7627).
 */
export function findSecretMaterialRule(
  text: string,
  options: EscapeReadingOptions = {},
): SecretMaterialRule | null {
  if (text.length === 0) return null;
  return asWrittenThenSpaced(options, (read) => firstSecretRule(read(text)));
}

/** Return whether text contains a high-confidence secret signature. */
export function containsSecretMaterial(text: string): boolean {
  return findSecretMaterialRule(text) !== null;
}
