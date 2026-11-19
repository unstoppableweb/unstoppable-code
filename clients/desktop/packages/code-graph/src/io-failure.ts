// Closed classification of the filesystem and SQLite errors the code graph
// meets. Only a missing path (ENOENT, ENOTDIR) means "vanished"; every other
// error is a failure with a class from this closed set, never raw text.

export const CODE_GRAPH_FAILURE_CLASSES = [
  'permission-denied',
  'busy',
  'corrupt',
  'unsupported-schema',
  'no-space',
  'io',
  'internal',
] as const;

export type CodeGraphFailureClass = (typeof CODE_GRAPH_FAILURE_CLASSES)[number];

function field(error: unknown, name: string): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, name)
    : undefined;
}

const ERRNO_PATTERN = /^E[A-Z0-9]{1,15}$/;

/** Whether `value` has the shape of an errno code such as `EACCES`. */
function isErrnoCode(value: unknown): value is string {
  return typeof value === 'string' && ERRNO_PATTERN.test(value);
}

/** The error's errno code (`EACCES`, `EIO`, ...), never its message or path. */
export function errnoOf(error: unknown): string | undefined {
  const code = field(error, 'code');
  return isErrnoCode(code) ? code : undefined;
}

/** Only these mean the path is gone; anything else is not "vanished". */
export function isMissingPathError(error: unknown): boolean {
  const code = field(error, 'code');
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Resource exhaustion: the build fails and is retried, not counted per file. */
export function isResourceExhaustionError(error: unknown): boolean {
  const code = field(error, 'code');
  return code === 'EMFILE' || code === 'ENFILE' || code === 'ENOMEM';
}

export function classifyCodeGraphReadDatabaseError(
  error: unknown,
): 'permission-denied' | 'busy' | 'corrupt' | 'unsupported-schema' | 'io' {
  const code = field(error, 'code');
  const sqliteCode = field(error, 'errcode');
  const primary = typeof sqliteCode === 'number' ? sqliteCode & 255 : undefined;
  const message = error instanceof Error ? error.message.slice(0, 512) : '';
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    primary === 3 ||
    primary === 8 ||
    primary === 23
  )
    return 'permission-denied';
  if (
    primary === 5 ||
    primary === 6 ||
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    /database is (busy|locked)/i.test(message)
  )
    return 'busy';
  if (
    primary === 11 ||
    primary === 26 ||
    /not a database|database disk image is malformed/i.test(message)
  )
    return 'corrupt';
  if (
    primary === 1 ||
    primary === 17 ||
    /no such table|no such column|unsupported schema/i.test(message)
  )
    return 'unsupported-schema';
  return 'io';
}

/**
 * The failure class of any error. Filesystem and SQLite errors (an errno or
 * `SQLITE_*` code, or a numeric SQLite `errcode`) are classified; any other
 * error, including Node's own `ERR_*` codes, is the code graph's own failure,
 * `internal`.
 */
export function codeGraphFailureClass(error: unknown): CodeGraphFailureClass {
  if (error instanceof CodeGraphIoError) return error.failureClass;
  const code = field(error, 'code');
  const sqliteCode = field(error, 'errcode');
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'no-space';
  // SQLITE_FULL: the disk is full.
  if (typeof sqliteCode === 'number' && (sqliteCode & 255) === 13)
    return 'no-space';
  if (
    isErrnoCode(code) ||
    (typeof code === 'string' && code.startsWith('SQLITE_')) ||
    typeof sqliteCode === 'number'
  )
    return classifyCodeGraphReadDatabaseError(error);
  return 'internal';
}

/**
 * - `flush`: a flush before publication failed; nothing was switched.
 * - `durability-unverified`: the switch happened but its flush failed.
 * - `unreadable-graph`: an existing graph could not be read, so it was kept.
 */
export type CodeGraphIoErrorKind =
  | 'flush'
  | 'durability-unverified'
  | 'unreadable-graph';

/** A typed I/O failure: its class and errno, never a message or path. */
export class CodeGraphIoError extends Error {
  public constructor(
    public readonly kind: CodeGraphIoErrorKind,
    public readonly failureClass: CodeGraphFailureClass,
    public readonly code?: string,
  ) {
    super(`Code graph ${kind} failure (${code ?? failureClass}).`);
    this.name = 'CodeGraphIoError';
  }
}

/** Wraps `cause` as a {@link CodeGraphIoError} of `kind`, keeping its class. */
export function codeGraphIoError(
  kind: CodeGraphIoErrorKind,
  cause: unknown,
): CodeGraphIoError {
  return new CodeGraphIoError(
    kind,
    codeGraphFailureClass(cause),
    errnoOf(cause),
  );
}
