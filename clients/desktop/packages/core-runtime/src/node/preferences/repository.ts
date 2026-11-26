import { randomUUID } from 'node:crypto';
import { isRecord } from '../w5/commit-log/is-record';
import { isStorageOutcomeUnknownError } from '../../storage';
import { StorageRowOwnerError } from '../../storage/owner-records';
import {
  type PreferencesDocument,
  type PreferencesLog,
  getErrorMessage,
  getErrorCode,
  isMissingDocumentError,
} from './document';
import type {
  PreferencesCodec,
  PreferencesReadView,
  PreferencesLoadError,
  PreferencesLoadErrorReason,
} from './codec';
import { PreferencesRecoveryRequiredError } from './errors';
import { createLastGoodRefresher } from './last-good-refresh';
import {
  PREFERENCES_ENVELOPE_WRITE_VERSION,
  isReadablePreferencesEnvelopeVersion,
  readPreferencesEnvelopeRecord,
} from '@canopy/protocol/preferences';
import {
  documentGeneration,
  readPreferencesGeneration,
  writePreferencesGeneration,
  nextPreferencesGeneration,
} from './generation';

export interface PreferencesChange<T> {
  readonly previous: T;
  readonly next: T;
}
export type PreferencesUpdater<T> = (
  latest: T,
) => Partial<T> | null | Promise<Partial<T> | null>;
export interface PreferencesAuthorityRead<T> {
  preferences: T;
  authority: 'ok' | 'absent' | 'unreadable';
  served?: T;
}
export type PreferencesGenerationStamp =
  | 'stamped'
  | 'present'
  | 'fresh'
  | 'degraded'
  | 'refused'
  | 'failed'
  | 'stopped';

export interface PreferencesRepositoryHooks<T> {
  /** Host durability prerequisites, before folder or generation bookkeeping. */
  beforeSave?(
    change: PreferencesChange<T>,
    document: PreferencesDocument,
  ): Promise<void>;
  /** Recovery failed and latched; after the latch and load error are set. */
  onRecoveryLatched?(details: PreferencesLoadError): void;
  /** Recovery restored last-good over the primary; before the load error is set. */
  onRecovered?(restored: T): void;
  /** Called synchronously when a save starts (its record write is in flight); returns a promise settling with `save`. */
  trackSave?(save: Promise<void>, change: PreferencesChange<T>): Promise<void>;
  /** Inside the save, when main's install has an unknown outcome, before the save rejects. */
  onSaveOutcomeUnknown?(change: PreferencesChange<T>): void;
  /** Inside the save, after main is durable, before the save resolves. */
  onSaveDurable?(change: PreferencesChange<T>): void;
  /** In the queue after the save, before the last-good refresh is scheduled. */
  afterSave?(change: PreferencesChange<T>): Promise<void>;
  /** In the queue after the refresh is scheduled, before the caller's observer. */
  onCommitted?(committed: T): void;
}

export interface PreferencesRepositoryOptions<T extends object> {
  /** Resolved at the start of every operation: the injected root. */
  readonly document: () => PreferencesDocument;
  readonly codec: PreferencesCodec<T>;
  readonly hooks?: PreferencesRepositoryHooks<T>;
  readonly log: PreferencesLog;
}

export type StoredPreferencesPayloadRead =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | {
      kind: 'read';
      source: 'primary' | 'last-good';
      payload: Record<string, unknown>;
    };

export interface PreferencesRepository<T extends object> {
  /** The stored payload as written, no queue, no recovery, no refresh wait. */
  readStoredPayload(): Promise<StoredPreferencesPayloadRead>;
  read(view: PreferencesReadView): Promise<T>;
  readAuthority(options?: {
    readonly includeServed?: boolean;
  }): Promise<PreferencesAuthorityRead<T>>;
  hasPersistedState(): Promise<boolean>;
  update(
    updater: PreferencesUpdater<T>,
    onCommitted?: (committed: T) => void,
  ): Promise<PreferencesChange<T>>;
  stampGeneration(
    isStopped?: () => boolean,
  ): Promise<PreferencesGenerationStamp>;
  flush(): Promise<void>;
  /** The queue's current tail. */
  idle(): Promise<void>;
  isRecoveryLatched(): boolean;
  peekLoadError(): PreferencesLoadError | null;
  acknowledgeLoadError(): void;
  migrationTimestamp(): string;
  /** Clears latches, the load error and migration timestamps. Not the queue or refreshes. */
  resetForTests(): void;
}

