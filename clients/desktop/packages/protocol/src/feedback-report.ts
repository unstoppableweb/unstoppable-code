import { z } from 'zod';
import type { AppError } from './app-errors';
import { displayableLabel, findSecretMaterialRule } from './capability-files';
import {
  CREDENTIAL_HEADER_NAMES,
  looksLikeSecret,
  redactSecrets,
} from './secret-redaction';
import { findSharedTextCredentialRule } from './shared-containers/capability-definitions';
import {
  AppErrorCopySchema,
  AppErrorDetailSchema,
  AppErrorIdentifierSchema,
  AppErrorKindSchema,
  AppErrorTimestampSchema,
} from './app-errors/primitives';

export const FEEDBACK_REPORT_TYPES = ['bug', 'idea'] as const;
export type FeedbackReportType = (typeof FEEDBACK_REPORT_TYPES)[number];
export const MAX_FEEDBACK_DESCRIPTION_LENGTH = 20_000;
export const MAX_FEEDBACK_TITLE_LENGTH = 200;
export const MAX_FEEDBACK_DETAIL_BYTES = 64 * 1024;
export const MAX_FEEDBACK_DETAIL_ENCODED_LENGTH = Math.ceil(
  (MAX_FEEDBACK_DETAIL_BYTES * 4) / 3,
);
export const MAX_FEEDBACK_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_FEEDBACK_ARCHIVE_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_FEEDBACK_ARCHIVE_ENTRIES = 5000;
export const MAX_FEEDBACK_ENTRY_PREVIEW_BYTES = 256 * 1024;

export const FeedbackReferenceIdSchema = z
  .string()
  .regex(/^(ERR|REP)-[0-9A-HJKMNP-TV-Z]{8}$/);
export const FeedbackSessionIdSchema = z.string().uuid();
export const FeedbackReportContextSchema = z
  .object({
    activePage: z.string().max(1024).optional(),
    workspaceId: z.string().max(1024).optional(),
    workspaceName: z.string().max(1024).optional(),
    worktreeId: z.string().max(1024).optional(),
    worktreeName: z.string().max(1024).optional(),
    chatProjectId: z.string().max(1024).optional(),
    chatId: z.string().max(1024).optional(),
    provider: z.string().max(1024).optional(),
    model: z.string().max(1024).optional(),
    appVersion: z.string().max(1024).optional(),
    platform: z.string().max(1024).optional(),
  })
  .strict();
export type FeedbackReportContext = z.infer<typeof FeedbackReportContextSchema>;
export type FeedbackContextSnapshot = FeedbackReportContext;

export const FeedbackReportErrorSchema = z
  .object({
    referenceId: z.string().regex(/^ERR-[0-9A-HJKMNP-TV-Z]{8}$/),
    // Accept future catalog codes from newer clients.
    code: AppErrorIdentifierSchema,
    kind: AppErrorKindSchema,
    occurredAt: AppErrorTimestampSchema,
    copy: AppErrorCopySchema,
    detail: AppErrorDetailSchema,
    // The boundary that recorded the error, for example `ipc:<channel>`.
    // Older hosts parse strictly, so clients send it only to hosts that
    // report the `errorSource` diagnostics capability.
    source: AppErrorIdentifierSchema.optional(),
  })
  .strict();
export type FeedbackReportError = z.infer<typeof FeedbackReportErrorSchema>;

/** SDK validation; hosted callers must additionally enforce an origin allowlist. */
export function validatedPostHogReplayUrl(
  value: unknown,
  sessionId: string,
): string | undefined {
  if (
    !FeedbackSessionIdSchema.safeParse(sessionId).success ||
    typeof value !== 'string' ||
    value.length > 2048
  )
    return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      new RegExp(`^/project/[a-z0-9_-]+/replay/${sessionId}/?$`, 'i').test(
        url.pathname,
      )
    )
      return url.href;
  } catch {
    /* Invalid SDK identities never interrupt capture. */
  }
  return undefined;
}

export const FeedbackReportTelemetrySchema = z
  .object({
    datadogSessionId: FeedbackSessionIdSchema.optional(),
    posthogSessionId: FeedbackSessionIdSchema.optional(),
    posthogReplayUrl: z.string().url().max(2048).optional(),
  })
  .strict();
export type FeedbackReportTelemetry = z.infer<
  typeof FeedbackReportTelemetrySchema
