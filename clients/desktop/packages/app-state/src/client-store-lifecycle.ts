import type { StoreApi, UseBoundStore } from 'zustand';

/** Optional lifecycle hook owned by a provider-scoped store instance. */
export const CLIENT_STORE_ACTIVATE = Symbol('client-store-activate');
export const CLIENT_STORE_DISPOSE = Symbol('client-store-dispose');

export type ClientStore<TState> = UseBoundStore<StoreApi<TState>> & {
  [CLIENT_STORE_ACTIVATE]?: () => void;
  [CLIENT_STORE_DISPOSE]?: () => void;
};

/** Fixed sources only: never a chat id, path or message. */
export type StorePersistenceErrorIdentifier =
  | 'chat-settings-persist'
  | 'terminal-save';

/**
 * The host's recorder for persistence failures the stores swallow. This package
 * cannot import the host recorder, so hosts install one; the stores pass only
 * the caught value, which the recorder sanitizes.
 */
export type StorePersistenceErrorReporter = (
  identifier: StorePersistenceErrorIdentifier,
  error: unknown,
) => void;

const persistenceReporters: Array<{
  readonly report: StorePersistenceErrorReporter;
}> = [];

/**
 * Installs the host's recorder for the stores this package creates itself.
 * The returned uninstaller removes only its own registration, so a stale one
 * cannot remove a newer install, and the previous install applies again.
 */
export function setStorePersistenceErrorReporter(
  report: StorePersistenceErrorReporter,
): () => void {
  const own = { report };
  persistenceReporters.push(own);
  return (): void => {
    const index = persistenceReporters.indexOf(own);
    if (index >= 0) persistenceReporters.splice(index, 1);
  };
}

/** A cancelled request is not a failure to record. */
export function isPersistenceCancellation(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'AppCancellation';
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'type') === 'app_cancellation'
  );
}

/**
 * Reports one failed persist through the installed host recorder. A no-op
 * without one; a failing recorder never reaches the store.
 */
export function reportStorePersistenceError(
  identifier: StorePersistenceErrorIdentifier,
  error: unknown,
): void {
  try {
    persistenceReporters[persistenceReporters.length - 1]?.report(
      identifier,
      error,
    );
  } catch {
    // Recording is best effort and must not report its own failure.
  }
}
