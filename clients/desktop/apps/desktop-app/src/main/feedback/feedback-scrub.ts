/**
 * Credential-shaped text out of the logs a feedback bundle copies (CAN-7620).
 * Any log site can write text that came from a shared definition, a
 * validator, an error or a provider, so the bundle checks what it copies with
 * the shared container scanner's checks instead of trusting each writer.
 * A unit that trips the check, or is too long to check, is replaced by a
 * neutral marker; every other byte is copied unchanged. Process output
 * (CAN-7623) is checked the same way unit by unit, but on any hit the whole
 * file is replaced by one stub.
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
 * - `process-output`: script, hook and pipeline run files (CAN-7623): a JSON
 *   file checked as a document, a binary file as a whole, any other file by
 *   line, and the whole file withheld on any hit.
 * - `worktrees-discovery`: worktrees.json, with the `discovery` of each row
 *   checked by field (CAN-7623).
 */
export type FeedbackScrubMode =
  | 'log-entries'
  | 'jsonl-records'
  | 'json-document'
  | 'process-output'
  | 'worktrees-discovery';

export type WithheldReason = 'credential' | 'private-key-block' | 'too-long';

/** What a scrub withheld from one file: counts and reasons, never text. */
export interface WithheldSummary {
  mode:
    | 'log-entries'
    | 'jsonl-records'
    | 'json-document'
    | 'json-fields'
    | 'whole-file';
  units: number;
  reasons: WithheldReason[];
}

export interface FeedbackScrubContext extends FeedbackScrubOptions {
  /** The file's path in the bundle, which picks a process output file's kind. */
  path: string;
  /** Called once, when the file is written, if anything was withheld. */
  report?: (summary: WithheldSummary) => void;
}

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

const PROCESS_WITHHELD = 'may hold a credential';
const PROCESS_TOO_LARGE = 'too large to check for credentials';
// A JSON or JSONL process output file above this is withheld whole without
// being parsed: its readings walk every value, so a larger one would hold the
// main process for seconds.
const PROCESS_JSON_MAX_BYTES = 2 * 1024 * 1024;
const FILE_WITHHELD =
  'This file was withheld from the feedback bundle because it looks like it holds a credential.\n';