>;
export interface FeedbackReportDraft {
  context: FeedbackReportContext;
  telemetry?: FeedbackReportTelemetry;
  /** This host and account accept error attachments. Missing keeps feedback plain. */
  errorReports?: boolean;
  /**
   * What the executing host offers for this opening. `snapshot` is the exact
   * prepare/inspect/submit flow; `host-collected` is an older host that builds
   * its own archive at submission and cannot be previewed. Absent means none.
   */
  diagnostics?: 'snapshot' | 'host-collected';
}

export const FeedbackDiagnosticsSnapshotIdSchema = z.string().uuid();
export const FeedbackReportSubmissionSchema = z
  .object({
    type: z.enum(FEEDBACK_REPORT_TYPES),
    description: z.string().trim().min(1).max(MAX_FEEDBACK_DESCRIPTION_LENGTH),
    title: z.string().max(MAX_FEEDBACK_TITLE_LENGTH).optional(),
    context: FeedbackReportContextSchema,
    includeDiagnostics: z.boolean(),
    error: FeedbackReportErrorSchema.optional(),
    telemetry: FeedbackReportTelemetrySchema.optional(),
    diagnosticsSnapshotId: FeedbackDiagnosticsSnapshotIdSchema.optional(),
    // One key per intentional submission, retained across transport retries.
    submissionId: z.string().uuid().optional(),
  })
  .strict();
export type FeedbackReportSubmission = z.infer<
  typeof FeedbackReportSubmissionSchema
>;
export const FeedbackReportResultSchema = z.object({
  referenceId: FeedbackReferenceIdSchema.optional(),
  diagnosticsStatus: z
    .enum(['not-requested', 'pending', 'attached', 'unavailable'])
    .optional(),
});
export type FeedbackReportResult = z.infer<typeof FeedbackReportResultSchema>;

export interface FeedbackDiagnosticsSnapshot {
  id: string;
  preparedAt: string;
  expiresAt: string;
  sizeBytes: number;
  entries: { path: string; sizeBytes: number }[];
  skippedEntries: { path: string; reason: string }[];
  /** Exactly the final feedback.json entry in the prepared archive. */
  manifest: string;
}
export type FeedbackDiagnosticsEntryContent =
  | { kind: 'text'; text: string }
  | { kind: 'download-required'; reason: 'binary' | 'too-large' };
/** Hosted `code` for a report whose filing could not be confirmed. */
export const FEEDBACK_OUTCOME_UNKNOWN_CODE = 'feedback_outcome_unknown';
/** The host could not say whether the report was filed; retry the same intent. */
export class FeedbackOutcomeUnknownError extends Error {
  constructor(message = 'The report outcome is unknown.') {
    super(message);
    this.name = 'FeedbackOutcomeUnknownError';
  }
}
/** This intent already filed different text; the edit can't join that report. */
export class FeedbackSubmissionConflictError extends Error {
  constructor(message = 'This submission already filed different feedback.') {
    super(message);
    this.name = 'FeedbackSubmissionConflictError';
  }
}
/** The snapshot expired or its scope changed; only a new preview can continue. */
export class FeedbackDiagnosticsExpiredError extends Error {
  constructor(message = 'The diagnostics preview expired.') {
    super(message);
    this.name = 'FeedbackDiagnosticsExpiredError';
  }
}
export interface FeedbackReportClient {
  /** Host build policy. Missing fails closed; raw contents remain downloadable. */
  readonly diagnosticTextVisibility?: 'inline' | 'download-only';
  draft(): Promise<FeedbackReportDraft>;
  submit(request: FeedbackReportSubmission): Promise<FeedbackReportResult>;
  prepareDiagnostics?(request: {
    context: FeedbackReportContext;
    error?: FeedbackReportError;
  }): Promise<FeedbackDiagnosticsSnapshot>;
  readDiagnosticsEntry?(
    snapshotId: string,
    entryPath: string,
  ): Promise<FeedbackDiagnosticsEntryContent>;
  saveDiagnostics?(snapshotId: string): Promise<void>;
  releaseDiagnostics?(snapshotId: string): Promise<void>;
  /** Offline copy from an older host, which cannot save a prepared snapshot. */
  saveCollectedDiagnostics?(request: {
    context: FeedbackReportContext;
    description: string;
    error?: FeedbackReportError;
  }): Promise<{ filename: string }>;
}

