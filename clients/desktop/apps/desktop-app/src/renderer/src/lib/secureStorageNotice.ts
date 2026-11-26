import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';

export interface SecureStorageNoticeState {
  state: 'locked' | 'unavailable' | 'failed';
  title: string;
  description: string;
  retryable: boolean;
}

export function getSecureStorageNotice(
  failure: SecureStorageFailure,
): SecureStorageNoticeState;
export function getSecureStorageNotice(failure: null): null;
export function getSecureStorageNotice(
  failure: SecureStorageFailure | null,
): SecureStorageNoticeState | null;
export function getSecureStorageNotice(
  failure: SecureStorageFailure | null,
): SecureStorageNoticeState | null {
  if (!failure) return null;
  const outcome =
    failure.operation === 'read'
      ? "Couldn't read your saved sign-in. It hasn't been removed."
      : failure.operation === 'write'
        ? "Couldn't save your sign-in. Your saved sign-in hasn't been removed."
        : "Couldn't check secure storage. Your saved sign-in hasn't been removed.";
  const recovery = failure.retryable
    ? "Start or unlock your system's secure storage, then try again."
    : "Start or set up your system's secure storage, then reopen the app.";
  if (failure.state === 'locked') {
    return {
      state: 'locked',
      title: 'Secure storage is locked or temporarily unavailable.',
      description: `${outcome} ${recovery}`,
      retryable: failure.retryable,
    };
  }
  if (failure.state === 'unavailable') {
    return {
      state: 'unavailable',
      title: 'Secure storage is unavailable.',
      description: `${outcome} ${recovery}`,
      retryable: failure.retryable,
    };
  }
  return {
    state: 'failed',
    title: 'Couldn’t access secure storage.',
    description: `${outcome} ${failure.retryable ? 'Try again when secure storage is available.' : "Start or set up your system's secure storage, then reopen the app."}`,
    retryable: failure.retryable,
  };
}

/** Compatibility for older responses that expose only the availability flag. */
export function unavailableSecureStorageFailure(
  operation: SecureStorageFailure['operation'] = 'probe',
): SecureStorageFailure {
  return {
    version: 1,
    code: 'SECURE_STORAGE_PROBE_FAILED',
    operation,
    state: 'unavailable',
    backend: null,
    retryable: true,
  };
}

/** An operation failed without a fresh native availability observation. */
export function unknownSecureStorageFailure(
  operation: SecureStorageFailure['operation'],
): SecureStorageFailure {
  return {
    ...unavailableSecureStorageFailure(operation),
    state: 'unknown',
  };
}
