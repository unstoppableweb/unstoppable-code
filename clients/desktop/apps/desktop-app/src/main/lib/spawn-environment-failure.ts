import type {
  SpawnEnvironmentFailureCode,
  SpawnEnvironmentSource,
} from '../pipelines/config-paths';
import { getSecureStorageFailure } from './secure-storage-policy';

/** Stored spawn environment data that decrypted or parsed into the wrong shape. */
export class SpawnEnvironmentDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnEnvironmentDataError';
  }
}

/**
 * A stored spawn environment part could not be read. Carries only the
 * allowlisted code: no value, message, path or `cause` from the failure.
 */
export class SpawnEnvironmentReadError extends Error {
  readonly source: SpawnEnvironmentSource;
  readonly code: SpawnEnvironmentFailureCode;

  constructor(
    source: SpawnEnvironmentSource,
    code: SpawnEnvironmentFailureCode,
  ) {
    super(`Spawn environment ${source} unavailable (${code})`);
    this.name = 'SpawnEnvironmentReadError';
    this.source = source;
    this.code = code;
  }
}

/**
 * Map a spawn environment read failure to an allowlisted code. Reads only
 * validated secure-storage metadata and error types, never messages or errno
 * strings, which can echo decrypted data or paths.
 */
export function classifySpawnEnvironmentFailure(
  error: unknown,
): SpawnEnvironmentFailureCode {
  const failure = getSecureStorageFailure(error);
  if (failure) {
    switch (failure.code) {
      case 'SECURE_STORAGE_READ_UNAVAILABLE':
      case 'SECURE_STORAGE_PROBE_FAILED':
      case 'SECURE_STORAGE_DECRYPT_FAILED':
        return failure.code;
      default:
        return 'read_failed';
    }
  }
  if (
    error instanceof SyntaxError ||
    error instanceof SpawnEnvironmentDataError
  )
    return 'invalid_data';
  return 'read_failed';
}