// A file with a NUL byte in its first 8 KiB is binary: a marker line inside it
// would corrupt it, so it is checked and withheld as a whole.
const BINARY_PROBE_BYTES = 8 * 1024;
const ESC = '\u001b';
// The opener of a terminal string: OSC, DCS, SOS, PM or APC, as ESC and a
// character or as its 8-bit control.
const STRING_OPENER = `(?:${ESC}[\\]PX^_]|[\\u0090\\u0098\\u009d\\u009e\\u009f])`;
// A string's text runs to BEL or ST (ESC and a backslash, or its 8-bit
// control). It stops at any other escape or 8-bit control, so a run of
// openers with no end is read in one pass.
const STRING_TEXT = `[^${ESC}\\u0007\\u0090\\u0098\\u009b-\\u009f]*`;
const STRING_END = `(?:\\u0007|${ESC}\\\\|\\u009c)`;
// CSI sequences, terminal strings, the two-byte escapes a terminal writes,
// and any other 8-bit control.
const ANSI_ESCAPE = new RegExp(
  `(?:${ESC}\\[|\\u009b)[0-?]*[ -/]*[@-~]|${STRING_OPENER}${STRING_TEXT}${STRING_END}|${ESC}[@-Z\\\\-_]|[\\u0080-\\u009f]`,
  'g',
);
// A raw 8-bit control is not UTF-8, so it reads as U+FFFD. Read that as a
// CSI opener, and as a string opener ended by BEL, ST or another U+FFFD.
const RAW_C1_SEQUENCE = /\uFFFD[0-?]*[ -/]*[@-~]/g;
const RAW_C1_STRING = new RegExp(
  `\\uFFFD[^${ESC}\\u0007\\uFFFD]*(?:\\u0007|${ESC}\\\\|\\uFFFD)|\\uFFFD`,
  'g',
);
// A terminal string not ended by BEL or ST: cut off by another escape or
// 8-bit control, or still open at the end of the text. No escape reading
// knows where its text stops, so a key header it splits could be missed.
const OPEN_TERMINAL_STRING = new RegExp(
  `${STRING_OPENER}${STRING_TEXT}(?:${ESC}(?!\\\\)|[\\u0090\\u0098\\u009b\\u009d-\\u009f]|$)`,
);
// An escape, an 8-bit control, or the U+FFFD a raw one reads as.
const TERMINAL_CONTROL = new RegExp(`[${ESC}\\u0080-\\u009f\\uFFFD]`);
const UNREADABLE_SUFFIX = /\.unreadable-\d+$/;
// A terminal escape written out as text, as JSON, C and shell strings do.
const ENCODED_ANSI = /(?:\\u001[bB]|\\x1[bB]|\\033|\\e)\[[0-?]*[ -/]*[@-~]/g;
const ENCODED_ANSI_PROBE = /(?:\\u001[bB]|\\x1[bB]|\\033|\\e)\[/;
// How much of an overlong line's dropped bytes is carried into the next
// scan, so a key header split by a write or by the 256 KiB cut is found.
const HEADER_WINDOW_BYTES = 1024;

// Bytes a scrub holds until the end of a file are kept in buffers of this
// size, not one per line or unit, so a newline-heavy file costs about its size.
const HELD_CHUNK_BYTES = 64 * 1024;

/**
 * Bytes held to the end of a file, in buffers of at least HELD_CHUNK_BYTES
 * but the last: small writes are copied together, and a large one is kept as
 * it is when no copy is open, so held memory is about the bytes held.
 */
class HeldBytes {
  private readonly full: Buffer[] = [];
  private current: Buffer | undefined;
  private used = 0;

  push(bytes: Buffer): void {
    if (this.current !== undefined && this.used === this.current.length) {
      this.full.push(this.current);
      this.current = undefined;
    }
    if (this.current === undefined && bytes.length >= HELD_CHUNK_BYTES) {
      this.full.push(bytes);
      return;
    }
    for (let offset = 0; offset < bytes.length; ) {
      if (this.current === undefined || this.used === this.current.length) {
        if (this.current !== undefined) this.full.push(this.current);
        this.current = Buffer.alloc(HELD_CHUNK_BYTES);
        this.used = 0;
      }
      const copied = bytes.copy(this.current, this.used, offset);
      this.used += copied;
      offset += copied;
    }
  }

  chunks(): Buffer[] {
    return this.current === undefined || this.used === 0
      ? [...this.full]
      : [...this.full, this.current.subarray(0, this.used)];
  }

  clear(): void {
    this.full.length = 0;
    this.current = undefined;
    this.used = 0;
  }
}

class Tally {
  units = 0;
  private readonly reasons = new Set<WithheldReason>();

  add(reason: WithheldReason): void {
    this.units += 1;
    this.reasons.add(reason);
  }

  summary(mode: WithheldSummary['mode']): WithheldSummary | undefined {
    if (this.units === 0) return undefined;
    return { mode, units: this.units, reasons: [...this.reasons].sort() };
  }
}

/** The same checks the shared container scanner and CAN-7615's logSafeText use. */
function matchesCredentialRule(text: string): boolean {
  return (
    findSharedTextCredentialRule(text) !== null ||
    findSecretMaterialRule(text) !== null
  );
}

/** A terminal escape, raw or written out as text. */
function hasTerminalEscape(text: string): boolean {
  return TERMINAL_CONTROL.test(text) || ENCODED_ANSI_PROBE.test(text);
}

/**
 * The text as written and, when it holds a terminal escape (raw, as an
 * 8-bit control, or written out as a backslash and `u001b`, `x1b`, `033` or
 * `e`), with those escapes removed and read as spaces. A raw 8-bit control
 * reads as U+FFFD, so that is also read as one, both ways. A color code can split a token or glue it to a
 * word, so each catches what another misses.
 */
function escapeReadings(text: string): string[] {
  if (!hasTerminalEscape(text)) return [text];
  const removed = text.replace(ANSI_ESCAPE, '').replace(ENCODED_ANSI, '');
  const spaced = text.replace(ANSI_ESCAPE, ' ').replace(ENCODED_ANSI, ' ');
  if (!removed.includes('\uFFFD')) return [text, removed, spaced];
  return [
    text,
    removed,
    spaced,
    removed.replace(RAW_C1_SEQUENCE, ''),
    spaced.replace(RAW_C1_SEQUENCE, ' '),
    removed.replace(RAW_C1_STRING, ''),
    spaced.replace(RAW_C1_STRING, ' '),
  ];
}

// How many times text that is itself JSON is parsed again. Text nested deeper
// still counts as holding a credential (fail closed).
const NESTED_JSON_DEPTH = 4;
// How many keys above a value its `"key":value` pairs are read with, so a
// value in an array or object under a credential-named key is still paired.
const PAIRED_KEYS = 4;

// A JSON string escape: a backslash before a quote, a backslash or a slash, or
// a backslash, u and four hex digits. Escaped line breaks are left as written.
const JSON_STRING_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/]))/g;
const JSON_STRING_ESCAPE_PROBE = /\\(?:u[0-9a-fA-F]{4}|["\\/])/;
const LINE_BREAK_CODES = new Set([0x0a, 0x0d]);

/** The text with its JSON string escapes decoded in place, wherever they sit. */
function jsonUnescaped(text: string): string | undefined {
  if (!JSON_STRING_ESCAPE_PROBE.test(text)) return undefined;
  const decoded = text.replace(
    JSON_STRING_ESCAPE,
    (escape, hex: string | undefined, char: string | undefined) => {
      if (char !== undefined) return char;
      const code = Number.parseInt(hex ?? '', 16);
      return LINE_BREAK_CODES.has(code) ? escape : String.fromCharCode(code);
    },
  );
  return decoded === text ? undefined : decoded;
}

interface Reading {
  text: string;
  /** JSON nested past the depth limit: read as a credential. */
  tooDeep: boolean;
}

function looksLikeJson(text: string): boolean {
  const start = text.trimStart()[0];
  return start === '{' || start === '[' || start === '"';
}

/**
 * Every reading any decision in this file runs on, credentials and key
 * headers alike: each escape reading of the text; the text with its JSON
 * string escapes decoded in place, so JSON after a prefix or inside a string
 * is read too; and, for each escape reading that parses as JSON, every
 * string, key and `"key":value` pair it holds. Each is read the same way in
 * turn, to the depth limit. The neutral field text this file writes is
 * skipped. Lazy, so a check stops at its first hit.
 */
function* readings(text: string, depth = 0, parse = true): Generator<Reading> {
  const escaped = escapeReadings(text);
  for (const reading of escaped) yield { text: reading, tooDeep: false };
  // The other escape readings differ only in their terminal escapes, which
  // the decoded text's own escape readings cover one level down.
  const unescaped = jsonUnescaped(text);
  if (unescaped !== undefined) {
    if (depth >= NESTED_JSON_DEPTH) yield { text: '', tooDeep: true };
    else yield* readings(unescaped, depth + 1, parse);
  }
  if (!parse) return;
  for (const reading of escaped) {
    if (!looksLikeJson(reading)) continue;
    const parsed = parseJson(reading);
    if (parsed === NOT_JSON) continue;
    if (depth >= NESTED_JSON_DEPTH) {
      yield { text: '', tooDeep: true };
      continue;
    }
    yield* valueReadings(parsed, depth + 1);
  }
}

function* valueReadings(value: unknown, depth: number): Generator<Reading> {
  const pending: [unknown, readonly string[]][] = [[value, []]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, keys] = next;
    if (item === FIELD_WITHHELD) continue;
    if (
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      const written = JSON.stringify(item);
      for (const key of keys)
        // A `"key":value` pair is never JSON text, so it is not parsed.
        yield* readings(`${JSON.stringify(key)}:${written}`, depth, false);
    }
    if (typeof item === 'string') {
      yield* readings(item, depth);
    } else if (Array.isArray(item)) {
      for (const child of item) pending.push([child, keys]);
    } else if (typeof item === 'object' && item !== null) {
      for (const [key, child] of Object.entries(item)) {
        yield* readings(key, depth);
        pending.push([child, [...keys, key].slice(-PAIRED_KEYS)]);
      }
    }
  }
}

// The neutral field text, as JSON writes it, reads as an empty value, so a
// field this file withheld never trips the check on its own output.
const FIELD_WITHHELD_JSON = JSON.stringify(FIELD_WITHHELD);

/** The one credential check every unit, field and file in this file goes through. */
function holdsCredential(text: string): boolean {
  const checked = text.split(FIELD_WITHHELD_JSON).join('""');
  for (const reading of readings(checked))
    if (reading.tooDeep || matchesCredentialRule(reading.text)) return true;
  return false;
}

/** Whether text opens a private key block, in any reading. */
function opensKeyBlock(text: string, parse = true): boolean {
  for (const reading of readings(text, 0, parse)) {
    // Nested past the depth limit, it may hide a header: fail closed.
    if (reading.tooDeep) return true;
    if (findSecretMaterialRule(reading.text) === 'private_key') return true;
  }
  return false;
}

/** A copied string field, or a neutral replacement when it trips the check. */
export function withheldIfCredential(
  value: string | undefined,
): string | undefined {
  return value !== undefined && holdsCredential(value) ? FIELD_WITHHELD : value;
}

const NOT_JSON = Symbol('not JSON');

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

function checkedStringField(record: unknown, key: string): string | undefined {
  if (typeof record !== 'object' || record === null || Array.isArray(record))
    return undefined;
  const value: unknown = Reflect.get(record, key);
  return typeof value === 'string' && !holdsCredential(value)
    ? value
    : undefined;
}

interface Unit {
  head: Buffer;
  parts: Buffer[];
  bytes: number;
  tooLong: boolean;
  endsWithNewline: boolean;
  // A record's dropped bytes past the limit are still scanned for a key
  // header, through a carried window.
  window: string;
  opensKeyBlock: boolean;
}

/** Splits bytes into lines and lines into units, then emits each unit checked. */
class UnitScrubber {
  private unit: Unit | undefined;
  private lineHead: Buffer[] | undefined;
  private lineHeadBytes = 0;
  private lineClassified = false;
  // JSONL: once a record opens a private key block, every later record is
  // withheld to the end of the file. No end record closes it (fail closed).
  private keyBlockOpen = false;

  constructor(
    private readonly mode: 'log-entries' | 'jsonl-records',
    private readonly emit: (bytes: Buffer) => void,
    private readonly tally: Tally,
  ) {}

  get reportedMode(): WithheldSummary['mode'] {
    return this.mode;
  }

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
        window: '',
        opensKeyBlock: false,
      };
    }
    this.append(bytes);
  }

  private append(bytes: Buffer): void {
    const unit = this.unit;
    if (unit === undefined || bytes.length === 0) return;
    unit.bytes += bytes.length;
    unit.endsWithNewline = bytes[bytes.length - 1] === NEWLINE;
    if (unit.tooLong) {
      this.scanOverflow(unit, bytes);
      return;
    }
    if (unit.bytes > UNIT_MAX_BYTES) {
      unit.tooLong = true;
      const dropped = Buffer.concat([...unit.parts, bytes]);
      unit.parts = [];
      this.scanOverflow(unit, dropped);
      return;
    }
    unit.parts.push(bytes);
  }

  /** Each byte is scanned once, plus the carried window: linear. */
  private scanOverflow(unit: Unit, bytes: Buffer): void {
    if (this.mode !== 'jsonl-records' || unit.opensKeyBlock) return;
    const window = `${unit.window}${bytes.toString('latin1')}`;
    unit.opensKeyBlock = opensKeyBlock(window);
    unit.window = window.slice(-HEADER_WINDOW_BYTES);
  }

  private flushUnit(): void {
    const unit = this.unit;
    if (unit === undefined) return;
    this.unit = undefined;
    const bytes = Buffer.concat(unit.parts);
    const text = unit.tooLong ? undefined : bytes.toString('utf8');
    if (
      this.mode === 'jsonl-records' &&
      (unit.opensKeyBlock || (text !== undefined && opensKeyBlock(text)))
    )
      this.keyBlockOpen = true;
    if (this.keyBlockOpen) {
      this.tally.add('private-key-block');
      // No field of a record inside a key block is copied: base64 key text
      // trips no check on its own, so it could sit in any of them.
      this.emit(this.marker(unit, text, false));
      return;
    }
    if (text === undefined) {
      this.tally.add('too-long');
      this.emit(this.marker(unit, undefined));
      return;
    }
    // A log entry spans lines and is not JSON as a whole, so each of its
    // lines is read too. A key header is a credential to the shared check,
    // so a header in any reading withholds the entry, and so does a terminal
    // string the entry leaves open.
    const holds =
      (this.mode === 'log-entries' && OPEN_TERMINAL_STRING.test(text)) ||
      holdsCredential(text) ||
      (this.mode === 'log-entries' &&
        text.includes('\n') &&
        text.split('\n').some((line) => holdsCredential(line)));
    if (holds) this.tally.add('credential');
    this.emit(holds ? this.marker(unit, text) : bytes);
  }

  /**
   * `text` is the unit's text when it was checked, undefined when too long.
   * A JSONL marker keeps a record's checked `timestamp` and `kind` only when
   * `copyFields` is set.
   */
  private marker(
    unit: Unit,
    text: string | undefined,
    copyFields = true,
  ): Buffer {
    const newline = unit.endsWithNewline ? '\n' : '';
    if (this.mode === 'jsonl-records') {
      const record =
        text === undefined || !copyFields ? NOT_JSON : parseJson(text);
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
      prefix === '' || scope === undefined || holdsCredential(scope)
        ? ''
        : `${scope} `;
    return Buffer.from(`${prefix}${checkedScope}${reason}${newline}`, 'utf8');
  }
}

