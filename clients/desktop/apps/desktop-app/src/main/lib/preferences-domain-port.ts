import type {
  PreferencesChange,
  PreferencesRepository,
  PreferencesUpdater,
} from '@canopy/core-runtime/node/preferences';
import type { StoredDomainPreferences } from '@canopy/desktop-shared/node/preferences/client-local-preferences';

/**
 * Who built a domain preferences patch (CAN-5722, slice E1).
 *
 * - `caller`: a patch a caller supplied (the renderer, Remote Control,
 *   `core.config.update`), already run through `applyPreferenceSaveRules`.
 *   It always takes the open path and is never classified.
 * - `internal`: a patch the app builds itself. Only these are classified with
 *   `classifyPreferenceWrite`.
 */
export type DomainPreferencesWriteRoute = 'caller' | 'internal';

export interface DomainPreferencesUpdateOptions {
  readonly route: DomainPreferencesWriteRoute;
}

type DomainPreferencesRepository =
  PreferencesRepository<StoredDomainPreferences>;

/**
 * Every domain preferences read and write in Electron main. The in-process
 * repository serves it today; a daemon-backed port is to replace it
 * (CAN-5722, slice E2) without changing callers.
 *
 * `update` contract, for every implementation:
 * - The updater may run more than once for one save (a remote port retries it
 *   on a newer document), so it must not keep state between runs: anything it
 *   records for after the save is reset at the start of each run.
 * - A `null` result writes nothing and needs no daemon round trip. A
 *   client-only save always reaches the port as `null`. An updater's own
 *   `null` can be a decision on `latest` (a revision conflict, a superseded
 *   intent), so the document it runs on must be current.
 * - An empty patch (`{}`) saves the document in process. The remote port
 *   treats it as a no-op that still resolves with `previous` equal to `next`,
 *   because `ConfigDocumentPatchSchema` refuses an empty patch; writers that
 *   return `{}` must not fail there.
 * - The patch may hold client-local keys; the port never writes them
 *   (`preserveStoredKeys`), and classification counts them.
 */
export interface DomainPreferencesPort extends Pick<
  DomainPreferencesRepository,
  | 'readStoredPayload'
  | 'read'
  | 'readAuthority'
  | 'hasPersistedState'
  | 'stampGeneration'
  | 'flush'
  | 'idle'
  | 'isRecoveryLatched'
  | 'peekLoadError'
  | 'acknowledgeLoadError'
  | 'migrationTimestamp'
  | 'resetForTests'
> {
  update(
    updater: PreferencesUpdater<StoredDomainPreferences>,
    onCommitted: ((committed: StoredDomainPreferences) => void) | undefined,
    options: DomainPreferencesUpdateOptions,
  ): Promise<PreferencesChange<StoredDomainPreferences>>;
}

/** The in-process port: the route is inert, as the repository has one writer. */
export function createInProcessDomainPreferences(
  repository: DomainPreferencesRepository,
): DomainPreferencesPort {
  return {
    readStoredPayload: () => repository.readStoredPayload(),
    read: (view) => repository.read(view),
    readAuthority: (options) => repository.readAuthority(options),
    hasPersistedState: () => repository.hasPersistedState(),
    update: (updater, onCommitted) => repository.update(updater, onCommitted),
    stampGeneration: (isStopped) => repository.stampGeneration(isStopped),
    flush: () => repository.flush(),
    idle: () => repository.idle(),
    isRecoveryLatched: () => repository.isRecoveryLatched(),
    peekLoadError: () => repository.peekLoadError(),
    acknowledgeLoadError: () => repository.acknowledgeLoadError(),
    migrationTimestamp: () => repository.migrationTimestamp(),
    resetForTests: () => repository.resetForTests(),
  };
}

/** The port main uses. Always in process until the daemon owns preferences (E2). */
export function selectDomainPreferences(
  repository: DomainPreferencesRepository,
): DomainPreferencesPort {
  return createInProcessDomainPreferences(repository);
}
