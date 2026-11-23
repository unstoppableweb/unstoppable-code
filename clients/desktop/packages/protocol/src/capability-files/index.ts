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
  {
    rule: 'private_key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY-----/,
  },
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

/**
 * The first high-confidence secret signature in text, or null. Names the
 * rule only: callers report the rule, never the matched text.
 */
export function findSecretMaterialRule(
  text: string,
): SecretMaterialRule | null {
  if (text.length === 0) return null;
  for (const { rule, pattern } of SECRET_RULES) {
    if (pattern.test(text)) return rule;
  }
  return null;
}

/** Return whether text contains a high-confidence secret signature. */
export function containsSecretMaterial(text: string): boolean {
  return findSecretMaterialRule(text) !== null;
}
