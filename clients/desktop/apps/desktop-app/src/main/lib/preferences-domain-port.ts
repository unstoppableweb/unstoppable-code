import {
  storedClientLocalValues,
  type PreferencesChange,
  type PreferencesRepository,
  type PreferencesUpdater,
} from '@canopy/core-runtime/node/preferences';
import type { StoredDomainPreferences } from '@canopy/desktop-shared/node/preferences/client-local-preferences';
import type { LegacyClientLocalRead } from './client-preferences-store';

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
  /**
   * Whether the updater's last `null` stood for a client-only save, which a
   * remote port answers without a round trip. Any other `null` is the
   * updater's decision on the document it ran on.
   */
  readonly isClientOnly?: () => boolean;
}

/**
 * A port's answer to one save. `unread`: `previous` and `next` are the
 * codec's defaults standing in for a document the port has not read (see
 * `PreferencesPort`), never stored preferences.
 */
export interface PortPreferencesChange<T> extends PreferencesChange<T> {
  readonly unread?: true;
}

/** See `readStoredProductAnalyticsChoice` in the preference store. */
export type StoredProductAnalyticsChoice =
  | 'allowed'
  | 'denied'
  | 'unconfirmed'
  | 'denial-journal-unreadable';

type RepositoryMembers =
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
  | 'resetForTests';

/**
 * A preferences document as Electron main reads and writes it. The
 * in-process repository serves the domain document today; the daemon client
 * (`canopy-runtime/preferences-daemon-client.ts`, CAN-5722 slice E2) is to
 * replace it without changing callers.
 *
 * `update` contract, for every implementation:
 * - The updater may run more than once for one save (a remote port retries it
 *   on a newer document), so it must not keep state between runs: anything it
 *   records for after the save is reset at the start of each run.
 * - A `null` result writes nothing. A client-only save reaches the port as
 *   `null` with `isClientOnly` true and needs no daemon round trip. An
 *   updater's own `null` can be a decision on `latest` (a revision conflict,
 *   a superseded intent), so the document it runs on must be current.
 * - An empty patch (`{}`) saves the document in process. The remote port
 *   treats it as a no-op that still resolves with `previous` equal to `next`,
 *   because `ConfigDocumentPatchSchema` refuses an empty patch; writers that
 *   return `{}` must not fail there.
 * - The patch may hold client-local keys; the port never writes them
 *   (`preserveStoredKeys`).
 * - A remote port with nothing cached yet answers a client-only save from a
 *   run on the codec's defaults, which then stand in as `previous` and
 *   `next`, and marks that change `unread`. `isRecoveryLatched` stays true,
 *   but a read may land before the caller looks, so only `unread` says
 *   which save's domain part is the stand-in.
 */
export interface PreferencesPort<T extends object> extends Pick<
  PreferencesRepository<T>,
  RepositoryMembers
> {
  update(
    updater: PreferencesUpdater<T>,
    onCommitted: ((committed: T) => void) | undefined,
    options: DomainPreferencesUpdateOptions,
  ): Promise<PortPreferencesChange<T>>;
  /**
   * The client-local values the document keeps a frozen copy of, by its own
   * recovery verdict: the seed source of `client-preferences.json`.
   */
  readLegacyClientLocal(): Promise<LegacyClientLocalRead>;
  /** The stored Usage analytics choice, and whether a read proved it. */
  readStoredProductAnalyticsChoice(): Promise<StoredProductAnalyticsChoice>;
}

/** Every domain preferences read and write in Electron main. */
export type DomainPreferencesPort = PreferencesPort<StoredDomainPreferences>;

type DomainPreferencesRepository =
  PreferencesRepository<StoredDomainPreferences>;

export interface InProcessDomainPreferencesSources {
  /** Observes the in-process document while it reads; only a local read can. */
  readonly readStoredProductAnalyticsChoice: () => Promise<StoredProductAnalyticsChoice>;
}

/** The in-process port: the route is inert, as the repository has one writer. */
export function createInProcessDomainPreferences(
  repository: DomainPreferencesRepository,
  sources: InProcessDomainPreferencesSources,
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
    // The domain's own recovery verdict, never a bypass of it.
    readLegacyClientLocal: async () => {
      const stored = await repository.read('persisted');
      if (repository.isRecoveryLatched())
        return { kind: 'pending', served: storedClientLocalValues(stored) };
      if (!(await repository.hasPersistedState())) return { kind: 'missing' };
      return { kind: 'read', values: storedClientLocalValues(stored) };
    },
    readStoredProductAnalyticsChoice: () =>
      sources.readStoredProductAnalyticsChoice(),
  };
}

export interface DomainPreferencesSelection {
  /**
   * The daemon-backed port (`createDaemonDomainPreferences` in the
   * preference store, over `createDaemonPreferencesRoute`). Main passes none
   * until the daemon owns preferences (the CAN-5722 flip).
   */
  readonly daemon?: DomainPreferencesPort;
}

/** The port main uses: the daemon client when selected, else in process. */
export function selectDomainPreferences(
  repository: DomainPreferencesRepository,
  sources: InProcessDomainPreferencesSources,
  selection: DomainPreferencesSelection = {},
): DomainPreferencesPort {
  return (
    selection.daemon ?? createInProcessDomainPreferences(repository, sources)
  );
}
