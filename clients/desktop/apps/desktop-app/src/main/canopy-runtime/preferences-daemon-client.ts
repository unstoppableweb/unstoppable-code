import { randomUUID } from 'node:crypto';
import {
  CanopyClientError,
  deliverCanopy,
  toCanopyClientError,
  type CanopyClientInstructionOptions,
} from '@canopy/core-client';
import { CanopyOutcomeUnknownError } from '@canopy/core-client/outcome';
import {
  CLIENT_LOCAL_PREFERENCE_KEYS,
  type PreferencesAuthorityRead,
  type PreferencesCodec,
  type PreferencesChange,
  type PreferencesLoadError,
  type PreferencesRepositoryHooks,
  type PreferencesUpdater,
} from '@canopy/core-runtime/node/preferences';
import { isUnknownKeyedWriteOutcome } from '@canopy/protocol/canopy-core';
import {
  ConfigDocumentOwnerUpdateParamsSchema,
  ConfigDocumentUpdateParamsSchema,
  classifyPreferenceWrite,
  isLegacyTerminalSettingsSave,
  type ConfigDocumentGetResult,
  type ConfigDocumentLoadError,
  type ConfigDocumentOwnerUpdateParams,
  type ConfigDocumentUpdateParams,
  type ConfigDocumentUpdateResult,
  type ConfigLegacyClientLocalGetResult,
  type CoreConfigCommittedPayload,
  type CoreConfigInvalidatedPayload,
} from '@canopy/protocol/canopy-core/core';
import { stableStringify } from '@canopy/protocol/plans';
import type { LegacyClientLocalRead } from '../lib/client-preferences-store';
import type {
  DomainPreferencesUpdateOptions,
  PortPreferencesChange,
  PreferencesPort,
} from '../lib/preferences-domain-port';

/*
 * The daemon-backed preferences port (CAN-5722, slice E2), over the
 * CAN-7926 document operations the daemon's module serves (CAN-7956). Not
 * selected: `selectDomainPreferences` still answers in process.
 *
 * Reads come from a cache the daemon's commit events keep current. A write
 * runs its updater here on the cached document, diffs the patch down to the
 * keys it changes and sends it with the cached revision; a revision conflict
 * re-reads and runs the updater again, a bounded number of times.
 */

/** One daemon commit event, or `resync` after the subscription missed some. */
export type PreferencesDocumentEvent =
  | {
      readonly name: 'core.config.committed';
      readonly payload: CoreConfigCommittedPayload;
    }
  | {
      readonly name: 'core.config.invalidated';
      readonly payload: CoreConfigInvalidatedPayload;
    }
  | { readonly name: 'resync' };

/**
 * The daemon connection the client calls. `clientInstanceId` is the one the
 * daemon attributes this connection's commits to (`publishedBy`), and
 * `ownerClientInstanceId` the owner connection's, when owner writes go over
 * a session of their own (`daemon-preferences-route.ts`).
 */
export interface PreferencesDocumentRoute {
  readonly clientInstanceId: string;
  readonly ownerClientInstanceId?: string;
  get(): Promise<ConfigDocumentGetResult>;
  legacyClientLocal(): Promise<ConfigLegacyClientLocalGetResult>;
  update(
    params: ConfigDocumentUpdateParams,
    options: CanopyClientInstructionOptions,
  ): Promise<ConfigDocumentUpdateResult>;
  ownerUpdate(
    params: ConfigDocumentOwnerUpdateParams,
    options: CanopyClientInstructionOptions,
  ): Promise<ConfigDocumentGetResult>;
  acknowledgeLoadError(params: {
    readonly timestamp: string;
  }): Promise<unknown>;
  /** Returns the unsubscribe. */
  subscribe(listener: (event: PreferencesDocumentEvent) => void): () => void;
}

/** A commit another client made, in the shape `applyForeignPreferenceCommit` takes. */
export interface DaemonForeignCommit<T> {
  readonly previous: T;
  readonly next: T;
  /** Increases with every commit this process applies; never reused. */
  readonly revision: number;
  readonly changedKeys: ReadonlySet<string>;
}

/** The repository hooks an own save runs, in the repository's order. */
export type DaemonPreferencesHooks<T> = Pick<
  PreferencesRepositoryHooks<T>,
  | 'trackSave'
  | 'onSaveOutcomeUnknown'
  | 'onSaveDurable'
  | 'afterSave'
  | 'onCommitted'
