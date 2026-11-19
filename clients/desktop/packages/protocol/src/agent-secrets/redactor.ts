import { extendMatchToFurthestOverlap } from '../value-redaction';
import { AGENT_SECRET_REDACTION_MIN_LENGTH, isAgentSecretName } from './names';

/*
 * Output redaction for agent secret requests. RunWithSecrets and
 * WriteSecretsFile results, and the storage backstops for chats that hold
 * secrets, pass through this before anything reaches the model, a
 * transcript or a log. Agentic Core implements the same rules for cloud
 * chats, so the rules here are a cross-repository contract:
 *
 * - every held value of at least 4 characters is active;
 * - each value is matched raw and as its base64 (standard and URL-safe,
 *   with and without padding), percent-encoded, lower- and upper-case hex
 *   and JSON-escaped forms, the encodings taken over its UTF-8 bytes;
 * - each match becomes `[secret:NAME]`;
 * - where matches overlap, the leftmost wins, the longest of those starting
 *   there names it, and every overlapping occurrence is covered by the same
 *   replacement, so no part of a value is left behind;
 * - a stream keeps a carry of (longest form - 1) characters between chunks,
 *   so a value split across chunks is still caught, and flushes at the end.
 *
 * Encoded forms are matched where they start at the encoding's own
 * boundary: a value base64-encoded inside a longer string at an offset that
 * is not a multiple of three bytes produces different characters and is
 * not caught. That is the documented limit of value-based redaction.
 *
 * This is distinct from the pipeline executor's `SecretValueRedactor`
 * (`execution-engine`), which masks pipeline secrets with `***` and also
 * handles process byte streams and JSON records. Both share the overlap
 * merge in `extendMatchToFurthestOverlap`.
 */

/** The text that replaces a matched secret value. */
export function agentSecretRedactionPlaceholder(name: string): string {
  return `[secret:${name}]`;
}

/**
 * Every form of `value` the redactor matches, longest first. Empty when the
 * value is too short to redact.
 */