export function createPreferencesRepository<T extends object>(
  options: PreferencesRepositoryOptions<T>,
): PreferencesRepository<T> {
  const { codec, hooks = {}, log } = options;
  const refresher = createLastGoodRefresher(log);
  let writePreferencesQueue: Promise<void> = Promise.resolve();
  let loadError: PreferencesLoadError | null = null;
  const failedPreferencesRecoveries = new Map<
    string,
    { details: PreferencesLoadError; fallback: T }
  >();
  const migrationTimestamps = new Map<string, string>();
  function resolveDocument(): PreferencesDocument {
    return options.document();
  }
  interface PreferencesEnvelope {
    version: typeof PREFERENCES_ENVELOPE_WRITE_VERSION;
    generation: number;
    preferences: T;
  }
  /**
   * Preferences as read for a save, with the generation they were stored at;
   * null when main's `generation` is not a valid one.
   */
  interface StoredPreferences {
    preferences: T;
    generation: number | null;
  }

  interface LastGoodPreferences extends StoredPreferences {
    status: 'ok';
    path: string;
    generation: number;
  }

  type LastGoodPreferencesRead =
    | LastGoodPreferences
    | { status: 'absent' }
    | { status: 'unreadable'; code?: string };
  function enqueuePreferencesOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = writePreferencesQueue.then(operation);
    writePreferencesQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function recordFailedPreferencesRecovery(
    details: PreferencesLoadError,
    fallback: T = codec.defaults,
  ): void {
    failedPreferencesRecoveries.set(details.filePath, { details, fallback });
    loadError = details;
    hooks.onRecoveryLatched?.(details);
  }
  function assertPreferencesWritable(document: PreferencesDocument): void {
    const failure = failedPreferencesRecoveries.get(document.key);
    if (failure) throw new PreferencesRecoveryRequiredError(failure.details);
  }
  function createPreferencesRecoveryError(
    document: PreferencesDocument,
    reason: PreferencesLoadErrorReason,
    message: string,
    actualVersion?: unknown,
    code?: string,
  ): PreferencesLoadError {
    const timestamp = new Date().toISOString();
    const backupPath = document.backupLocation(`${timestamp}-${randomUUID()}`);
    return {
      timestamp,
      reason,
      message,
      filePath: document.key,
      backupPath,
      code,
      expectedVersion: PREFERENCES_ENVELOPE_WRITE_VERSION,
      actualVersion,
    };
  }

  function createPreferencesBackupPayload(
    error: PreferencesLoadError,
    rawContent: string | null,
    parsedContent: unknown,
  ): Record<string, unknown> {
    if (isRecord(parsedContent)) {
      const payload: Record<string, unknown> = {
        ...parsedContent,
        __error: error,
      };

      if (rawContent !== null) {
        payload.rawContent = rawContent;
      }

      return payload;
    }

    if (rawContent !== null) {
      return {
        __error: error,
        rawContent,
      };
    }

    return {
      __error: error,
      originalContentUnavailable: true,
    };
  }

  function serializePreferencesFile(
    preferences: T,
    generation: number,
  ): string {
    const payload: PreferencesEnvelope = {
      version: PREFERENCES_ENVELOPE_WRITE_VERSION,
      generation,
      preferences,
    };
    return JSON.stringify(payload, null, 2);
  }

  function normalizeParsedPreferencesFile(parsed: unknown): T | null {
    const preferences = readPreferencesEnvelopeRecord(parsed);
    return preferences ? codec.normalize(preferences, 'persisted') : null;
  }

  async function readLastGoodPreferencesFile(
    document: PreferencesDocument,
  ): Promise<LastGoodPreferencesRead> {
    await refresher.wait(document);
    const lastGoodPath = document.slotPath('lastGood');
    let raw: string;
    try {
      raw = await document.readText('lastGood');
    } catch (error) {
      return isMissingDocumentError(error)
        ? { status: 'absent' }
        : { status: 'unreadable', code: getErrorCode(error) };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const preferences = normalizeParsedPreferencesFile(parsed);
      // Unknown generation: it could look current, or legacy, when it is not.
      const generation = isRecord(parsed) ? documentGeneration(parsed) : null;
      if (!preferences || generation === null) {
        return { status: 'unreadable' };
      }

      return { status: 'ok', path: lastGoodPath, preferences, generation };
    } catch {
      return { status: 'unreadable' };
    }
  }

  /**
   * Restores a supported last-good file, or latches failed recovery for this
   * process. A supported last-good remains the in-memory display fallback either
   * way, named by `restoredFromPath`; it never becomes authority. Unusable
   * last-good falls back to defaults and is not named.
   */
  async function recoverOrServeFallback(
    document: PreferencesDocument,
    error: PreferencesLoadError,
    rawContent: string | null,
    parsedContent: unknown,
    knownLastGood?: LastGoodPreferencesRead,
  ): Promise<StoredPreferences> {
    const lastGood =
      knownLastGood ?? (await readLastGoodPreferencesFile(document));
    try {
      return await recoverPreferencesFile(
        document,
        error,
        rawContent,
        parsedContent,
        lastGood,
      );
    } catch (failure) {
      const details =
        failure instanceof PreferencesRecoveryRequiredError
          ? failure.details
          : { ...error, backupPath: undefined };
      // Latched, so this generation never reaches a save.
      if (lastGood.status !== 'ok') {
        recordFailedPreferencesRecovery(details);
        return { preferences: codec.defaults, generation: 0 };
      }
      recordFailedPreferencesRecovery(
        { ...details, restoredFromPath: lastGood.path },
        lastGood.preferences,
      );
      return { preferences: lastGood.preferences, generation: 0 };
    }
  }

  /**
   * Last-good is current only when the generation record proves it: a save
   * whose refresh failed or was lost leaves last-good behind the record, and
   * restoring it would undo that save (Mike, CAN-4469 O5 and Q3). An unreadable
   * record proves nothing, so recovery is refused.
   *
   * With no record file, a profile whose last-good and main carry no generation
   * was saved only by builds before CAN-5154, and its last-good stays the
   * starting point until a save writes the record (Mike, 2026-10-31). Saves
   * write generation 1 or more, so a generation means a record was written and
   * lost: refused. So is an invalid one, which may hide a generation.
   */
  async function isLastGoodCurrent(
    document: PreferencesDocument,
    lastGood: LastGoodPreferences,
    parsedMain: unknown,
  ): Promise<boolean> {
    const recorded = await readPreferencesGeneration(document);
    if (recorded.status === 'ok')
      return lastGood.generation >= recorded.generation;
    return (
      recorded.status === 'absent' &&
      lastGood.generation === 0 &&
      !(isRecord(parsedMain) && documentGeneration(parsedMain) !== 0)
    );
  }

  async function recoverPreferencesFile(
    document: PreferencesDocument,
    error: PreferencesLoadError,
    rawContent: string | null,
    parsedContent: unknown,
    lastGood: LastGoodPreferencesRead,
  ): Promise<StoredPreferences> {
    // Unreadable bytes and newer formats are not evidence we may replace.
    if (
      lastGood.status !== 'ok' ||
      error.reason === 'version' ||
      (error.reason === 'read' && error.code !== 'ENOENT')
    ) {
      throw new PreferencesRecoveryRequiredError({
        ...error,
        backupPath: undefined,
      });
    }
    if (!(await isLastGoodCurrent(document, lastGood, parsedContent))) {
      throw new PreferencesRecoveryRequiredError({
        ...error,
        backupPath: undefined,
        message: `${error.message} The last known good preferences may be older than the latest save, so they were not restored.`,
      });
    }
    const recoveryError = { ...error, restoredFromPath: lastGood.path };
    const backupPath = recoveryError.backupPath;
    if (!backupPath)
      throw new Error('Preferences recovery backup path is missing.');
    let backupWritten = false;
    try {
      await document.ensureFolder();
      await document.installBackup(
        backupPath,
        JSON.stringify(
          createPreferencesBackupPayload(
            recoveryError,
            rawContent,
            parsedContent,
          ),
          null,
          2,
        ),
      );
      backupWritten = true;
      await document.pruneBackups();
      await document.install(
        'primary',
        serializePreferencesFile(lastGood.preferences, lastGood.generation),
      );
    } catch (failure) {
      throw new PreferencesRecoveryRequiredError({
        ...recoveryError,
        backupPath: backupWritten ? backupPath : undefined,
        message: `Automatic preferences recovery failed: ${getErrorMessage(failure)}`,
      });
    }
    // The source is already good. Rewriting it adds a destructive failure stage.
    hooks.onRecovered?.(lastGood.preferences);
    loadError = recoveryError;
    return {
      preferences: lastGood.preferences,
      generation: lastGood.generation,
    };
  }

  /**
   * The supported last-good (or latched) fallback `readPreferencesFile()` serves,
   * read without recovery or writes. Never authority.
   */
  async function readServedPreferencesFallback(
    document: PreferencesDocument,
  ): Promise<T> {
    const latched = failedPreferencesRecoveries.get(document.key);
    if (latched) return codec.project(latched.fallback);
    const lastGood = await readLastGoodPreferencesFile(document);
    const latchedDuringRead = failedPreferencesRecoveries.get(document.key);
    if (latchedDuringRead) return codec.project(latchedDuringRead.fallback);
    return codec.project(
      lastGood.status === 'ok' ? lastGood.preferences : codec.defaults,
    );
  }

  async function readStoredPreferences(
    document: PreferencesDocument,
    validation: PreferencesReadView,
  ): Promise<StoredPreferences> {
    const projectRecovery = ({
      preferences,
      generation,
    }: StoredPreferences): StoredPreferences => ({
      preferences:
        validation === 'runtime' ? codec.project(preferences) : preferences,
      generation,
    });
    const fresh: StoredPreferences = {
      preferences: codec.defaults,
      generation: 0,
    };
    const failure = failedPreferencesRecoveries.get(document.key);
    if (failure)
      return projectRecovery({ preferences: failure.fallback, generation: 0 });
    let raw: string;

    try {
      raw = await document.readText('primary');
    } catch (error) {
      if (isMissingDocumentError(error)) {
        const lastGood = await readLastGoodPreferencesFile(document);
        if (lastGood.status === 'ok') {
          return projectRecovery(
            await recoverOrServeFallback(
              document,
              createPreferencesRecoveryError(
                document,
                'read',
                'Preferences file is missing.',
                undefined,
                'ENOENT',
              ),
              null,
              undefined,
              lastGood,
            ),
          );
        }

        if (lastGood.status === 'unreadable') {
          recordFailedPreferencesRecovery({
            ...createPreferencesRecoveryError(
              document,
              'read',
              'Preferences file is missing and the last known good preferences could not be read.',
              undefined,
              lastGood.code,
            ),
            backupPath: undefined,
          });
        }
        // Both missing: fresh install (Full Access, no global rules) whatever the
        // generation record says; it is not existence proof (CAN-4469 T1, Mike).
        return projectRecovery(fresh);
      }

      return projectRecovery(
        await recoverOrServeFallback(
          document,
          createPreferencesRecoveryError(
            document,
            'read',
            getErrorMessage(error),
            undefined,
            getErrorCode(error),
          ),
          null,
          undefined,
        ),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return projectRecovery(
        await recoverOrServeFallback(
          document,
          createPreferencesRecoveryError(
            document,
            'parse',
            getErrorMessage(error),
          ),
          raw,
          null,
        ),
      );
    }

    if (
      !isRecord(parsed) ||
      !isReadablePreferencesEnvelopeVersion(parsed.version)
    ) {
      return projectRecovery(
        await recoverOrServeFallback(
          document,
          createPreferencesRecoveryError(
            document,
            'version',
            'Unsupported preferences file version.',
            isRecord(parsed) ? parsed.version : undefined,
          ),
          raw,
          parsed,
        ),
      );
    }

    if (!isRecord(parsed.preferences)) {
      return projectRecovery(
        await recoverOrServeFallback(
          document,
          createPreferencesRecoveryError(
            document,
            'parse',
            'Preferences payload does not contain a valid preferences object.',
          ),
          raw,
          parsed,
        ),
      );
    }

    const inspection = codec.inspect(parsed.preferences);
    if (inspection !== null) {
      loadError = {
        timestamp: new Date().toISOString(),
        filePath: document.key,
        reason: 'parse',
        message: inspection,
      };
    }
    return {
      preferences: codec.normalize(parsed.preferences, validation),
      generation: documentGeneration(parsed),
    };
  }

  /**
   * A save landed under the record: main carries the recorded generation. A
   * record whose save failed before main, or that an older build left behind
   * main, does not count.
   */
  async function isPreferencesSaveRecorded(
    document: PreferencesDocument,
  ): Promise<boolean> {
    const recorded = await readPreferencesGeneration(document);
    if (recorded.status !== 'ok') return false;
    try {
      const parsed: unknown = JSON.parse(await document.readText('primary'));
      const generation = isRecord(parsed) ? documentGeneration(parsed) : null;
      return generation !== null && generation >= recorded.generation;
    } catch {
      return false;
    }
  }
  /**
   * Read authority without recovery writes, for decisions that can delete
   * persisted state. `preferences` is defaults unless authority is `ok`;
   * `includeServed` adds the served fallback for non-authority settings.
   */
  async function readAuthority(
    options: { includeServed?: boolean } = {},
  ): Promise<PreferencesAuthorityRead<T>> {
    // Main's durability only; last-good is awaited only where it is read.
    await writePreferencesQueue;
    const document = resolveDocument();
    const unreadable = async (): Promise<PreferencesAuthorityRead<T>> => ({
      preferences: codec.defaults,
      authority: 'unreadable',
      ...(options.includeServed === true
        ? { served: await readServedPreferencesFallback(document) }
        : {}),
    });
    if (failedPreferencesRecoveries.has(document.key)) {
      return unreadable();
    }
    let raw: string;
    try {
      raw = await document.readText('primary');
    } catch (error) {
      await refresher.wait(document);
      const absent =
        isMissingDocumentError(error) &&
        (await document.exists('lastGood').then(
          (exists): boolean => !exists,
          (): boolean => false,
        ));
      // T1: the generation record cannot turn absent into degraded; see
      // readStoredPreferences.
      return absent && !failedPreferencesRecoveries.has(document.key)
        ? { preferences: codec.defaults, authority: 'absent' }
        : unreadable();
    }
    // Recovery may have failed while this non-mutating read was in flight.
    if (failedPreferencesRecoveries.has(document.key)) {
      return unreadable();
    }
    try {
      const preferences = readPreferencesEnvelopeRecord(JSON.parse(raw));
      if (preferences) {
        return {
          preferences: codec.normalize(preferences, 'runtime'),
          authority: 'ok',
        };
      }
    } catch {
      // Corrupt preferences cannot authorize destructive cleanup.
    }
    return unreadable();
  }
  async function readStoredPayload(): Promise<StoredPreferencesPayloadRead> {
    const document = resolveDocument();
    if (!(await hasPersistedDocument(document))) return { kind: 'missing' };
    const candidates: Array<{
      slot: 'primary' | 'lastGood';
      source: 'primary' | 'last-good';
    }> = [
      { slot: 'primary', source: 'primary' },
      { slot: 'lastGood', source: 'last-good' },
    ];
    for (const candidate of candidates) {
      try {
        const payload = readPreferencesEnvelopeRecord(
          JSON.parse(await document.readText(candidate.slot)),
        );
        if (!payload) continue;
        return { kind: 'read', source: candidate.source, payload };
      } catch {
        continue;
      }
    }
    return { kind: 'unreadable' };
  }

  function read(view: PreferencesReadView): Promise<T> {
    return enqueuePreferencesOperation(
      async () =>
        (await readStoredPreferences(resolveDocument(), view)).preferences,
    );
  }
  async function hasPersistedDocument(
    document: PreferencesDocument,
  ): Promise<boolean> {
    return (await document.exists('primary')) || document.exists('lastGood');
  }
  function hasPersistedState(): Promise<boolean> {
    return hasPersistedDocument(resolveDocument());
  }
  function migrationTimestampFor(document: PreferencesDocument): string {
    const existing = migrationTimestamps.get(document.key);
    if (existing !== undefined) return existing;
    const timestamp = new Date().toISOString();
    migrationTimestamps.set(document.key, timestamp);
    return timestamp;
  }
  async function updateDocument(
    document: PreferencesDocument,
    updater: PreferencesUpdater<T>,
    onCommitted?: (committed: T) => void,
  ): Promise<PreferencesChange<T>> {
    assertPreferencesWritable(document);
    const { preferences: existing, generation: storedGeneration } =
      await readStoredPreferences(document, 'persisted');
    assertPreferencesWritable(document);
    const patch = await updater(existing);
    if (patch === null) return { previous: existing, next: existing };
    const next = codec.merge(existing, patch, {
      loadError,
      migrationTimestamp: () => migrationTimestampFor(document),
    });
    const change = { previous: existing, next };
    await hooks.beforeSave?.(change, document);
    await document.ensureFolder();
    const generation = await nextPreferencesGeneration(
      document,
      refresher,
      storedGeneration,
    );
    const content = serializePreferencesFile(next, generation);
    const save = (async (): Promise<void> => {
      await writePreferencesGeneration(document, generation);
      try {
        await document.install('primary', content);
      } catch (error) {
        if (isStorageOutcomeUnknownError(error))
          hooks.onSaveOutcomeUnknown?.(change);
        throw error;
      }
      hooks.onSaveDurable?.(change);
    })();
    await (hooks.trackSave ? hooks.trackSave(save, change) : save);
    await hooks.afterSave?.(change);
    refresher.schedule(document, content);
    hooks.onCommitted?.(next);
    onCommitted?.(next);
    return change;
  }
  function update(
    updater: PreferencesUpdater<T>,
    onCommitted?: (committed: T) => void,
  ): Promise<PreferencesChange<T>> {
    return enqueuePreferencesOperation(() =>
      updateDocument(resolveDocument(), updater, onCommitted),
    );
  }
  /**
   * One save of the stored preferences, unless a save already landed under the
   * record. For a profile without a record, that save writes it and retires the
   * legacy last-good as a starting point. Queued like any save; rechecked inside
   * the queue, so a user save that got there first ends it. A latched recovery
   * refuses it until restart. `isStopped` is checked with no await before the
   * save is queued; a queued save completes like any save.
   */
  async function stampGeneration(
    isStopped: () => boolean = (): boolean => false,
  ): Promise<PreferencesGenerationStamp> {
    const document = resolveDocument();
    if (failedPreferencesRecoveries.has(document.key)) return 'degraded';
    let outcome: PreferencesGenerationStamp = 'present';
    try {
      if (await isPreferencesSaveRecorded(document)) return 'present';
      // Without main or last-good there is no legacy copy; any save records.
      if (!(await hasPersistedDocument(document))) return 'fresh';
      if (isStopped()) return 'stopped';
      // Queued synchronously: from here quit's flush waits for this save.
      await enqueuePreferencesOperation(() =>
        updateDocument(document, async () => {
          if (await isPreferencesSaveRecorded(document)) return null;
          outcome = 'stamped';
          return {};
        }),
      );
    } catch (error) {
      // Another owner keeps the row; a retry can't write it either.
      if (error instanceof StorageRowOwnerError) return 'refused';
      return error instanceof PreferencesRecoveryRequiredError
        ? 'degraded'
        : 'failed';
    }
    return outcome;
  }
  /**
   * Waits for queued saves and the last-good refreshes they started, again for
   * saves queued meanwhile. Bounded, so a steady writer cannot hold quit open.
   */
  async function flush(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      const queue = writePreferencesQueue;
      await queue;
      const refreshes = refresher.running();
      if (refreshes.length === 0 && queue === writePreferencesQueue) return;
      await Promise.all(refreshes);
    }
  }
  return {
    readStoredPayload,
    read,
    readAuthority,
    hasPersistedState,
    update,
    stampGeneration,
    flush,
    idle: (): Promise<void> => writePreferencesQueue,
    isRecoveryLatched: (): boolean =>
      failedPreferencesRecoveries.has(resolveDocument().key),
    peekLoadError: (): PreferencesLoadError | null => loadError,
    acknowledgeLoadError: (): void => {
      loadError = null;
    },
    migrationTimestamp: (): string => migrationTimestampFor(resolveDocument()),
    resetForTests: (): void => {
      failedPreferencesRecoveries.clear();
      loadError = null;
      migrationTimestamps.clear();
    },
  };
}