> & {
  /**
   * The client's own pre-commit steps, before each attempt is sent, on the
   * change that attempt predicts (`usageData` merged per key, as the daemon
   * merges it). The repository's `beforeSave` also takes the document; the
   * daemon runs that part itself (its consent journal). A rejection fails the
   * save with nothing sent.
   */
  readonly beforeSave?: (change: PreferencesChange<T>) => Promise<void>;
};

export interface DaemonPreferencesClientOptions<T extends object> {
  readonly route: PreferencesDocumentRoute;
  /** Decodes the daemon's value; `defaults` answers an unreadable authority read. */
  readonly codec: Pick<PreferencesCodec<T>, 'defaults' | 'normalize'>;
  readonly hooks?: DaemonPreferencesHooks<T>;
  /** Wired to `applyForeignPreferenceCommit`; its rejection is reported, not retried. */
  readonly applyForeignCommit?: (
    commit: DaemonForeignCommit<T>,
  ) => Promise<void>;
  /** The host's own paths for the recovery notice; the daemon's are path-free. */
  readonly paths: { readonly document: string; readonly lastGood: string };
  readonly log: { error(message: string, error?: unknown): void };
}

export interface DaemonPreferencesClient<
  T extends object,
> extends PreferencesPort<T> {
  /** Stops following the daemon's events. */
  close(): void;
}

/** Updater runs per save: the first, plus re-runs after a revision conflict. */
export const DAEMON_PREFERENCES_UPDATE_ATTEMPTS = 3;
/** Own commits whose echo is still expected; older claims are dropped. */
const MAX_PENDING_ECHOES = 64;

const CLIENT_LOCAL_KEYS: ReadonlySet<string> = new Set(
  CLIENT_LOCAL_PREFERENCE_KEYS,
);

const LOAD_ERROR_MESSAGES: Record<PreferencesLoadError['reason'], string> = {
  read: 'Preferences could not be read.',
  parse: 'Preferences could not be parsed.',
  version: 'Unsupported preferences file version.',
};

// One sequence for the process, as the commit consumer's high-water mark is.
let foreignCommitSequence = 0;

interface Snapshot<T> {
  readonly revision: string;
  readonly value: T;
  readonly loadError: ConfigDocumentLoadError | null;
  readonly legacy: ConfigLegacyClientLocalGetResult;
  /** A primary or last-good copy exists, so authority reads are `ok`. */
  readonly persisted: boolean;
}

/** As the repository's refusal: callers match its `code`. */
class DaemonPreferencesRecoveryRequiredError extends Error {
  readonly code = 'PREFERENCES_RECOVERY_REQUIRED';
  constructor() {
    super('Preferences could not be read. Changes were not saved.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const sameValue = (a: unknown, b: unknown): boolean =>
  stableStringify(a) === stableStringify(b);

function changedKeys(previous: object, next: object): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].filter(
    (key) => !sameValue(Reflect.get(previous, key), Reflect.get(next, key)),
  );
}

/**
 * What the daemon is sent: the domain keys whose value changes, `usageData`
 * by the flows that change (the daemon merges it per key, so the stored
 * copy of another flow is never overwritten). Client-local keys are left
 * out; the daemon keeps their stored copy anyway. The legacy terminal
 * settings intent goes as sent: one key of it alone would be dropped.
 * JSON has no `undefined`, so a key cleared with it goes as `null`, which
 * the codec normalizes as it would the absent key.
 */
function patchToSend(latest: object, patch: object): Record<string, unknown> {
  const entries = Object.entries(patch).flatMap(
    ([key, value]): Array<[string, unknown]> => {
      if (CLIENT_LOCAL_KEYS.has(key)) return [];
      if (value !== undefined) return [[key, value]];
      return Reflect.get(latest, key) === undefined ? [] : [[key, null]];
    },
  );
  if (isLegacyTerminalSettingsSave(patch)) return Object.fromEntries(entries);
  const sent: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const stored: unknown = Reflect.get(latest, key);
    if (key === 'usageData' && isRecord(value) && isRecord(stored)) {
      const flows = Object.entries(value).filter(
        ([flow, choice]) => !sameValue(choice, stored[flow]),
      );
      if (flows.length > 0) sent[key] = Object.fromEntries(flows);
    } else if (!sameValue(value, stored)) {
      sent[key] = value;
    }
  }
  return sent;
}