const REDACTED_CREDENTIAL = '[redacted credential]';
// A Windows profile name may hold spaces or quotes: it ends only at a
// separator or line end. POSIX usernames can't hold spaces, so
// `redactSecrets` masks their homes.
const WINDOWS_HOME_PROFILE =
  /(?<![a-z0-9])[a-z]:(?:\\+|\/)(?:Users|Documents and Settings)(?:\\+|\/)[^/\\\r\n]*/gi;
// URL userinfo, a token alone (`https://<token>@host`) or `user:password`,
// runs to the authority's last `@`, as URL parsers read it. Anchored on `://`
// whatever the scheme, so each match attempt starts only there.
const URL_USERINFO = /:\/\/[^\s/?#\\]+@/g;
const MASKED_URL_USERINFO = '://<redacted>@';
// The credential_assignment detectors' keys plus private_key, with any `:` or
// `=` after them. Their value may start on the next line or inside quotes, so
// the detectors' value boundary cannot be trusted. No leading boundary: an
// escape written as text (`\npassword`) or a prefix (`db_password`,
// `newpassword`) still names a credential. A key quoted in JSON, also when
// escaped (`\"password\":`), counts.
const CREDENTIAL_KEY_ASSIGNMENT =
  /(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)(?:\\*["'])?\s*[:=]/i;
// Any mention of a credential header name the shared scrubber knows (plus the
// British `Authorisation`) withholds the field: a header serializes in too
// many shapes to find its value. No boundaries, and up to three non-alphanumeric
// characters between the name's words (`XApiKey`, `x_api_key`, `X\-Api\-Key`,
// `x - api - key`, a hyphen before a line break), so a prefix, quoting,
// escaping or separator around the name still matches.
const CREDENTIAL_HEADER_NAME = new RegExp(
  [...CREDENTIAL_HEADER_NAMES, 'Authorisation']
    .map((name) => name.split('-').join('[\\W_]{0,3}'))
    .join('|'),
  'i',
);
// A Set-Cookie value without its header name.
const SET_COOKIE_VALUE =
  /=[^\s;]+;\s*(?:(?:path|domain|expires|max-age|samesite)=|(?:httponly|secure)\s*(?:$|[;"',\]}]))/im;
const BASIC_CREDENTIAL = /\bbasic\s+([a-z0-9+/]{4,}={0,2})/gi;

// A Basic value without its header name: base64 of `user:password`.
function hasBasicCredential(text: string): boolean {
  for (const [, encoded] of text.matchAll(BASIC_CREDENTIAL)) {
    try {
      if (encoded !== undefined && atob(encoded).includes(':')) return true;
    } catch {
      // Not base64, so not a Basic credential.
    }
  }
  return false;
}

// JSON, JS, Python, HTML and URL escapes, and invisible format characters, can
// spell or split a name, so detection also reads the text with them decoded.
// The decoded text is never sent. Groups, in order: named entity, entity hex,
// entity decimal, `\U` (8 digits), `\u{}`, `\u`, `\x`, octal, one-letter
// escape, backslash before punctuation, `%u`, `%`.
const ESCAPE =
  /&([a-z]+);|&#x([0-9a-f]{1,6});?|&#(\d{1,7});?|\\U(00(?:0[0-9a-f]|10)[0-9a-f]{4})|\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\([0-3][0-7]{2}|[0-7]{1,2})|\\([bfnrtv])|\\([^\w\s])|%u([0-9a-f]{4})|%([0-9a-f]{2})/gi;
const ESCAPE_GROUPS = 12;
// The HTML entities that spell ASCII punctuation or whitespace.
const NAMED_ENTITY_CHARACTERS: Record<string, string> = {
  amp: '&',
  apos: "'",
  ast: '*',
  bsol: '\\',
  colon: ':',
  comma: ',',
  commat: '@',
  dollar: '$',
  equals: '=',
  excl: '!',
  grave: '`',
  gt: '>',
  hat: '^',
  lbrace: '{',
  lbrack: '[',
  lcub: '{',
  lowbar: '_',
  lpar: '(',
  lsqb: '[',
  lt: '<',
  midast: '*',
  nbsp: ' ',
  newline: '\n',
  num: '#',
  percnt: '%',
  period: '.',
  plus: '+',
  quest: '?',
  quot: '"',
  rbrace: '}',
  rbrack: ']',
  rcub: '}',
  rpar: ')',
  rsqb: ']',
  semi: ';',
  sol: '/',
  tab: '\t',
  underbar: '_',
  verbar: '|',
  vert: '|',
  verticalline: '|',
};
const ONE_LETTER_ESCAPES: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};
const FORMAT_CHARACTER = /\p{Cf}/gu;
// Terminal styling (`ESC[1;32m`) in script output glues its final letter to
// a token, hiding the token's start from every detector until it is removed.
const TERMINAL_CONTROL_SEQUENCE = new RegExp(
  `${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);

// What a decode round unwraps: every escape, or only the escapes wrapped around
// a URL (JSON, JS, Python, HTML, `%u`), keeping its own `%HH` encoding.
type Unwrap = 'all' | 'wrapping';

interface DecodeOptions {
  unwrap: Unwrap;
  /** Write decoded whitespace as a mark, so it cannot end a URL's userinfo. */
  markWhitespace: boolean;
}

const TEXT_DECODE: DecodeOptions = { unwrap: 'all', markWhitespace: false };
// Private use: never whitespace, never a URL delimiter.
const ESCAPED_WHITESPACE_MARK = '\uE000';
// The last ESCAPE group, `%HH`.
const URL_OWN_ESCAPE_GROUP = ESCAPE_GROUPS - 1;

function decodeEscape(groups: unknown[]): string | undefined {
  const [named, entityHex, entityDecimal, python, braced, unicode, byte] =
    groups;
  const [octal, letter, punctuation, percentUnicode, percent] = groups.slice(7);
  if (typeof named === 'string')
    return NAMED_ENTITY_CHARACTERS[named.toLowerCase()];
  if (typeof letter === 'string')
    return ONE_LETTER_ESCAPES[letter.toLowerCase()];
  if (typeof punctuation === 'string') return punctuation;
  const hex = [
    entityHex,
    python,
    braced,
    unicode,
    byte,
    percentUnicode,
    percent,
  ].find((value) => typeof value === 'string');
  const codePoint =
    typeof hex === 'string'
      ? Number.parseInt(hex, 16)
      : typeof octal === 'string'
        ? Number.parseInt(octal, 8)
        : typeof entityDecimal === 'string'
          ? Number.parseInt(entityDecimal, 10)
          : Number.NaN;
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : undefined;
}

function decodeEscapes(text: string, options: DecodeOptions): string {
  return text
    .replace(FORMAT_CHARACTER, '')
    .replace(TERMINAL_CONTROL_SEQUENCE, '')
    .replace(ESCAPE, (escape, ...captures: unknown[]) => {
      const groups = captures.slice(0, ESCAPE_GROUPS);
      if (
        options.unwrap === 'wrapping' &&
        typeof groups[URL_OWN_ESCAPE_GROUP] === 'string'
      )
        return escape;
      const decoded = decodeEscape(groups);
      if (decoded === undefined) return escape;
      return options.markWhitespace && /\s/.test(decoded)
        ? ESCAPED_WHITESPACE_MARK
        : decoded;
    });
}

// Every decode round shortens the text, so it settles. Text still changing
// after this many rounds is nested on purpose and is withheld.
const MAX_DECODE_ROUNDS = 8;

/**
 * The text as written, then each decoded reading until stable (`&amp;quot;`,
 * `%2522`, `\\u0040`), or null when it never settles.
 */
function detectionViews(text: string): string[] | null {
  const views = [text];
  let current = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    const decoded = decodeEscapes(current, TEXT_DECODE);
    if (decoded === current) return views;
    views.push(decoded);
    current = decoded;
  }
  return null;
}

/** Whether any reading of the text trips `detect`; unsettled text always does. */
function anyReading(text: string, detect: (view: string) => boolean): boolean {
  const views = detectionViews(text);
  return views === null || views.some(detect);
}

const URL_DECODES: DecodeOptions[] = [
  { unwrap: 'all', markWhitespace: true },
  { unwrap: 'wrapping', markWhitespace: true },
];
// Readings grow with nesting depth. Realistic text has a handful; more is
// nested on purpose and is withheld.
const MAX_URL_READINGS = 32;

/**
 * Every reading reached by decoding all escapes or only the wrapping ones, in
 * any order: `https:\/\/tok%2Fx@host` shows its userinfo only once the JSON
 * escapes are decoded and its own `%2F` is not. Null when there are too many.
 */
function urlReadings(text: string): string[] | null {
  const readings = new Set([text]);
  const pending = [text];
  for (
    let reading = pending.pop();
    reading !== undefined;
    reading = pending.pop()
  ) {
    for (const options of URL_DECODES) {
      const decoded = decodeEscapes(reading, options);
      if (readings.has(decoded)) continue;
      if (readings.size === MAX_URL_READINGS) return null;
      readings.add(decoded);
      pending.push(decoded);
    }
  }
  return [...readings];
}

function hasCredentialHeaderName(text: string): boolean {
  return CREDENTIAL_HEADER_NAME.test(text);
}

// Userinfo other than the mask in some reading: what the in-place scrub could
// not reach, because an escape spells the URL's `://`, its `@`, or whitespace
// inside it.
function hasUnmaskedUserinfo(text: string): boolean {
  const readings = urlReadings(text);
  if (readings === null) return true;
  return readings.some((reading) =>
    [...reading.matchAll(URL_USERINFO)].some(
      ([userinfo]) => userinfo !== MASKED_URL_USERINFO,
    ),
  );
}

/**
 * The bar is the home username and credentials, nothing else: other path text
 * stays for debugging. A field in which any decoded reading shows a
 * credential is withheld whole, since no boundary inside it can be trusted.
 * Only plain URL userinfo, read as written, is masked in place.
 */
function redactFeedbackText(text: string): string {
  return anyReading(text, hasCredentialHeaderName)
    ? REDACTED_CREDENTIAL
    : redactCredentialShapes(text);
}

// An identifier class name (`ChatSendAuthorizationRevokedError`) has no room
// for a header value, so the header-name rule spares it and the class is kept.
const CLASS_IDENTIFIER = /^[a-z_$][\w$]*$/i;

function redactFeedbackClass(name: string): string {
  return CLASS_IDENTIFIER.test(name)
    ? redactCredentialShapes(name)
    : redactFeedbackText(name);
}

function hasCredentialShape(text: string): boolean {
  return (
    CREDENTIAL_KEY_ASSIGNMENT.test(text) ||
    SET_COOKIE_VALUE.test(text) ||
    hasBasicCredential(text) ||
    findSharedTextCredentialRule(text) !== null ||
    findSecretMaterialRule(text) !== null ||
    looksLikeSecret(text)
  );
}

function redactCredentialShapes(text: string): string {
  if (anyReading(text, hasCredentialShape)) return REDACTED_CREDENTIAL;
  const scrubbed = text
    .replace(WINDOWS_HOME_PROFILE, '<user-home>')
    .replace(URL_USERINFO, MASKED_URL_USERINFO);
  if (hasUnmaskedUserinfo(scrubbed)) return REDACTED_CREDENTIAL;
  return displayableLabel(
    redactSecrets(scrubbed),
    REDACTED_CREDENTIAL,
    findSharedTextCredentialRule,
  );
}

const utf8 = new TextEncoder();

function wireDetail(
  detail: FeedbackReportError['detail'],
): FeedbackReportError['detail'] {
  const wire = { ...detail };
  // Older web deployments decode with a strict schema that predates `errno`.
  delete wire.errno;
  return wire;
}

function fitsWire(detail: FeedbackReportError['detail']): boolean {
  return (
    utf8.encode(JSON.stringify(wireDetail(detail))).byteLength <=
    MAX_FEEDBACK_DETAIL_BYTES
  );
}

/**
 * The schema caps characters, the wire caps UTF-8 bytes after JSON escaping.
 * Only the stack can cross the byte cap, so it is cut first and the class,
 * code and message always fit.
 */
function fitDetailToWire(
  detail: FeedbackReportError['detail'],
): FeedbackReportError['detail'] {
  const { stack } = detail;
  if (stack === undefined || fitsWire(detail)) return detail;
  const fitsWith = (length: number): boolean =>
    fitsWire({ ...detail, stack: stack.slice(0, length) });
  // Escaping is not monotonic across a split surrogate pair, so keep only a
  // length that was measured to fit.
  let fitting = 0;
  let over = stack.length;
  while (over - fitting > 1) {
    const middle = Math.floor((fitting + over) / 2);
    if (fitsWith(middle)) fitting = middle;
    else over = middle;
  }
  const lastCode = stack.charCodeAt(fitting - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) fitting -= 1;
  const fitted = { ...detail };
  if (fitting > 0 && fitsWith(fitting)) fitted.stack = stack.slice(0, fitting);
  else delete fitted.stack;
  return fitted;
}

const MAX_DETAIL_MESSAGE_LENGTH = 4096;

// A cut can strand the low half of a surrogate pair at the start.
function messageEnd(message: string): string {
  const end = message.slice(-MAX_DETAIL_MESSAGE_LENGTH);
  const first = end.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? end.slice(1) : end;
}

export interface FeedbackReportErrorOptions {
  /**
   * Keep the end of a long message instead of its start, for a failure whose
   * cause follows a long list. The whole message is redacted before the cut,
   * so a cut can never split a credential away from what marks it.
   */
  keepMessageEnd?: boolean;
}

export function toFeedbackReportError(
  error: AppError,
  options: FeedbackReportErrorOptions = {},
): FeedbackReportError {
  const { referenceId, code, kind, occurredAt, copy, detail, source } = error;
  const message = redactFeedbackText(detail.message);
  // Redaction can expand short values. Keep the existing copy/detail schema
  // limits after scrubbing, including on the explicit Report this path.
  const report = FeedbackReportErrorSchema.parse({
    referenceId,
    code,
    kind,
    occurredAt,
    copy: {
      title: redactFeedbackText(copy.title).slice(0, 256),
      ...(copy.description === undefined
        ? {}
        : {
            description: redactFeedbackText(copy.description).slice(0, 1024),
          }),
    },
    detail: fitDetailToWire({
      ...detail,
      message: options.keepMessageEnd
        ? messageEnd(message)
        : message.slice(0, MAX_DETAIL_MESSAGE_LENGTH),
      ...(detail.name === undefined
        ? {}
        : { name: redactFeedbackClass(detail.name).slice(0, 128) }),
      ...(detail.stack === undefined
        ? {}
        : { stack: redactFeedbackText(detail.stack).slice(0, 32768) }),
      ...(typeof detail.status === 'string'
        ? { status: redactFeedbackText(detail.status).slice(0, 128) }
        : {}),
    }),
  });
  // A malformed source is dropped; it must never fail the report.
  if (
    source === undefined ||
    !AppErrorIdentifierSchema.safeParse(source).success
  )
    return report;
  return { ...report, source };
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function encodeFeedbackErrorDetail(
  detail: FeedbackReportError['detail'],
): string {
  // An error built by an older client may predate the byte budget.
  const bytes = utf8.encode(
    JSON.stringify(
      wireDetail(fitDetailToWire(AppErrorDetailSchema.parse(detail))),
    ),
  );
  if (bytes.byteLength > MAX_FEEDBACK_DETAIL_BYTES)
    throw new Error('Error detail exceeds the report size limit.');
  return encodeBytes(bytes);
}

export function decodeFeedbackErrorDetail(
  encoded: string,
): FeedbackReportError['detail'] {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_FEEDBACK_DETAIL_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    encoded.length % 4 === 1
  )
    throw new Error('Invalid encoded error detail.');
  const decodedLength = Math.floor((encoded.length * 3) / 4);
  if (decodedLength > MAX_FEEDBACK_DETAIL_BYTES)
    throw new Error('Error detail exceeds the report size limit.');
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBytes(bytes) !== encoded)
    throw new Error('Invalid encoded error detail.');
  return AppErrorDetailSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
}

const EncodedDetailSchema = z
  .string()
  .max(MAX_FEEDBACK_DETAIL_ENCODED_LENGTH)
  .transform((value, ctx) => {
    try {
      return decodeFeedbackErrorDetail(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid or oversized encoded error detail.',
      });
      return z.NEVER;
    }
  });
export const FeedbackReportErrorWireSchema = FeedbackReportErrorSchema.omit({
  detail: true,
})
  .extend({ detailBase64Url: EncodedDetailSchema })
  .transform(({ detailBase64Url, ...error }) => ({
    ...error,
    detail: detailBase64Url,
  }));
export type FeedbackReportErrorWire = z.input<
  typeof FeedbackReportErrorWireSchema
>;
export function encodeFeedbackReportError(
  error: FeedbackReportError,
): FeedbackReportErrorWire {
  const { detail, ...identity } = FeedbackReportErrorSchema.parse(error);
  return { ...identity, detailBase64Url: encodeFeedbackErrorDetail(detail) };
}
