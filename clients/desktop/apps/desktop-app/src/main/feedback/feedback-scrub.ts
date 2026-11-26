/**
 * Credential-shaped text out of the logs a feedback bundle copies (CAN-7620).
 * Any log site can write text that came from a shared definition, a
 * validator, an error or a provider, so the bundle checks what it copies with
 * the shared container scanner's checks instead of trusting each writer.
 * A unit that trips the check, or is too long to check, is replaced by a
 * neutral marker; every other byte is copied unchanged.
 */
import { Transform, type TransformCallback } from 'node:stream';
import { findSecretMaterialRule } from '@canopy/protocol/capability-files';
import { findSharedTextCredentialRule } from '@canopy/protocol/shared-containers';

/**
 * - `log-entries`: main.log, one logger entry (a `[time] [level]` header line
 *   and its continuation lines) at a time, so a private key body is checked
 *   with its header line.
 * - `jsonl-records`: one JSON record per line.
 * - `json-document`: the whole file, withheld whole.
 */
export type FeedbackScrubMode =
  | 'log-entries'
  | 'jsonl-records'
  | 'json-document';

const UNIT_MAX_BYTES = 256 * 1024;
const NEWLINE = 0x0a;
// Enough for an entry prefix and a 64-character scope tag.
const HEADER_PROBE_BYTES = 128;
// electron-log pads short levels (`[info]  `, `[warn]  `) to align the text.
const ENTRY_HEADER =
  /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[[a-z]+\] +/;
// A marker repeats a prefix only when it holds nothing but these characters.
const MARKER_PREFIX = /^[0-9A-Za-z[\] :.-]+$/;
const ENTRY_SCOPE = /^\[[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,63}\]/;

const ENTRY_WITHHELD =
  'Log entry withheld because it looks like it holds a credential';
const ENTRY_TOO_LONG =
  'Log entry withheld because it is too long to check for credentials';
const RECORD_WITHHELD = 'looks like it holds a credential';
const RECORD_TOO_LONG = 'too long to check for credentials';
const FIELD_WITHHELD = 'Withheld because it looks like it holds a credential';
const USER_NAME_PLACEHOLDER = '<user>';
// Local and domain (S-1-5-21) and Microsoft Entra (S-1-12-1) account SIDs:
// main.log names them in a shared-folder warning (CAN-7915). Well-known SIDs
// such as S-1-5-11 identify no one and stay.
const ACCOUNT_SID = /\bS-1-(?:5-21|12-1)(?:-\d+)+/giu;
const ACCOUNT_SID_PLACEHOLDER = '<account-sid>';

export interface FeedbackScrubOptions {
  /**
   * Account names replaced with `<user>` wherever they appear as a path
   * segment in a `log-entries` copy (CAN-6895). Windows logs carry
   * `C:\Users\<name>`, UNC and escaped forms of the profile path; matching
   * the segment covers each of them. Account SIDs are replaced in every
   * `log-entries` copy, with or without names.
   */
  readonly redactPathUserNames?: readonly string[];
}

type TextRedactor = (text: string) => string;

/**
 * Replaces each name where it is a whole path segment: after `\` or `/`, and
 * before a separator, quote, whitespace (including the CR of a CRLF line),
 * punctuation that ends a logged value, a sentence-ending `.`, or the end of
 * the text. Matching is case-insensitive, as Windows paths are. A long name's
 * 8.3 short form (`ALEXAN~1`) is replaced too.
 */
function pathUserNameRedactor(
  names: readonly string[] | undefined,
): TextRedactor | undefined {
  const alternatives = new Set<string>();
  for (const name of names ?? []) {
    const trimmed = name.trim();
    if (trimmed === '' || /[\\/]/.test(trimmed)) continue;
    alternatives.add(escapeRegExp(trimmed));
    const compact = trimmed.replace(/[\s.]/g, '');
    if (compact.length > 8 || compact !== trimmed)
      alternatives.add(`${escapeRegExp(compact.slice(0, 6))}~\\d{1,6}`);
  }
  if (alternatives.size === 0) return undefined;
  const pattern = new RegExp(
    `(?<=[\\\\/])(?:${[...alternatives].join('|')})(?=[\\\\/"'\\s,;:)\\]}>]|\\.(?:\\s|$)|$)`,
    'giu',
  );
  return (text) => text.replace(pattern, USER_NAME_PLACEHOLDER);
}