/** What a save of `patch` on `previous` commits, `usageData` merged per key. */
function predictNext<T extends object>(previous: T, patch: Partial<T>): T {
  const next: T = { ...previous, ...patch };
  const stored: unknown = Reflect.get(previous, 'usageData');
  const sent: unknown = Reflect.get(patch, 'usageData');
  if (isRecord(stored) && isRecord(sent))
    Reflect.set(next, 'usageData', { ...stored, ...sent });
  return next;
}

const errorPayload = (error: unknown): CanopyClientError['payload'] | null =>
  error instanceof CanopyOutcomeUnknownError
    ? null
    : toCanopyClientError(error).payload;

const isRevisionConflict = (error: unknown): boolean =>
  errorPayload(error)?.code === 'core.config.revisionConflict';

const isDaemonRecoveryRefusal = (error: unknown): boolean => {
  const payload = errorPayload(error);
  return (
    payload?.kind === 'failed_precondition' &&
    payload.code === 'core.config.invalidState'
  );
};

function conflictsExhausted(): CanopyClientError {
  return new CanopyClientError({
    kind: 'conflict',
    code: 'core.config.revisionConflict',
    message: 'Preferences kept changing while they were saved.',
    retry: { kind: 'after_refresh', resource: 'core.config.document' },
  });
}

type SaveOutcome<T> =
  | { readonly kind: 'committed'; readonly change: PreferencesChange<T> }
  | { readonly kind: 'conflict'; readonly error: unknown };

