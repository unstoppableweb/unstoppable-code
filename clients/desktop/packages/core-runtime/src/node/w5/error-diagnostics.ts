/** Bounded local inspection; only these scalar identifiers may leave an error. */
export interface W5ErrorDiagnostics {
  errorName?: string;
  errorCode?: string;
  sqliteErrcode?: number;
}

const NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'SystemError',
  'AbortError',
  'UnknownError',
  'SqliteError',
  'SQLiteError',
  'W5CommitLogError',
  'W5BackupRefusedError',
  'W5DaemonHandoffError',
  'W5MaintenanceRefusedError',
  'W5MaintenanceDecisionError',
  'WorkspaceConfigUnreadableError',
  'CanopyClientError',
]);
const FILE_CODES = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EIO',
  'ENOSPC',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EBUSY',
  'ELOOP',
  'EINVAL',
  'ENAMETOOLONG',
  'ESTALE',
  'ENODEV',
  'ENXIO',
  'ETIMEDOUT',
  'ECANCELED',
]);
const SQLITE_CODES = new Set(
  [
    'ERROR',
    'INTERNAL',
    'PERM',
    'ABORT',
    'BUSY',
    'LOCKED',
    'NOMEM',
    'READONLY',
    'INTERRUPT',
    'IOERR',
    'CORRUPT',
    'NOTFOUND',
    'FULL',
    'CANTOPEN',
    'PROTOCOL',
    'EMPTY',
    'SCHEMA',
    'TOOBIG',
    'CONSTRAINT',
    'MISMATCH',
    'MISUSE',
    'NOLFS',
    'AUTH',
    'FORMAT',
    'RANGE',
    'NOTADB',
    'NOTICE',
    'WARNING',
  ].map((code): string => `SQLITE_${code}`),
);
const SQLITE_NUMBERS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27, 28, 100, 101,
]);

export function isW5ErrorName(value: unknown): value is string {
  return typeof value === 'string' && NAMES.has(value);
}
export function isW5FilesystemCode(value: unknown): value is string {
  return typeof value === 'string' && FILE_CODES.has(value);
}
export function isW5ErrorCode(value: unknown): value is string {
  return (
    isW5FilesystemCode(value) ||
    (typeof value === 'string' &&
      (value === 'ERR_SQLITE_ERROR' || SQLITE_CODES.has(value)))
  );
}
export function isW5SqliteErrcode(value: unknown): value is number {
  return typeof value === 'number' && SQLITE_NUMBERS.has(value);
}

/** A hostile proxy/getter must not replace the failure being diagnosed. */
function field(value: unknown, key: string): unknown {
  try {
    return (typeof value === 'object' && value !== null) ||
      typeof value === 'function'
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Revalidate projected fields without copying arbitrary keys. */
export function sanitizeW5Diagnostics(value: unknown): W5ErrorDiagnostics {
  const name = field(value, 'errorName');
  const code = field(value, 'errorCode');
  const number = field(value, 'sqliteErrcode');
  return {
    ...(isW5ErrorName(name) ? { errorName: name } : {}),
    ...(isW5ErrorCode(code) ? { errorCode: code } : {}),
    ...(isW5SqliteErrcode(number) ? { sqliteErrcode: number } : {}),
  };
}

/** Root depth zero; DFS cause/underlying/failure; first node wins depth ties. */
export function w5ErrorDiagnostics(error: unknown): W5ErrorDiagnostics {
  const seen = new Set<object>();
  let best: W5ErrorDiagnostics = {};
  let bestDepth = -1;
  const visit = (value: unknown, depth: number): void => {
    if (
      depth > 8 ||
      seen.size >= 32 ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      value === null ||
      seen.has(value)
    )
      return;
    seen.add(value);
    const own = sanitizeW5Diagnostics({
      errorName: field(value, 'name'),
      errorCode: field(value, 'code'),
      sqliteErrcode: field(value, 'errcode'),
    });
    if (
      depth > bestDepth &&
      (own.errorName !== undefined ||
        own.errorCode !== undefined ||
        own.sqliteErrcode !== undefined)
    ) {
      best = own;
      bestDepth = depth;
    }
    if (depth === 8) return;
    for (const key of ['cause', 'underlying', 'failure']) {
      if (seen.size >= 32) break;
      visit(field(value, key), depth + 1);
    }
  };
  visit(error, 0);
  return best;
}

/** Local warnings and recovery records deliberately omit numeric SQLite codes. */
export function w5FailureDiagnostics(
  error: unknown,
): Pick<W5ErrorDiagnostics, 'errorName' | 'errorCode'> {
  const { errorName, errorCode } = w5ErrorDiagnostics(error);
  return {
    ...(errorName !== undefined && { errorName }),
    ...(errorCode !== undefined && { errorCode }),
  };
}

export interface W5UnderlyingDiagnostics {
  underlyingName?: string;
  underlyingCode?: string;
  underlyingErrcode?: number;
}
export function w5UnderlyingDiagnostics(
  error: unknown,
): W5UnderlyingDiagnostics {
  const { errorName, errorCode, sqliteErrcode } = w5ErrorDiagnostics(error);
  return {
    ...(errorName !== undefined && { underlyingName: errorName }),
    ...(errorCode !== undefined && { underlyingCode: errorCode }),
    ...(sqliteErrcode !== undefined && { underlyingErrcode: sqliteErrcode }),
  };
}
export function w5UnderlyingFromDiagnostics(
  value: unknown,
): { name?: string; code?: string; errcode?: number } | undefined {
  const name = field(value, 'underlyingName'),
    code = field(value, 'underlyingCode'),
    errcode = field(value, 'underlyingErrcode');
  const result = {
    ...(isW5ErrorName(name) && { name }),
    ...(isW5ErrorCode(code) && { code }),
    ...(isW5SqliteErrcode(errcode) && { errcode }),
  };
  return result.name !== undefined ||
    result.code !== undefined ||
    result.errcode !== undefined
    ? result
    : undefined;
}