/** Holds the whole document, then emits it or a stub in its place. */
class DocumentScrubber {
  private readonly parts: Buffer[] = [];
  readonly reportedMode = 'json-document';

  constructor(
    private readonly emit: (bytes: Buffer) => void,
    private readonly tally: Tally,
  ) {}

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
    // The document as JSON in every reading (a parsed walk checks every
    // string, key and pair it holds), and each of its lines.
    const holds =
      !tooLong &&
      (holdsCredential(text) || lines.some((line) => holdsCredential(line)));
    if (!tooLong && !holds) {
      this.emit(bytes);
      return;
    }
    this.tally.add(tooLong ? 'too-long' : 'credential');
    this.emit(documentStub(tooLong));
  }
}

function documentStub(tooLong: boolean): Buffer {
  return Buffer.from(
    `${JSON.stringify({ withheld: tooLong ? RECORD_TOO_LONG : RECORD_WITHHELD })}\n`,
    'utf8',
  );
}

function lineText(bytes: Buffer): string {
  const end =
    bytes[bytes.length - 1] === NEWLINE ? bytes.length - 1 : bytes.length;
  return bytes.subarray(0, end).toString('utf8');
}

interface FieldWalk {
  value: unknown;
  withheld: number;
  /** A key itself tripped the check, so no single value can be withheld. */
  unplaced: boolean;
}