export function createDaemonPreferencesClient<T extends object>(
  options: DaemonPreferencesClientOptions<T>,
): DaemonPreferencesClient<T> {
  const { route, codec, hooks = {}, log } = options;
  const noop = (): void => undefined;

  let snapshot: Snapshot<T> | null = null;
  let loading: Promise<Snapshot<T>> | null = null;
  let migrationTimestamp: string | undefined;
  /** Revisions of own commits whose `committed` event has not arrived. */
  let pendingEchoes: string[] = [];
  /** Another client's change found since the last emission, and what it changed. */
  let discovered: { previous: T; keys: Set<string> } | null = null;

  // Own writes, event handling and the first load, in one order: a commit
  // event is only handled once the own write before it has adopted its reply.
  let serialTail: Promise<void> = Promise.resolve();
  let writesTail: Promise<void> = Promise.resolve();
  function runSerial<R>(task: () => Promise<R>): Promise<R> {
    const run = serialTail.then(task).finally(emitDiscovered);
    serialTail = run.then(noop, noop);
    return run;
  }

  const decode = (document: ConfigDocumentGetResult): T =>
    codec.normalize(document.value, 'persisted');

  async function fetchSnapshot(): Promise<Snapshot<T>> {
    const [document, legacy] = await Promise.all([
      route.get(),
      route.legacyClientLocal(),
    ]);
    return {
      revision: document.revision,
      value: decode(document),
      loadError: document.loadError,
      legacy,
      persisted: legacy.kind !== 'missing',
    };
  }

  function adopt(next: Snapshot<T>, origin: 'own' | 'discovered'): void {
    const before = snapshot;
    snapshot = next;
    if (before === null) return;
    const keys = changedKeys(before.value, next.value);
    if (origin === 'own') {
      // The own save's hooks settle these keys; the foreign commit must not.
      for (const key of keys) discovered?.keys.delete(key);
      return;
    }
    if (keys.length === 0) return;
    discovered ??= { previous: before.value, keys: new Set() };
    for (const key of keys) discovered.keys.add(key);
  }

  /**
   * Hands what another client changed to the commit consumer, after the
   * serial task that found it. It carries the latest document, so a commit
   * found during an own save, and applied after it, never rolls back what
   * the save committed; its `previous` differs from it only in the foreign
   * keys, so the consumer never settles the save's keys twice. Its sequence
   * only increases, so the consumer's high-water mark never drops it. A
   * failure is reported and not retried: the next commit's `previous` is
   * already past it.
   */
  function emitDiscovered(): void {
    const found = discovered;
    discovered = null;
    const apply = options.applyForeignCommit;
    if (found === null || found.keys.size === 0) return;
    if (snapshot === null || apply === undefined) return;
    const next = snapshot.value;
    const previous: T = { ...next };
    for (const key of found.keys) {
      if (Object.prototype.hasOwnProperty.call(found.previous, key))
        Reflect.set(previous, key, Reflect.get(found.previous, key));
      else Reflect.deleteProperty(previous, key);
    }
    foreignCommitSequence += 1;
    const commit: DaemonForeignCommit<T> = {
      previous,
      next,
      revision: foreignCommitSequence,
      changedKeys: found.keys,
    };
    apply(commit).catch((error: unknown) =>
      log.error(
        'A preferences change from another client could not be applied.',
        error,
      ),
    );
  }

  /** Inside a serial task only. */
  async function current(): Promise<Snapshot<T>> {
    if (snapshot !== null) return snapshot;
    snapshot = await fetchSnapshot();
    return snapshot;
  }

  function loaded(): Promise<Snapshot<T>> {
    if (snapshot !== null) return Promise.resolve(snapshot);
    // A failed load is not kept: the next read tries again.
    loading ??= runSerial(current).finally(() => {
      loading = null;
    });
    return loading;
  }

  /** Re-reads the document after the current task; finds what changed. */
  function queueResync(): void {
    runSerial(async () => {
      if (snapshot !== null) adopt(await fetchSnapshot(), 'discovered');
    }).catch((error: unknown) =>
      log.error('Preferences could not be re-read from the daemon.', error),
    );
  }

  function onEvent(event: PreferencesDocumentEvent): void {
    if (event.name === 'core.config.committed') {
      const { revision, publishedBy } = event.payload;
      runSerial(async () => {
        if (snapshot === null) return;
        if (
          publishedBy === route.clientInstanceId ||
          (publishedBy !== undefined &&
            publishedBy === route.ownerClientInstanceId)
        ) {
          const echo = pendingEchoes.indexOf(revision);
          if (echo !== -1) {
            pendingEchoes.splice(echo, 1);
            return;
          }
        }
        if (revision === snapshot.revision) return;
        // Values are re-read, never sent.
        adopt(await fetchSnapshot(), 'discovered');
      }).catch((error: unknown) =>
        log.error('Preferences could not be re-read from the daemon.', error),
      );
      return;
    }
    queueResync();
  }
  const unsubscribe = route.subscribe(onEvent);

  /**
   * Sends one diffed patch. A reply lost on the way is resent with the same
   * key, and the save's outcome is reported unknown (authority unconfirmed)
   * until the resend settles. Once any attempt is unknown, the save never
   * runs its updater again: a later conflict may be its own first commit.
   */
  async function send(
    base: Snapshot<T>,
    patch: Partial<T>,
    sent: Record<string, unknown>,
    writeRoute: DomainPreferencesUpdateOptions['route'],
  ): Promise<SaveOutcome<T>> {
    const idempotencyKey = randomUUID();
    const params = {
      patch: sent,
      expectedRevision: base.revision,
      _meta: { idempotencyKey },
    };
    // The exact patch sent is classified; caller patches never are. Parsed
    // before delivery: a refused value is this save's error, never an
    // unknown outcome.
    let call: (
      callOptions: CanopyClientInstructionOptions,
    ) => Promise<ConfigDocumentGetResult>;
    if (
      writeRoute === 'internal' &&
      classifyPreferenceWrite(sent) === 'owner'
    ) {
      const ownerParams = ConfigDocumentOwnerUpdateParamsSchema.parse(params);
      call = (callOptions): Promise<ConfigDocumentGetResult> =>
        route.ownerUpdate(ownerParams, callOptions);
    } else {
      const openParams = ConfigDocumentUpdateParamsSchema.parse(params);
      call = (callOptions): Promise<ConfigDocumentGetResult> =>
        route.update(openParams, callOptions);
    }
    const predicted: PreferencesChange<T> = {
      previous: base.value,
      next: predictNext(base.value, patch),
    };
    await hooks.beforeSave?.(predicted);
    let uncertain = false;
    let inFlight = false;
    const markUncertain = (): void => {
      if (uncertain) return;
      uncertain = true;
      hooks.onSaveOutcomeUnknown?.(predicted);
    };
    const saved = (async (): Promise<PreferencesChange<T>> => {
      let document: ConfigDocumentGetResult;
      try {
        document = await deliverCanopy(
          async ({ signal }) => {
            inFlight = true;
            try {
              return await call({ metadata: { idempotencyKey }, signal });
            } catch (error) {
              if (
                isUnknownKeyedWriteOutcome(toCanopyClientError(error).payload)
              )
                markUncertain();
              else if (!signal.aborted) inFlight = false;
              throw error;
            }
          },
          { replay: 'same_idempotency_key' },
        );
      } catch (error) {
        if (
          uncertain ||
          inFlight ||
          (error instanceof CanopyClientError &&
            isUnknownKeyedWriteOutcome(error.payload))
        ) {
          markUncertain();
          throw new CanopyOutcomeUnknownError();
        }
        throw error;
      }
      const change = { previous: base.value, next: decode(document) };
      if (document.revision !== base.revision) {
        pendingEchoes = [...pendingEchoes, document.revision].slice(
          -MAX_PENDING_ECHOES,
        );
      }
      adopt(
        {
          revision: document.revision,
          value: change.next,
          loadError: document.loadError,
          legacy: base.legacy,
          persisted: true,
        },
        'own',
      );
      hooks.onSaveDurable?.(change);
      return change;
    })();
    const save = saved.then(noop);
    try {
      await (hooks.trackSave ? hooks.trackSave(save, predicted) : save);
      return { kind: 'committed', change: await saved };
    } catch (error) {
      if (error instanceof CanopyOutcomeUnknownError) queueResync();
      if (isRevisionConflict(error)) return { kind: 'conflict', error };
      if (isDaemonRecoveryRefusal(error)) {
        queueResync();
        throw new DaemonPreferencesRecoveryRequiredError();
      }
      throw error;
    }
  }

  async function write(
    updater: PreferencesUpdater<T>,
    onCommitted: ((committed: T) => void) | undefined,
    updateOptions: DomainPreferencesUpdateOptions,
  ): Promise<PortPreferencesChange<T>> {
    if (snapshot === null && updateOptions.isClientOnly !== undefined) {
      // A cold cache is no reason to reach the daemon for a client-only
      // save: the updater runs on the defaults first. Anything else it
      // answers there, a refusal included, decides nothing; the document is
      // loaded and the updater runs again (updaters may re-run). The
      // defaults stand in for a domain document nobody has read, so the
      // recovery latch stays on until a load proves it.
      const provisional = codec.defaults;
      const clientOnly = await Promise.resolve()
        .then(() => updater(provisional))
        .then(
          (patch) => patch === null && updateOptions.isClientOnly?.() === true,
          () => false,
        );
      if (clientOnly)
        return { previous: provisional, next: provisional, unread: true };
    }
    let base = await current();
    for (let attempt = 1; ; attempt += 1) {
      if (base.legacy.kind === 'pending')
        throw new DaemonPreferencesRecoveryRequiredError();
      const previous = base.value;
      const patch = await updater(previous);
      if (patch === null && updateOptions.isClientOnly?.() === true)
        return { previous, next: previous };
      const sent = patch === null ? {} : patchToSend(previous, patch);
      if (Object.keys(sent).length > 0 && patch !== null) {
        const outcome = await send(base, patch, sent, updateOptions.route);
        if (outcome.kind === 'committed') {
          const { change } = outcome;
          await hooks.afterSave?.(change);
          hooks.onCommitted?.(change.next);
          onCommitted?.(change.next);
          return change;
        }
        if (attempt >= DAEMON_PREFERENCES_UPDATE_ATTEMPTS) throw outcome.error;
      } else {
        // `null`, `{}` or nothing changed: a decision on `previous`, which
        // stands only while it is the stored document.
        const latest = await fetchSnapshot();
        if (latest.revision === base.revision) {
          adopt(latest, 'discovered');
          const change = { previous, next: previous };
          if (patch !== null) {
            await hooks.afterSave?.(change);
            hooks.onCommitted?.(previous);
            onCommitted?.(previous);
          }
          return change;
        }
        adopt(latest, 'discovered');
        base = latest;
        if (attempt >= DAEMON_PREFERENCES_UPDATE_ATTEMPTS)
          throw conflictsExhausted();
        continue;
      }
      const latest = await fetchSnapshot();
      adopt(latest, 'discovered');
      base = latest;
    }
  }

  function projectLoadError(
    error: ConfigDocumentLoadError,
  ): PreferencesLoadError {
    return {
      timestamp: error.timestamp,
      reason: error.reason,
      message: LOAD_ERROR_MESSAGES[error.reason],
      filePath: options.paths.document,
      // The daemon says a copy was set aside, not where.
      ...(error.restored && { restoredFromPath: options.paths.lastGood }),
      ...(error.code !== undefined && { code: error.code }),
      ...(error.expectedVersion !== undefined && {
        expectedVersion: error.expectedVersion,
      }),
      ...(error.actualVersion !== undefined && {
        actualVersion: error.actualVersion,
      }),
    };
  }

  return {
    update: (updater, onCommitted, updateOptions) => {
      const run = runSerial(() => write(updater, onCommitted, updateOptions));
      writesTail = run.then(noop, noop);
      return run;
    },
    read: async () => {
      await writesTail;
      return (await loaded()).value;
    },
    readAuthority: async (readOptions = {}) => {
      await writesTail;
      const unreadable = (served: T): PreferencesAuthorityRead<T> => ({
        preferences: codec.defaults,
        authority: 'unreadable',
        ...(readOptions.includeServed === true ? { served } : {}),
      });
      let state: Snapshot<T>;
      try {
        state = await loaded();
      } catch {
        // An unreachable daemon proves nothing.
        return unreadable(codec.defaults);
      }
      if (state.legacy.kind === 'pending') return unreadable(state.value);
      if (!state.persisted)
        return { preferences: codec.defaults, authority: 'absent' };
      return { preferences: state.value, authority: 'ok' };
    },
    hasPersistedState: async () => (await loaded()).persisted,
    // Raw stored bytes never cross the protocol: a persisted document reads
    // as unreadable, so format migrations skip it rather than guess.
    readStoredPayload: async () => {
      try {
        return (await loaded()).persisted
          ? { kind: 'unreadable' }
          : { kind: 'missing' };
      } catch {
        return { kind: 'unreadable' };
      }
    },
    // The daemon's own saves record the generation.
    stampGeneration: () => Promise.resolve('present'),
    flush: () => writesTail,
    idle: () => writesTail,
    // Unknown until the first read: unproven, so treated as latched.
    isRecoveryLatched: () =>
      snapshot === null || snapshot.legacy.kind === 'pending',
    peekLoadError: () =>
      snapshot?.loadError ? projectLoadError(snapshot.loadError) : null,
    acknowledgeLoadError: () => {
      const pending = snapshot?.loadError;
      if (snapshot === null || !pending) return;
      snapshot = { ...snapshot, loadError: null };
      route
        .acknowledgeLoadError({ timestamp: pending.timestamp })
        .catch((error: unknown) =>
          log.error('The preferences notice could not be cleared.', error),
        );
    },
    migrationTimestamp: () => (migrationTimestamp ??= new Date().toISOString()),
    resetForTests: () => {
      snapshot = null;
      loading = null;
      migrationTimestamp = undefined;
      pendingEchoes = [];
      discovered = null;
    },
    readLegacyClientLocal: async (): Promise<LegacyClientLocalRead> => {
      let state: Snapshot<T>;
      try {
        state = await loaded();
      } catch (error) {
        if (toCanopyClientError(error).payload.kind === 'unavailable')
          return { kind: 'pending', served: {} };
        throw error;
      }
      const { legacy } = state;
      if (legacy.kind === 'read')
        return { kind: 'read', values: legacy.values };
      if (legacy.kind === 'pending')
        return { kind: 'pending', served: legacy.served };
      return { kind: 'missing' };
    },
    // A fresh authority read, as the in-process answer is, never the cache:
    // the daemon judges it on what that read saw (CAN-7991). A daemon that
    // does not report it, or cannot be reached, proves nothing.
    readStoredProductAnalyticsChoice: async () => {
      await writesTail;
      try {
        const { storedUsageData } = await route.get();
        return storedUsageData?.productAnalytics ?? 'unconfirmed';
      } catch {
        return 'unconfirmed';
      }
    },
    close: () => unsubscribe(),
  };
}