/** Account SIDs, then any account path segments. */
function logEntryRedactor(names: readonly string[] | undefined): TextRedactor {
  const paths = pathUserNameRedactor(names);
  return (text) => {
    const withoutSids = text.replace(ACCOUNT_SID, ACCOUNT_SID_PLACEHOLDER);
    return paths ? paths(withoutSids) : withoutSids;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The same checks the shared container scanner and CAN-7615's logSafeText use. */
function looksLikeCredential(text: string): boolean {
  return (
    findSharedTextCredentialRule(text) !== null ||
    findSecretMaterialRule(text) !== null
  );
}

/** A copied string field, or a neutral replacement when it trips the check. */
export function withheldIfCredential(
  value: string | undefined,
): string | undefined {
  return value !== undefined && looksLikeCredential(value)
    ? FIELD_WITHHELD
    : value;
}

/**
 * Every string a parsed JSON value holds, each key with its primitive value
 * in compact form, and each key, so text escaped inside a JSON string is
 * checked as written.
 */
function jsonHoldsCredential(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') {
      if (looksLikeCredential(next)) return true;
    } else if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (typeof next === 'object' && next !== null) {
      for (const [key, child] of Object.entries(next)) {
        if (looksLikeCredential(key)) return true;
        if (
          typeof child === 'string' ||
          typeof child === 'number' ||
          typeof child === 'boolean'
        ) {
          if (
            looksLikeCredential(
              `${JSON.stringify(key)}:${JSON.stringify(child)}`,
            )
          )
            return true;
        }
        pending.push(child);
      }
    }
  }
  return false;
}

const NOT_JSON = Symbol('not JSON');

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

function jsonUnitHoldsCredential(text: string): boolean {
  if (looksLikeCredential(text)) return true;
  const parsed = parseJson(text);
  return parsed !== NOT_JSON && jsonHoldsCredential(parsed);
}

function checkedStringField(record: unknown, key: string): string | undefined {
  if (typeof record !== 'object' || record === null || Array.isArray(record))
    return undefined;
  const value: unknown = Reflect.get(record, key);
  return typeof value === 'string' && !looksLikeCredential(value)
    ? value
    : undefined;
}

interface Unit {
  head: Buffer;
  parts: Buffer[];
  bytes: number;
  tooLong: boolean;
  endsWithNewline: boolean;
}

/** Splits bytes into lines and lines into units, then emits each unit checked. */
class UnitScrubber {
  private unit: Unit | undefined;
  private lineHead: Buffer[] | undefined;
  private lineHeadBytes = 0;
  private lineClassified = false;

  constructor(
    private readonly mode: 'log-entries' | 'jsonl-records',
    private readonly emit: (bytes: Buffer) => void,
    private readonly redact?: TextRedactor,
  ) {}