/**
 * The value with every string, and every primitive whose `"key":value` pair
 * trips the check, replaced by the neutral field text. JSON.parse's reviver
 * visits every value once, children first, without recursing in this code.
 */
function withholdFields(text: string): FieldWalk | undefined {
  let withheld = 0;
  let unplaced = false;
  let value: unknown;
  try {
    value = JSON.parse(
      text,
      function (this: unknown, key: string, child: unknown) {
        const inArray = Array.isArray(this);
        if (child === FIELD_WITHHELD) return child;
        if (
          typeof child === 'object' &&
          child !== null &&
          !Array.isArray(child)
        ) {
          if (Object.keys(child).some((name) => holdsCredential(name)))
            unplaced = true;
          return child;
        }
        if (typeof child === 'string' && holdsCredential(child)) {
          withheld += 1;
          return FIELD_WITHHELD;
        }
        if (
          !inArray &&
          key !== '' &&
          (typeof child === 'string' ||
            typeof child === 'number' ||
            typeof child === 'boolean') &&
          holdsCredential(`${JSON.stringify(key)}:${JSON.stringify(child)}`)
        ) {
          withheld += 1;
          return FIELD_WITHHELD;
        }
        return child;
      },
    );
  } catch {
    return undefined;
  }
  return { value, withheld, unplaced };
}

