/** Bounded metadata only: never coerce, trim or truncate untrusted values. */
export function allowlistedErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 64 &&
    !/[\r\n\u2028\u2029]/.test(value) &&
    /^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/.test(value)
    ? value
    : undefined;
}

const ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'RangeError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
]);

/** Whether a value is one of the standard error names telemetry keeps. */
export function isStandardErrorName(value: unknown): value is string {
  return typeof value === 'string' && ERROR_NAMES.has(value);
}

export function allowlistedErrorName(value: unknown): string {
  return typeof value === 'string' && ERROR_NAMES.has(value) ? value : 'Error';
}

export type ProviderAuthFailureKind =
  | 'missing_cli'
  | 'timeout'
  | 'exit_nonzero'
  | 'invalid_output'
  | 'other';

export function parseProviderAuthFailureKind(
  value: unknown,
): ProviderAuthFailureKind | undefined {
  switch (value) {
    case 'missing_cli':
    case 'timeout':
    case 'exit_nonzero':
    case 'invalid_output':
    case 'other':
      return value;
    default:
      return undefined;
  }
}
