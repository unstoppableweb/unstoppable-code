import {
  classifyError,
  validRetryAt,
} from '@canopy/protocol/app-errors/classification';
import type { AppErrorCode } from '@canopy/protocol/app-errors';

function property(value: unknown, key: string): unknown {
  try {
    return typeof value === 'object' && value !== null
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Require actual system diagnostics, not an arbitrary product `code`. */
export function systemAppErrorCode(value: unknown): AppErrorCode | undefined {
  try {
    if (
      !(value instanceof Error) ||
      property(value, 'name') === 'AbortError' ||
      property(value, 'code') === 'ABORT_ERR'
    )
      return undefined;
    const code = property(value, 'code');
    if (
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      code === 'UND_ERR_SOCKET'
    )
      return 'external.service_unavailable';
    if (
      typeof property(value, 'syscall') !== 'string' &&
      typeof property(value, 'errno') !== 'number'
    )
      return undefined;
    switch (code) {
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
      case 'ENETDOWN':
      case 'ENETUNREACH':
        return 'external.offline';
      case 'ECONNREFUSED':
      case 'ECONNRESET':
      case 'ETIMEDOUT':
        return 'external.service_unavailable';
      case 'ENOSPC':
      case 'EDQUOT':
        return 'external.disk_full';
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Traverse only bounded causes; preserve the original object and all fields. */
export function classifySystemError<Value>(error: Value): Value {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let classification: AppErrorCode | undefined;
  for (let depth = 0; depth <= 4 && !seen.has(current); depth++) {
    seen.add(current);
    if (
      property(current, 'name') === 'AbortError' ||
      property(current, 'code') === 'ABORT_ERR'
    )
      return error;
    const code = systemAppErrorCode(current);
    classification ??= code;
    current = property(current, 'cause');
    if (current === undefined) break;
  }
  return classification ? classifyError(error, classification) : error;
}

export { validRetryAt };

export function retryAtFromDelay(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? validRetryAt(Date.now() + value)
    : undefined;
}

/** Called only around an actual fetch; ordinary TypeErrors stay defects. */
export function classifyFetchFailure<Value>(
  failure: unknown,
  error: Value,
): Value {
  try {
    const seen = new Set<unknown>();
    let current: unknown = failure;
    let classification: AppErrorCode | undefined;
    for (let depth = 0; depth <= 4 && !seen.has(current); depth++) {
      seen.add(current);
      // A wrapped cancellation still wins over transport evidence and the
      // fetch TypeError fallback, just as in classifySystemError.
      if (
        property(current, 'name') === 'AbortError' ||
        property(current, 'code') === 'ABORT_ERR'
      )
        return error;
      classification ??=
        property(current, 'name') === 'TimeoutError'
          ? 'external.service_unavailable'
          : systemAppErrorCode(current);
      current = property(current, 'cause');
      if (current === undefined) break;
    }
    if (classification) return classifyError(error, classification);
    if (
      failure instanceof TypeError &&
      /^(?:fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.?)$/.test(
        failure.message,
      )
    )
      return classifyError(error, 'external.offline');
  } catch {
    /* Unusable evidence is not an external classification. */
  }
  return error;
}