/** The file's own indentation: two spaces, a tab, or none (compact). */
function serializeLike(original: string, value: unknown): Buffer {
  const indent = /^[[{]\r?\n([ \t]+)/.exec(original)?.[1];
  const ending = original.endsWith('\n') ? '\n' : '';
  return Buffer.from(`${JSON.stringify(value, null, indent)}${ending}`, 'utf8');
}

/**
 * Checks the discovery of each row of a parsed worktrees.json by field,
 * replacing rows in place. Returns how many units were withheld.
 */
export function withholdWorktreesDiscovery(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const field: unknown = Reflect.get(value, 'worktrees');
  if (!Array.isArray(field)) return 0;
  const rows: unknown[] = field;
  let withheld = 0;
  rows.forEach((row, index) => {
    if (typeof row !== 'object' || row === null || !('discovery' in row))
      return;
    const discovery: unknown = Reflect.get(row, 'discovery');
    const text = JSON.stringify(discovery);
    const walk = withholdFields(text);
    // A credential the walk can't place, or a key header in any value,
    // withholds the row's whole discovery.
    if (
      walk === undefined ||
      walk.unplaced ||
      opensKeyBlock(text) ||
      holdsCredential(JSON.stringify(walk.value))
    ) {
      withheld += 1;
      rows[index] = { ...row, discovery: FIELD_WITHHELD };
      return;
    }
    if (walk.withheld === 0) return;
    withheld += walk.withheld;
    rows[index] = { ...row, discovery: walk.value };
  });
  return withheld;
}

/** worktrees.json as written, with each row's discovery checked by field. */
class WorktreesDiscoveryScrubber {
  reportedMode: WithheldSummary['mode'] = 'json-fields';
  private readonly parts: Buffer[] = [];

  constructor(
    private readonly path: string,
    private readonly emit: (bytes: Buffer) => void,
    private readonly tally: Tally,
  ) {}

  write(chunk: Buffer): void {
    this.parts.push(chunk);
  }

  end(): void {
    const bytes = Buffer.concat(this.parts);
    const text = bytes.toString('utf8');
    const parsed = parseJson(text);
    if (parsed === NOT_JSON) {
      // Fail closed: what can't be read as worktrees.json is checked as
      // process output is, and withheld whole on any hit.
      this.reportedMode = 'whole-file';
      const file = new ProcessOutputScrubber(this.path, this.emit, this.tally);
      file.write(bytes);
      file.end();
      return;
    }
    const withheld = withholdWorktreesDiscovery(parsed);
    if (withheld === 0) {
      this.emit(bytes);
      return;
    }
    for (let index = 0; index < withheld; index += 1)
      this.tally.add('credential');
    this.emit(serializeLike(text, parsed));
  }
}

interface Scrubber {
  readonly reportedMode: WithheldSummary['mode'];
  /** Set when the scrubber already checks every unit it emits, as the gate would. */
  readonly checksEachUnit?: boolean;
  write(chunk: Buffer): void;
  end(): void;
  /** What the output gate writes in place of the file, when not the default. */
  stub?(): Buffer;
}

/**
 * A process output file: script, hook and pipeline run output, transcripts,
 * reports and run records (CAN-7623). It is checked unit by unit with every
 * reading, and copied byte for byte when nothing trips. On any hit, or a line
 * too long to check, the whole file is replaced by one stub that names it, so
 * no key follow or end line decides which bytes are copied. Each line is
 * checked as its chunk arrives; a JSON document is also read whole at the
 * end, and a binary file (a NUL byte in its first 8 KiB) is read only whole.
 * A JSON or JSONL file above the size cap is withheld without being parsed.
 */
class ProcessOutputScrubber {
  readonly reportedMode = 'whole-file';
  readonly checksEachUnit = true;
  private readonly json: boolean;
  private readonly documentName: boolean;
  private kind: 'probe' | 'binary' | 'lines' = 'probe';
  // The file's first bytes, until its kind is known.
  private parts: Buffer[] = [];
  // The checked lines (or, for a binary file, its bytes), until the end decides.
  private readonly held = new HeldBytes();
  private bytes = 0;
  private line: Buffer[] = [];
  private lineBytes = 0;
  private reason: WithheldReason | undefined;
  private tooLarge = false;

  constructor(
    private readonly path: string,
    private readonly emit: (bytes: Buffer) => void,
    private readonly tally: Tally,
  ) {
    const name = path.replace(UNREADABLE_SUFFIX, '');
    this.json = /\.(?:json|jsonl|ndjson)$/.test(name);
    this.documentName = name.endsWith('.json');
  }

  write(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.reason !== undefined) return;
    if (this.json && this.bytes > PROCESS_JSON_MAX_BYTES) {
      this.withhold('too-long', true);
      return;
    }
    if (this.kind === 'probe') {
      this.parts.push(chunk);
      if (this.bytes >= BINARY_PROBE_BYTES) this.choose();
      return;
    }
    this.take(chunk);
  }

  end(): void {
    if (this.reason === undefined && this.kind === 'probe') this.choose();
    if (this.reason === undefined && this.line.length > 0) this.finishLine();
    if (this.reason === undefined) this.checkWhole();
    if (this.reason !== undefined) {
      this.tally.add(this.reason);
      this.emit(this.stub());
      return;
    }
    for (const chunk of this.held.chunks()) this.emit(chunk);
    this.held.clear();
  }

  stub(): Buffer {
    const base = this.path.split('/').pop() ?? '';
    const name = base === '' || holdsCredential(base) ? 'this file' : base;
    const withheld = this.tooLarge ? PROCESS_TOO_LARGE : PROCESS_WITHHELD;
    return Buffer.from(
      this.json
        ? `${JSON.stringify({ file: name, withheld })}\n`
        : `[${name} withheld: ${withheld}]\n`,
      'utf8',
    );
  }

  private choose(): void {
    const head = Buffer.concat(this.parts);
    this.parts = [];
    this.kind = head.subarray(0, BINARY_PROBE_BYTES).includes(0)
      ? 'binary'
      : 'lines';
    this.take(head);
  }

  private take(chunk: Buffer): void {
    if (this.kind === 'binary') {
      this.held.push(chunk);
      return;
    }
    for (let start = 0; start < chunk.length && this.reason === undefined; ) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline + 1;
      this.line.push(chunk.subarray(start, end));
      this.lineBytes += end - start;
      // The line ending itself does not count toward the limit.
      if (this.lineBytes > UNIT_MAX_BYTES + 2) this.withhold('too-long');
      else if (newline !== -1) this.finishLine();
      start = end;
    }
  }

  private finishLine(): void {
    const line = Buffer.concat(this.line);
    this.line = [];
    this.lineBytes = 0;
    const text = lineText(line);
    const reason =
      Buffer.byteLength(text, 'utf8') > UNIT_MAX_BYTES
        ? 'too-long'
        : OPEN_TERMINAL_STRING.test(text)
          ? 'credential'
          : reasonFor(text);
    if (reason !== undefined) this.withhold(reason);
    else this.held.push(line);
  }

  /** A binary file is read whole; a JSON document whole too, as values can span lines. */
  private checkWhole(): void {
    if (this.kind === 'binary') {
      const reason = reasonFor(
        Buffer.concat(this.held.chunks()).toString('utf8'),
      );
      if (reason !== undefined) this.withhold(reason);
      return;
    }
    if (!this.documentName) return;
    const text = Buffer.concat(this.held.chunks()).toString('utf8');
    if (parseJson(text) === NOT_JSON) return;
    const reason = reasonFor(text);
    if (reason !== undefined) this.withhold(reason);
  }

  private withhold(reason: WithheldReason, tooLarge = false): void {
    this.reason = reason;
    this.tooLarge = tooLarge;
    this.parts = [];
    this.held.clear();
    this.line = [];
  }
}

