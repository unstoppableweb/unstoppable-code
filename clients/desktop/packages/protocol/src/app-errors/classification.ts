import type { AppErrorCode } from './catalog';
import type { AppErrorCopy } from './primitives';

const marker = Symbol.for('canopy.appErrorClassification');

type ClassificationOptions<Code extends AppErrorCode> = {
  source?: string;
} & (Code extends 'input.not_accepted'
  ? { copy?: AppErrorCopy }
  : { copy?: never }) &
  (Code extends 'external.rate_limited'
    ? { retryAt?: number }
    : { retryAt?: never });

export interface ErrorClassification {
  code: AppErrorCode;
  source?: string;
  retryAt?: number;
  copy?: AppErrorCopy;
}

/** Mark at the trusted source, without replacing or enumerably changing it. */
export function classifyError<ErrorValue, Code extends AppErrorCode>(
  error: ErrorValue,
  code: Code,
  options?: ClassificationOptions<Code>,
): ErrorValue {
  try {
    if (
      (typeof error === 'object' && error !== null) ||
      typeof error === 'function'
    ) {
      Object.defineProperty(error, marker, {
        value: { ...options, code },
        enumerable: false,
        configurable: true,
      });
    }
  } catch {
    // Frozen objects and hostile proxies still propagate unchanged.
  }
  return error;
}

/** Outermost usable marker wins; inspect the value and at most four causes.
 * Validation belongs to the consumer so this module never loads the catalog
 * or Zod into runtime-light protocol entrypoints. */
export function readErrorClassification(
  error: unknown,
  usable: (
    value: unknown,
  ) => value is ErrorClassification = usableClassification,
): ErrorClassification | undefined {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth <= 4; depth++) {
    if (
      (typeof current !== 'object' || current === null) &&
      typeof current !== 'function'
    )
      break;
    if (visited.has(current)) break;
    visited.add(current);
    try {
      const candidate: unknown = Reflect.get(current, marker);
      if (usable(candidate)) return candidate;
    } catch {
      // An unusable marker does not hide a usable cause.
    }
    try {
      current = Reflect.get(current, 'cause');
    } catch {
      break;
    }
  }
  return undefined;
}

// Exhaustive, type-checked code membership without loading the runtime catalog.
const classificationCodes: Record<AppErrorCode, true> = {
  'app.unexpected': true,
  'app.runtime_unreachable': true,
  'input.not_accepted': true,
  'external.offline': true,
  'external.service_unavailable': true,
  'external.rate_limited': true,
  'external.sign_in_required': true,
  'external.state_changed': true,
  'external.disk_full': true,
  'external.runtime_unreachable': true,
  'external.sync_paused': true,
};

function usableClassification(value: unknown): value is ErrorClassification {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('code' in value) ||
    typeof value.code !== 'string' ||
    !Object.prototype.hasOwnProperty.call(classificationCodes, value.code)
  )
    return false;
  if (
    'source' in value &&
    value.source !== undefined &&
    (typeof value.source !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.source))
  )
    return false;
  if (
    'retryAt' in value &&
    value.retryAt !== undefined &&
    (value.code !== 'external.rate_limited' ||
      typeof value.retryAt !== 'number' ||
      !Number.isFinite(value.retryAt) ||
      value.retryAt <= 0 ||
      value.retryAt > Number.MAX_SAFE_INTEGER)
  )
    return false;
  if ('copy' in value && value.copy !== undefined) {
    if (
      value.code !== 'input.not_accepted' ||
      typeof value.copy !== 'object' ||
      value.copy === null ||
      !('title' in value.copy) ||
      typeof value.copy.title !== 'string' ||
      value.copy.title.length < 1 ||
      value.copy.title.length > 256
    )
      return false;
    if (
      'description' in value.copy &&
      value.copy.description !== undefined &&
      (typeof value.copy.description !== 'string' ||
        value.copy.description.length < 1 ||
        value.copy.description.length > 1024)
    )
      return false;
  }
  return Object.keys(value).every((key): boolean =>
    ['code', 'source', 'retryAt', 'copy'].includes(key),
  );
}