  write(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline + 1;
      this.lineBytes(chunk.subarray(start, end), newline !== -1);
      start = end;
    }
  }

  end(): void {
    if (this.lineHead !== undefined) this.classifyLine(this.lineHead);
    this.flushUnit();
  }

  private lineBytes(bytes: Buffer, endsLine: boolean): void {
    if (this.lineClassified) {
      this.append(bytes);
    } else {
      const head = this.lineHead ?? [];
      head.push(bytes);
      this.lineHead = head;
      this.lineHeadBytes += bytes.length;
      if (endsLine || this.lineHeadBytes >= HEADER_PROBE_BYTES)
        this.classifyLine(head);
    }
    if (endsLine) this.lineClassified = false;
  }

  /** Starts a unit at this line when it opens one, then appends the line. */
  private classifyLine(head: Buffer[]): void {
    const bytes = Buffer.concat(head);
    this.lineHead = undefined;
    this.lineHeadBytes = 0;
    this.lineClassified = true;
    if (
      this.unit === undefined ||
      this.mode === 'jsonl-records' ||
      ENTRY_HEADER.test(bytes.toString('latin1'))
    ) {
      this.flushUnit();
      this.unit = {
        head: bytes.subarray(0, HEADER_PROBE_BYTES),
        parts: [],
        bytes: 0,
        tooLong: false,
        endsWithNewline: false,
      };
    }
    this.append(bytes);
  }

  private append(bytes: Buffer): void {
    const unit = this.unit;
    if (unit === undefined || bytes.length === 0) return;
    unit.bytes += bytes.length;
    unit.endsWithNewline = bytes[bytes.length - 1] === NEWLINE;
    if (unit.tooLong) return;
    if (unit.bytes > UNIT_MAX_BYTES) {
      unit.tooLong = true;
      unit.parts = [];
      return;
    }
    unit.parts.push(bytes);
  }

  private flushUnit(): void {
    const unit = this.unit;
    if (unit === undefined) return;
    this.unit = undefined;
    if (unit.tooLong) {
      this.emit(this.redacted(this.marker(unit, undefined)));
      return;
    }
    const bytes = Buffer.concat(unit.parts);
    const text = bytes.toString('utf8');
    const holds =
      this.mode === 'log-entries'
        ? looksLikeCredential(text)
        : jsonUnitHoldsCredential(text);
    this.emit(this.redacted(holds ? this.marker(unit, text) : bytes));
  }

  /** The bytes with account SIDs and path segments replaced; unchanged when none match. */
  private redacted(bytes: Buffer): Buffer {
    if (this.redact === undefined) return bytes;
    const text = bytes.toString('utf8');
    const redacted = this.redact(text);
    return redacted === text ? bytes : Buffer.from(redacted, 'utf8');
  }

  /** `text` is the unit's text when it was checked, undefined when too long. */
  private marker(unit: Unit, text: string | undefined): Buffer {
    const newline = unit.endsWithNewline ? '\n' : '';
    if (this.mode === 'jsonl-records') {
      const record = text === undefined ? NOT_JSON : parseJson(text);
      const timestamp = checkedStringField(record, 'timestamp');
      const kind = checkedStringField(record, 'kind');
      return Buffer.from(
        `${JSON.stringify({
          withheld: text === undefined ? RECORD_TOO_LONG : RECORD_WITHHELD,
          ...(timestamp === undefined ? {} : { timestamp }),
          ...(kind === undefined ? {} : { kind }),
        })}${newline}`,
        'utf8',
      );
    }
    const head = unit.head.toString('utf8');
    const header = ENTRY_HEADER.exec(head);
    const reason = text === undefined ? ENTRY_TOO_LONG : ENTRY_WITHHELD;
    if (header === null) return Buffer.from(`${reason}${newline}`, 'utf8');
    const prefix = MARKER_PREFIX.test(header[0]) ? header[0] : '';
    const scope = ENTRY_SCOPE.exec(head.slice(header[0].length))?.[0];
    const checkedScope =
      prefix === '' || scope === undefined || looksLikeCredential(scope)
        ? ''
        : `${scope} `;
    return Buffer.from(`${prefix}${checkedScope}${reason}${newline}`, 'utf8');
  }
}

/** Holds the whole document, then emits it or a stub in its place. */
class DocumentScrubber {
  private readonly parts: Buffer[] = [];

  constructor(private readonly emit: (bytes: Buffer) => void) {}

  write(chunk: Buffer): void {
    this.parts.push(chunk);
  }

  end(): void {
    const bytes = Buffer.concat(this.parts);
    const text = bytes.toString('utf8');
    const lines = text.split('\n');
    const tooLong = lines.some(
      (line) => Buffer.byteLength(line, 'utf8') > UNIT_MAX_BYTES,
    );
    const parsed = tooLong ? NOT_JSON : parseJson(text);
    // A parsed document's walk checks every string, key and pair it holds.
    const holds =
      !tooLong &&
      (parsed === NOT_JSON
        ? lines.some((line) => looksLikeCredential(line))
        : jsonHoldsCredential(parsed));
    if (!tooLong && !holds) {
      this.emit(bytes);
      return;
    }
    this.emit(
      Buffer.from(
        `${JSON.stringify({ withheld: tooLong ? RECORD_TOO_LONG : RECORD_WITHHELD })}\n`,
        'utf8',
      ),
    );
  }
}

class FeedbackScrubStream extends Transform {
  private readonly scrubber: UnitScrubber | DocumentScrubber;

  constructor(mode: FeedbackScrubMode, options: FeedbackScrubOptions) {
    super();
    const emit = (bytes: Buffer): void => {
      if (bytes.length > 0) this.push(bytes);
    };
    this.scrubber =
      mode === 'json-document'
        ? new DocumentScrubber(emit)
        : new UnitScrubber(
            mode,
            emit,
            mode === 'log-entries'
              ? logEntryRedactor(options.redactPathUserNames)
              : undefined,
          );
  }

  override _transform(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (!Buffer.isBuffer(chunk)) {
      callback(new TypeError('A feedback scrub reads bytes'));
      return;
    }
    this.scrubber.write(chunk);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.scrubber.end();
    callback();
  }
}

/**
 * A stream that copies a bundled file with its credential-shaped units
 * withheld and, for `log-entries`, account SIDs and (given names) account
 * path segments replaced.
 */
export function createFeedbackScrub(
  mode: FeedbackScrubMode,
  options: FeedbackScrubOptions = {},
): Transform {
  return new FeedbackScrubStream(mode, options);
}