export function agentSecretValueForms(value: string): string[] {
  if (value.length < AGENT_SECRET_REDACTION_MIN_LENGTH) return [];
  const forms = new Set<string>([value]);
  const escapedOnce = JSON.stringify(value).slice(1, -1);
  forms.add(escapedOnce);
  forms.add(JSON.stringify(escapedOnce).slice(1, -1));
  const bytes = new TextEncoder().encode(value);
  const base64 = encodeBase64(bytes);
  const unpadded = base64.replace(/=+$/, '');
  forms.add(base64);
  forms.add(unpadded);
  forms.add(base64.replace(/\+/g, '-').replace(/\//g, '_'));
  forms.add(unpadded.replace(/\+/g, '-').replace(/\//g, '_'));
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  forms.add(hex);
  forms.add(hex.toUpperCase());
  const percent = percentEncode(value);
  if (percent !== null) {
    forms.add(percent);
    forms.add(
      percent.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    );
  }
  return Array.from(forms).sort(compareForms);
}

/** The secrets a redactor matches: secret name to value. */
export type AgentSecretValues = Readonly<Record<string, string>>;

interface SecretForm {
  form: string;
  name: string;
}

interface PendingMatch {
  start: number;
  end: number;
  name: string;
  /** True for a match that began in text already released. */
  open: boolean;
}

/**
 * Streaming redactor for agent secret values. Feed output through
 * {@link push} as it arrives and call {@link flush} at the end of the
 * stream; {@link redactions} counts the replacements made so far.
 *
 * Memory stays bounded by the carry plus one chunk: once a match is known
 * to start, the confirmed part of it is dropped and only the fact that a
 * match is open is kept, since it becomes one placeholder whatever its
 * length.
 */
/** The most raw text of one open match a redactor keeps for `takeHeld`. */
const OPEN_RAW_LIMIT = 64 * 1024;

export class SecretValueRedactor {
  private readonly forms: readonly SecretForm[];
  private readonly carry: number;
  private buffer = '';
  /** The name of a match that began in text already released. */
  private openName: string | null = null;
  /** Where that open match's confirmed span ends in `buffer`. */
  private openEnd = 0;
  /**
   * The raw text of the open match before `buffer`: neither released nor
   * held, owed as its placeholder. Kept up to OPEN_RAW_LIMIT characters, for
   * {@link takeHeld}; past that (a long self-overlapping run) only the fact
   * that it overflowed is kept.
   */
  private openRaw = '';
  private openRawOverflowed = false;
  private count = 0;

  /**
   * @param secrets secret name to value. Names must be valid secret names;
   *   values shorter than 4 characters are not matched.
   */
  constructor(secrets: AgentSecretValues) {
    const byForm = new Map<string, string>();
    // Sorted names, so two secrets sharing a value always resolve alike.
    for (const name of Object.keys(secrets).sort()) {
      if (!isAgentSecretName(name)) {
        throw new TypeError('Secret names must match the secret name pattern.');
      }
      for (const form of agentSecretValueForms(secrets[name] ?? '')) {
        if (!byForm.has(form)) byForm.set(form, name);
      }
    }
    this.forms = Array.from(byForm, ([form, name]) => ({ form, name })).sort(
      (left, right) => compareForms(left.form, right.form),
    );
    this.carry = Math.max(0, (this.forms[0]?.form.length ?? 0) - 1);
  }

  /** Replacements made so far. */
  get redactions(): number {
    return this.count;
  }

  /**
   * True when an open match outgrew OPEN_RAW_LIMIT: {@link takeHeld} can
   * then give back only its placeholder, not the text a new value might
   * overlap, so a caller handing off to another redactor must withhold what
   * follows instead.
   */
  get heldOverflowed(): boolean {
    return this.openName !== null && this.openRawOverflowed;
  }

  /** Redacts `chunk`, returning what is safe to release now. */
  push(chunk: string): string {
    if (this.forms.length === 0) return chunk;
    this.buffer += chunk;
    return this.drain(false);
  }

  /** Releases everything held back, redacted. The redactor can be reused. */
  flush(): string {
    if (this.forms.length === 0) return '';
    return this.drain(true);
  }

  /**
   * Takes back everything pushed but not yet released, as it was pushed and
   * unredacted (an open match's whole text included), and resets, so
   * another redactor can carry on from it when the values change
   * mid-stream.
   */
  takeHeld(): string {
    // An open match too long to keep can't be matched again: it goes as its
    // placeholder alone, rather than in part (see heldOverflowed).
    const text = this.openRawOverflowed
      ? agentSecretRedactionPlaceholder(this.openName ?? 'SECRET')
      : this.openRaw + this.buffer;
    this.buffer = '';
    this.openRaw = '';
    this.openRawOverflowed = false;
    this.openName = null;
    return text;
  }

  /** Redacts a whole text in one call, continuing the redaction count. */
  redact(text: string): string {
    return this.push(text) + this.flush();
  }

  private drain(final: boolean): string {
    const text = this.buffer;
    // An occurrence that has not fully arrived can only start at or after
    // `safeEnd`: one starting earlier would already end inside `text`.
    const safeEnd = final ? text.length : Math.max(0, text.length - this.carry);
    const values = this.forms.map(({ form }) => form);
    const nextIndexAtOrAfter = createNextIndexLookup(text);
    let output = '';
    let cursor = 0;
    let pending: PendingMatch | null = null;
    if (this.openName !== null) {
      const span = extendMatchToFurthestOverlap(
        values,
        { start: 0, end: this.openEnd },
        nextIndexAtOrAfter,
      );
      pending = { ...span, name: this.openName, open: true };
      this.openName = null;
    }
    for (;;) {
      pending ??= this.nextMatch(cursor, nextIndexAtOrAfter, values);
      if (pending === null) break;
      if (!final && pending.end > safeEnd) {
        if (!pending.open && pending.start >= safeEnd) {
          // A longer form starting here, or an earlier occurrence starting
          // in the carry, may not have fully arrived: decide it later.
          break;
        }
        // The match starts in released text, so every form starting there
        // has arrived and its name is final; only its end can still grow.
        // Keep the unconfirmed window and remember that a match is open.
        output += text.slice(cursor, pending.start);
        const keepFrom = Math.max(pending.start, safeEnd);
        const openRaw =
          (pending.open ? this.openRaw : '') +
          text.slice(pending.start, keepFrom);
        if (!pending.open) this.openRawOverflowed = false;
        if (openRaw.length > OPEN_RAW_LIMIT) {
          this.openRawOverflowed = true;
          this.openRaw = '';
        } else if (!this.openRawOverflowed) this.openRaw = openRaw;
        this.buffer = text.slice(keepFrom);
        this.openName = pending.name;
        this.openEnd = pending.end - keepFrom;
        return output;
      }
      output +=
        text.slice(cursor, pending.start) +
        agentSecretRedactionPlaceholder(pending.name);
      if (pending.open) {
        this.openRaw = '';
        this.openRawOverflowed = false;
      }
      this.count += 1;
      cursor = pending.end;
      pending = null;
    }
    const releaseEnd = final
      ? text.length
      : Math.max(cursor, retreatFromSurrogateSplit(text, safeEnd));
    output += text.slice(cursor, releaseEnd);
    this.buffer = text.slice(releaseEnd);
    return output;
  }

  /** The leftmost match at or after `from`, longest first, fully merged. */
  private nextMatch(
    from: number,
    nextIndexAtOrAfter: (value: string, from: number) => number,
    values: readonly string[],
  ): PendingMatch | null {
    let seed: PendingMatch | null = null;
    for (const { form, name } of this.forms) {
      const start = nextIndexAtOrAfter(form, from);
      if (start === -1) continue;
      // Forms are longest first, so a tie keeps the longest.
      if (seed === null || start < seed.start) {
        seed = { start, end: start + form.length, name, open: false };
      }
    }
    if (seed === null) return null;
    const span = extendMatchToFurthestOverlap(
      values,
      { start: seed.start, end: seed.end },
      nextIndexAtOrAfter,
    );
    return { ...span, name: seed.name, open: false };
  }
}

/**
 * Redacts every held secret value in `text` in one call.
 */
export function redactAgentSecretValues(
  text: string,
  secrets: AgentSecretValues,
): { text: string; redactions: number } {
  const redactor = new SecretValueRedactor(secrets);
  const redacted = redactor.redact(text);
  return { text: redacted, redactions: redactor.redactions };
}

function compareForms(left: string, right: string): number {
  if (left.length !== right.length) return right.length - left.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A cached "next occurrence of `value` at or after `from`" lookup over
 * `text`, the shape `extendMatchToFurthestOverlap` expects. A cached answer
 * is reused only for a query at or after the one that produced it.
 */
function createNextIndexLookup(
  text: string,
): (value: string, from: number) => number {
  const cache = new Map<string, { index: number; searchedFrom: number }>();
  return (value, from) => {
    const cached = cache.get(value);
    if (cached && from >= cached.searchedFrom) {
      if (cached.index === -1) return -1;
      if (cached.index >= from) return cached.index;
    }
    const index = text.indexOf(value, from);
    cache.set(value, { index, searchedFrom: from });
    return index;
  };
}

/** Moves a cut back by one unit rather than split a surrogate pair. */
function retreatFromSurrogateSplit(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const before = text.charCodeAt(index - 1);
  const at = text.charCodeAt(index);
  const highBefore = before >= 0xd800 && before <= 0xdbff;
  const lowAt = at >= 0xdc00 && at <= 0xdfff;
  return highBefore && lowAt ? index - 1 : index;
}

/** `encodeURIComponent`, or null for text with a lone surrogate. */
function percentEncode(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch {
    return null;
  }
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += BASE64_ALPHABET[(triple >> 18) & 63];
    output += BASE64_ALPHABET[(triple >> 12) & 63];
    output += second === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 63];
    output += third === undefined ? '=' : BASE64_ALPHABET[triple & 63];
  }
  return output;
}