// A credential key word, matched from the word itself as the shared rules do.
const PLACEHOLDER_KEY = String.raw`api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|token|secret|password|passwd|pwd`;
// One reference path, such as secrets.DEPLOY_TOKEN or inputs.token: no
// operators, pipes, calls or literals.
const REFERENCE_PATH = String.raw`\s{0,8}[A-Za-z_][A-Za-z0-9_-]{0,127}(?:\.[A-Za-z_][A-Za-z0-9_-]{0,127}){0,8}\s{0,8}`;
// Placeholders that provably end: <...>, ${{ path }}, {{ path }} and ${NAME}.
const BRACKETED_PLACEHOLDER = [
  String.raw`<[^<>\r\n]{1,256}>`,
  String.raw`\$\{\{${REFERENCE_PATH}\}\}`,
  String.raw`\{\{${REFERENCE_PATH}\}\}`,
  String.raw`\$\{[A-Za-z_][A-Za-z0-9_]{0,127}\}`,
].join('|');
const BARE_PLACEHOLDER = String.raw`(?:\$|(?:process\.)?env\.)[A-Za-z0-9_]{1,128}`;
// Up to 8 of `, ; ) ] }` after a placeholder, ending at the end of the text
// or whitespace. After a quoted placeholder they may also end at the next
// quoted key, as in `{"token":"<x>","b":1}`. Anything else glued on after
// them is part of the value.
const CLOSING_RUN = String.raw`[,;)\]}]{1,8}`;
const NEXT_QUOTED_KEY = String.raw`\2(?<=["'])[^"'\r\n]{0,128}\2\s{0,8}:`;
// A key word starts its name: it follows the start of the text or
// whitespace, then at most 4 color codes and at most 4 of `" ' ` ( [ { , ; :`,
// then a flag dash. Text glued on before it, such as a token whose last
// characters spell a key word, a name prefix, or text and a color code, means
// no cut.
const KEY_START = `(?<=(?:^|\\s)(?:${ESC}\\[[0-?]{0,16}[ -/]{0,4}[@-~]){0,4}["'\`([{,;:]{0,4})(?:-{1,2})?`;
// A key, its separator, a color code, then a placeholder. A quoted
// placeholder fills the whole quoted value. A bracketed one may end at an
// escape, which the escapes-removed reading still reads through; a bare name
// must end at a hard boundary. One followed by = or : is the key of another
// assignment, not a placeholder.
const PLACEHOLDER_ASSIGNMENT = new RegExp(
  `${KEY_START}(${PLACEHOLDER_KEY})["']?\\s*(?:=|:)\\s*(?:${ESC}\\[[0-?]*[ -/]*[@-~])*(["']?)` +
    `(?:(${BRACKETED_PLACEHOLDER})\\2(?=$|[\\s${ESC}]|${CLOSING_RUN}(?:$|[\\s${ESC}]|${NEXT_QUOTED_KEY}))` +
    `|(${BARE_PLACEHOLDER})\\2(?=$|\\s|${CLOSING_RUN}(?:$|\\s|${NEXT_QUOTED_KEY})))(?!\\s*[=:])`,
  'gi',
);
// URL user-info or a basic-auth flag, as the shared url_credentials check
// reads them, with any password. A cut would change their shape.
const USER_INFO =
  /(?<=[A-Za-z0-9+.-]):\/\/[^\s/?#@:]*:[^\s/?#@]*@|(?:^|[\s"'`])(?:-u|--user)(?:[ \t]+|=)["']?[^\s"':]+:/;
// The whole words a bare name may end in: the last parts of the key list,
// plus PAT and CREDENTIAL(S) from the shared check's secret key names.
const CREDENTIAL_WORDS = new Set([
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PWD',
  'PAT',
  'CREDENTIAL',
  'CREDENTIALS',
]);
// UPPER_SNAKE with every segment at most 12 characters: a value glued onto a
// name makes a longer segment than any name part.
const PLACEHOLDER_NAME = /^[A-Z][A-Z0-9]{0,11}(?:_[A-Z0-9]{1,12})*$/;
const KEY_WITH_VALUE = new RegExp(
  `(?:${PLACEHOLDER_KEY})["']{0,2}\\s*[=:]\\s*["']{0,2}[^\\s"',;)\\]}]`,
  'i',
);
const VALUE_RUN = /[A-Za-z0-9+/=_.-]{8,}/g;
const LEFTOVER_NAME = /(?:\$|(?:process\.)?env\.)([A-Za-z0-9_]+)/g;

/** A run of 8 or more value characters holding a letter and a digit, or 8 digits. */
function valueLike(text: string): boolean {
  for (const [run] of text.matchAll(VALUE_RUN))
    if (/[0-9]{8}/.test(run) || (/[A-Za-z]/.test(run) && /[0-9]/.test(run)))
      return true;
  return false;
}

/**
 * What a placeholder's own text may not hold: an assignment or a quote, a
 * value, or another name.
 */
function placeholderHoldsValue(holder: string): boolean {
  if (/[=:'"`]/.test(holder) || valueLike(holder)) return true;
  for (const match of holder.matchAll(LEFTOVER_NAME))
    if (!credentialName(match[1] ?? '')) return true;
  return false;
}

function credentialName(name: string): boolean {
  if (!PLACEHOLDER_NAME.test(name)) return false;
  const parts = name.split('_');
  return CREDENTIAL_WORDS.has(parts[parts.length - 1] ?? '');
}

/** Replaces each placeholder assignment that provably ends (CAN-7630). */
function cutPlaceholders(text: string, replacement: string): string {
  return text.replace(
    PLACEHOLDER_ASSIGNMENT,
    (
      assignment: string,
      word: string,
      _quote: string,
      bracketed: string | undefined,
      bare: string | undefined,
      offset: number,
      whole: string,
    ) => {
      const holder = bracketed ?? bare ?? '';
      if (findSecretMaterialRule(holder) !== null) return assignment;
      if (holder.startsWith('<') && placeholderHoldsValue(holder.slice(1, -1)))
        return assignment;
      if (bare !== undefined) {
        // The full key: the identifier the key word ends, read back. A name
        // is at most 128 characters, so the walk stops there.
        let start = offset;
        while (
          start > 0 &&
          offset - start < 128 &&
          /[A-Za-z0-9_]/.test(whole.charAt(start - 1))
        )
          start -= 1;
        const key = `${whole.slice(start, offset)}${word}`;
        const name = bare.replace(/^\$|^(?:process\.)?env\./, '');
        if (name.toLowerCase() !== key.toLowerCase() && !credentialName(name))
          return assignment;
      }
      return replacement;
    },
  );
}

/**
 * Whether a reading the checks flag holds only placeholder assignments, such
 * as `token: <your token>` or `api_key: $API_KEY` (CAN-7630). Fails closed:
 * a line with URL user-info, a basic-auth flag or a secret signature keeps its
 * verdict, and what
 * is left once they are cut must hold no key with a value, no value-like run
 * and no other bare name.
 */
function onlyPlaceholders(text: string): boolean {
  if (USER_INFO.test(text)) return false;
  // A signature on the line as written keeps its verdict: a cut could take
  // a key word from the end of a token and leave it too short to match.
  const signature = findSecretMaterialRule(text);
  if (signature !== null && signature !== 'credential_assignment') return false;
  const neutralized = cutPlaceholders(text, 'placeholder=example');
  if (matchesCredentialRule(neutralized)) return false;
  const rest = cutPlaceholders(text, ' ');
  if (rest === text) return false;
  if (KEY_WITH_VALUE.test(rest) || valueLike(rest)) return false;
  for (const match of rest.matchAll(LEFTOVER_NAME))
    if (!credentialName(match[1] ?? '')) return false;
  return true;
}

/** One pass over the readings: the first that holds a key header or a credential. */
function reasonFor(text: string): WithheldReason | undefined {
  const checked = text.split(FIELD_WITHHELD_JSON).join('""');
  // A color code read as a space can hide text glued on before a key, which
  // shows once the escapes are removed: the placeholder exception must hold
  // on that reading too.
  let removedHolds: boolean | undefined;
  for (const reading of readings(checked)) {
    if (reading.tooDeep) return 'credential';
    const material = findSecretMaterialRule(reading.text);
    if (material === 'private_key') return 'private-key-block';
    if (
      material === null &&
      findSharedTextCredentialRule(reading.text) === null
    )
      continue;
    if (!onlyPlaceholders(reading.text)) return 'credential';
    if (removedHolds === undefined)
      removedHolds =
        !hasTerminalEscape(checked) ||
        onlyPlaceholders(escapeReadings(checked)[1] ?? checked);
    if (!removedHolds) return 'credential';
  }
  return undefined;
}

function createScrubber(
  mode: FeedbackScrubMode,
  path: string,
  emit: (bytes: Buffer) => void,
  tally: Tally,
): Scrubber {
  switch (mode) {
    case 'json-document':
      return new DocumentScrubber(emit, tally);
    case 'process-output':
      return new ProcessOutputScrubber(path, emit, tally);
    case 'worktrees-discovery':
      return new WorktreesDiscoveryScrubber(path, emit, tally);
    case 'log-entries':
    case 'jsonl-records':
      return new UnitScrubber(mode, emit, tally);
  }
}

type ScrubberFactory = typeof createScrubber;

/** A unit the output gate stops: it trips the checks after a mode wrote it. */
function unitTripsGate(bytes: Buffer): boolean {
  const text = bytes.toString('utf8');
  return holdsCredential(text) || opensKeyBlock(text);
}

/**
 * Every mode writes through one output gate: each unit a mode emits is held
 * and checked again, unless the mode already checked it, in which case it is
 * scanned whole for a key header instead. Where each unit meets the last, a
 * carried window is scanned too, so a header split across units or across
 * lines is found. If anything trips, the whole file is
 * withheld. The file is written only at its end, so a bundled file is held in
 * memory whole, in buffers of about 64 KiB.
 */
class FeedbackScrubStream extends Transform {
  private readonly scrubber: Scrubber;
  private readonly tally = new Tally();
  private readonly output = new HeldBytes();
  private gateTripped = false;
  // The end of the output so far, so a key header split across two units is
  // found where they meet, without joining the whole output.
  private tail = '';
  private headerInOutput = false;
  /** Account path segments replaced in each checked unit (CAN-6895). */
  private readonly redact: TextRedactor | undefined;

  constructor(
    mode: FeedbackScrubMode,
    private readonly context: FeedbackScrubContext,
    scrubberFor: ScrubberFactory = createScrubber,
  ) {
    super();
    const emit = (bytes: Buffer): void => {
      if (bytes.length === 0 || this.gateTripped) return;
      if (this.scrubber.checksEachUnit !== true && unitTripsGate(bytes)) {
        this.gateTripped = true;
        this.output.clear();
        return;
      }
      // A mode that checked each line itself never read its lines joined, so
      // its whole unit is read as text here, after the end of the last; the
      // mode parsed it already. Any other mode's whole unit was checked just
      // above, so only where it meets the last is read here.
      const whole = this.scrubber.checksEachUnit === true;
      const text = (
        whole ? bytes : bytes.subarray(0, HEADER_WINDOW_BYTES)
      ).toString('utf8');
      if (opensKeyBlock(`${this.tail}${text}`, !whole)) {
        this.gateTripped = true;
        this.headerInOutput = true;
        this.output.clear();
        return;
      }
      this.tail = (
        bytes.length > HEADER_WINDOW_BYTES
          ? bytes.subarray(-HEADER_WINDOW_BYTES).toString('utf8')
          : `${this.tail}${text}`
      ).slice(-HEADER_WINDOW_BYTES);
      // Redacted only after the checks above read the unit as written, so a
      // replaced account name never changes a verdict (CAN-6895).
      this.output.push(this.redacted(bytes));
    };
    this.redact =
      mode === 'log-entries'
        ? logEntryRedactor(context.redactPathUserNames)
        : undefined;
    this.scrubber = scrubberFor(mode, context.path, emit, this.tally);
  }

  /** The bytes with account SIDs and path segments replaced; unchanged when none match. */
  private redacted(bytes: Buffer): Buffer {
    if (this.redact === undefined) return bytes;
    const text = bytes.toString('utf8');
    const redacted = this.redact(text);
    return redacted === text ? bytes : Buffer.from(redacted, 'utf8');
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
    const reportedMode = this.scrubber.reportedMode;
    if (this.gateTripped) {
      this.tally.add(this.headerInOutput ? 'private-key-block' : 'credential');
      this.push(this.scrubber.stub?.() ?? gateStub(reportedMode));
    } else {
      for (const bytes of this.output.chunks()) this.push(bytes);
    }
    this.output.clear();
    const summary = this.tally.summary(reportedMode);
    if (summary !== undefined) this.context.report?.(summary);
    callback();
  }
}

/** What the output gate writes in place of a file: valid in the file's kind. */
function gateStub(mode: WithheldSummary['mode']): Buffer {
  switch (mode) {
    case 'jsonl-records':
    case 'json-document':
    case 'json-fields':
      return documentStub(false);
    case 'log-entries':
    case 'whole-file':
      return Buffer.from(FILE_WITHHELD, 'utf8');
  }
}

/**
 * A stream that copies a bundled file with its credential-shaped units
 * withheld and, for `log-entries`, account SIDs and (given names) account
 * path segments replaced.
 */
export function createFeedbackScrub(
  mode: FeedbackScrubMode,
  context: FeedbackScrubContext,
): Transform {
  return new FeedbackScrubStream(mode, context);
}

/** The output gate with a mode's scrubber replaced, for goldens that show every mode writes through it. */
export const feedbackScrubForTests = {
  createScrubber,
  createGatedScrub(
    mode: FeedbackScrubMode,
    context: FeedbackScrubContext,
    scrubberFor: ScrubberFactory,
  ): Transform {
    return new FeedbackScrubStream(mode, context, scrubberFor);
  },
};
