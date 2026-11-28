import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CanopyClientError, toCanopyClientError } from '@canopy/core-client';
import { CanopyOutcomeUnknownError } from '@canopy/core-client/outcome';
import {
  CLIENT_LOCAL_PREFERENCE_KEYS,
  type PreferencesAuthorityRead,
  type PreferencesCodec,
  type PreferencesUpdater,
} from '@canopy/core-runtime/node/preferences';
import { writeFileAtomically } from '@canopy/execution-engine/node/lib/atomic-file';
import { damagedCopyPath } from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  applyPreferenceSaveRules,
  CONFIG_DOCUMENT_PROTECTED_KEYS,
  ConfigDocumentPatchSchema,
  isLegacyTerminalSettingsSave,
} from '@canopy/protocol/canopy-core/core';
import { stableStringify } from '@canopy/protocol/plans';
import { readPreferencesEnvelopeRecord } from '@canopy/protocol/preferences';
import type { ElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';
import type {
  DaemonForeignCommit,
  DaemonPreferencesClient,
  DaemonPreferencesHooks,
} from '../canopy-runtime/preferences-daemon-client';
import type {
  DomainPreferencesUpdateOptions,
  DomainPreferencesWriteRoute,
  PortPreferencesChange,
} from './preferences-domain-port';
import { isRecord } from './type-guards';

/*
 * Electron main's outbox of domain preference saves made while the daemon is
 * unavailable (CAN-7993, CAN-5722 slice O), after the terminal record outbox
 * (`main/terminal/record-outbox.ts`). It wraps the daemon client: a save the
 * client could not deliver is kept here, durably and in order, and applied
 * at once to what main reads; the next save or a reconnect drains it through
 * the client. Not selected, like the client: `selectDomainPreferences` still
 * answers in process.
 *
 * Entries are blind keyed patches, each replayed on its save's route.
 * A caller's patch is kept as the save rules would write it live, so its
 * replay through them writes the same keys. Protected keys replay as kept,
 * since only the owning core writes them (T12). An internal save also keeps
 * the value each open key had when its updater read it, and its replay
 * re-merges that key onto what the daemon holds then, so a change another
 * client made meanwhile is not overwritten. Past the bound, neighbours of one
 * route merge per key. Usage-data revocations are kept apart, sent first and
 * never evicted.
 *
 * A save the client answers is returned as it answered it, `unread` included.
 * The outbox's own answers are read from the client's cache or the disk
 * projection, so they are never `unread`, except a client-only save while
 * the projection proves no document (CAN-7991's cold-cache rule). While no
 * read proves it, an unreadable projection or a latched daemon, every other
 * save is refused and only its revocations are kept.
 */

type Patch = Record<string, unknown>;

export interface PreferenceOutboxEntry {
  readonly route: DomainPreferencesWriteRoute;
  /** Diffed as the client would send it: changed keys, `null` to clear one. */
  readonly patch: Patch;
  /**
   * An internal save's open keys, with the value its updater read (`null`
   * when absent). A caller's save and protected keys replay blind.
   */
  readonly base?: Patch;
}

export interface PreferenceOutboxFile {
  readonly version: 1;
  readonly producer: 'electron_main';
  /** Usage-data flows turned off while queued: sent first, never evicted. */
  readonly revocations: readonly string[];
  readonly entries: readonly PreferenceOutboxEntry[];
}

export const PREFERENCE_OUTBOX_FILE_NAME = 'preference-outbox.json';
/** Past it, the two oldest entries merge into one. */
const PREFERENCE_OUTBOX_MAX_ENTRIES = 32;

const ADMITTED = {
  namespace: 'preference_outbox',
  writer: 'electron_main',
  module: 'main/lib/preference-outbox',
} as const;
const USAGE_DATA = 'usageData';
const CLIENT_LOCAL_KEYS: ReadonlySet<string> = new Set(
  CLIENT_LOCAL_PREFERENCE_KEYS,
);
const PROTECTED_KEYS: ReadonlySet<string> = new Set(
  CONFIG_DOCUMENT_PROTECTED_KEYS,
);

const EMPTY: PreferenceOutboxFile = {
  version: 1,
  producer: 'electron_main',
  revocations: [],
  entries: [],
};

const sameValue = (a: unknown, b: unknown): boolean =>
  stableStringify(a) === stableStringify(b);

const hasKey = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const recordOf = (value: object): Patch =>
  Object.fromEntries(Object.entries(value));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseOutbox(parsed: unknown): PreferenceOutboxFile | null {
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !isStringArray(parsed.revocations) ||
    !Array.isArray(parsed.entries)
  )
    return null;
  const entries: PreferenceOutboxEntry[] = [];
  for (const entry of parsed.entries) {
    if (!isRecord(entry) || !isRecord(entry.patch)) return null;
    if (entry.route !== 'caller' && entry.route !== 'internal') return null;
    if (entry.base !== undefined && !isRecord(entry.base)) return null;
    entries.push({
      route: entry.route,
      patch: entry.patch,
      ...(isRecord(entry.base) && { base: entry.base }),
    });
  }
  return { ...EMPTY, revocations: parsed.revocations, entries };
}

export type PreferenceOutboxRead =
  | { readonly kind: 'read'; readonly file: PreferenceOutboxFile }
  /** Set aside as a damaged copy: what it held is unknown. */
  | { readonly kind: 'damaged' };

/** One file in main's data root; main is its only writer. */
export class PreferenceOutboxStore {
  public constructor(private readonly root: () => string) {}

  private path(): string {
    return join(this.root(), PREFERENCE_OUTBOX_FILE_NAME);
  }

  public async read(): Promise<PreferenceOutboxRead> {
    const path = this.path();
    let file: PreferenceOutboxFile | null;
    try {
      file = parseOutbox(parseJson(await readFile(path, 'utf8')));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { kind: 'read', file: EMPTY };
      // Bytes that cannot be read are set aside too, never overwritten.
      file = null;
    }
    if (file) return { kind: 'read', file };
    await rename(path, damagedCopyPath(path)).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    return { kind: 'damaged' };
  }

  /** Nothing queued removes the file. */
  public write(file: PreferenceOutboxFile): Promise<void> {
    if (file.revocations.length === 0 && file.entries.length === 0)
      return rm(this.path(), { force: true });
    return writeFileAtomically(this.path(), JSON.stringify(file), {
      encoding: 'utf8',
      mode: 0o600,
      durable: true,
      admittedWriter: ADMITTED,
    });
  }
}

/**
 * What the daemon is sent, as the client diffs it: changed keys only,
 * `usageData` by changed flow, never client-local keys, `undefined` as
 * `null`. The legacy terminal settings intent goes as sent. A copy of the
 * client's private `patchToSend`; a change to either changes both.
 */
function diffPatch(latest: Patch, patch: Patch): Patch {
  const entries = Object.entries(patch).flatMap(
    ([key, value]): Array<[string, unknown]> => {
      if (CLIENT_LOCAL_KEYS.has(key)) return [];
      if (value !== undefined) return [[key, value]];
      return latest[key] === undefined ? [] : [[key, null]];
    },
  );
  if (isLegacyTerminalSettingsSave(patch)) return Object.fromEntries(entries);
  const sent: Patch = {};
  for (const [key, value] of entries) {
    const stored = latest[key];
    if (key === USAGE_DATA && isRecord(value) && isRecord(stored)) {
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

/** Blind: `usageData` merges per flow, every other key is replaced. */
function applyPatch(document: Patch, patch: Patch): Patch {
  const next = { ...document };
  for (const [key, value] of Object.entries(patch)) {
    const stored = next[key];
    next[key] =
      key === USAGE_DATA && isRecord(value) && isRecord(stored)
        ? { ...stored, ...value }
        : value;
  }
  return next;
}

function revokedFlows(patch: Patch): string[] {
  const usage = patch[USAGE_DATA];
  return isRecord(usage)
    ? Object.keys(usage).filter((flow) => usage[flow] === false)
    : [];
}

function revocationPatch(revocations: readonly string[]): Patch {
  return revocations.length === 0
    ? {}
    : {
        [USAGE_DATA]: Object.fromEntries(
          revocations.map((flow) => [flow, false]),
        ),
      };
}

/** An entry without these flows: a later revocation supersedes them. */
function withoutFlows(
  entry: PreferenceOutboxEntry,
  flows: readonly string[],
): PreferenceOutboxEntry {
  const usage = entry.patch[USAGE_DATA];
  if (!isRecord(usage)) return entry;
  const kept = Object.entries(usage).filter(([flow]) => !flows.includes(flow));
  const patch = { ...entry.patch };
  if (kept.length > 0) patch[USAGE_DATA] = Object.fromEntries(kept);
  else Reflect.deleteProperty(patch, USAGE_DATA);
  return { ...entry, patch };
}

/** Whether the save rules would write `patch` as it is. */
function keptBySaveRules(patch: Patch): boolean {
  const rules = applyPreferenceSaveRules(patch);
  return !('refused' in rules) && rules.dropped.length === 0;
}

/**
 * One entry for two consecutive ones of a route, or null when they may not
 * merge: two caller patches only when the rules would write their union as
 * sent, so no shape-guarded key is lost or gained. A key keeps the base its
 * first write had, and replays blind once a blind write set it.
 */
function mergeEntries(
  older: PreferenceOutboxEntry,
  newer: PreferenceOutboxEntry,
): PreferenceOutboxEntry | null {
  if (older.route !== newer.route) return null;
  const patch = applyPatch(older.patch, newer.patch);
  if (older.route === 'caller' && !keptBySaveRules(patch)) return null;
  const base: Patch = {};
  const baseOf = (entry: PreferenceOutboxEntry, key: string): boolean => {
    if (entry.base === undefined || !hasKey(entry.base, key)) return false;
    base[key] = entry.base[key];
    return true;
  };
  for (const key of Object.keys(patch)) {
    if (hasKey(newer.patch, key) && !hasKey(newer.base ?? {}, key)) continue;
    if (hasKey(older.patch, key)) baseOf(older, key);
    else baseOf(newer, key);
  }
  return {
    route: older.route,
    patch,
    ...(Object.keys(base).length > 0 && { base }),
  };
}

const touchesAny = (
  entries: readonly PreferenceOutboxEntry[],
  entry: PreferenceOutboxEntry,
): boolean =>
  entries.some((other) =>
    Object.keys(entry.patch).some((key) => hasKey(other.patch, key)),
  );

/**
 * Merges the oldest pair that may merge; null when none may. A pair need not
 * be neighbours: one moves to the other when no entry between them writes
 * its keys, which leaves every replay unchanged. So only saves of both routes
 * alternating on the same keys, or caller saves whose unions the rules would
 * change, can fill the bound.
 */
function mergeOldestPair(
  entries: readonly PreferenceOutboxEntry[],
): PreferenceOutboxEntry[] | null {
  for (let older = 0; older < entries.length; older += 1)
    for (let newer = older + 1; newer < entries.length; newer += 1) {
      const merged = mergeEntries(entries[older], entries[newer]);
      if (merged === null) continue;
      const before = entries.slice(0, older);
      const between = entries.slice(older + 1, newer);
      const after = entries.slice(newer + 1);
      if (!touchesAny(between, entries[newer]))
        return [...before, merged, ...between, ...after];
      if (!touchesAny(between, entries[older]))
        return [...before, ...between, merged, ...after];
    }
  return null;
}

interface PreferenceOutboxQueued {
  readonly file: PreferenceOutboxFile;
  /** False when the bound left no room: only the save's revocations are kept. */
  readonly queued: boolean;
}

/** Pure: the outbox with `revoked` kept, superseding queued choices of them. */
function keepRevocations(
  file: PreferenceOutboxFile,
  revoked: readonly string[],
): PreferenceOutboxFile {
  return {
    ...file,
    revocations: [...new Set([...file.revocations, ...revoked])],
    entries: file.entries
      .map((kept) => withoutFlows(kept, revoked))
      .filter((kept) => Object.keys(kept.patch).length > 0),
  };
}

/** Pure: the outbox after `entry` is queued. */
function queuePreferenceSave(
  file: PreferenceOutboxFile,
  entry: PreferenceOutboxEntry,
  maxEntries: number = PREFERENCE_OUTBOX_MAX_ENTRIES,
): PreferenceOutboxQueued {
  const held = keepRevocations(file, revokedFlows(entry.patch));
  let entries: PreferenceOutboxEntry[] | null = [...held.entries, entry];
  while (entries !== null && entries.length > Math.max(1, maxEntries))
    entries = mergeOldestPair(entries);
  return entries === null
    ? { file: held, queued: false }
    : { file: { ...held, entries }, queued: true };
}

/** Per sub-key: what the save changed from `was`, on top of `stored`. */
function mergeRecord(stored: Patch, was: Patch, value: Patch): Patch {
  const merged = { ...stored };
  for (const key of new Set([...Object.keys(was), ...Object.keys(value)])) {
    if (sameValue(was[key], value[key])) continue;
    if (hasKey(value, key)) merged[key] = value[key];
    else Reflect.deleteProperty(merged, key);
  }
  return merged;
}

/** The patch an entry replays onto the daemon's `latest`. */
function replayPreferenceOutboxEntry(
  latest: Patch,
  entry: PreferenceOutboxEntry,
): Patch {
  const replay: Patch = {};
  for (const [key, value] of Object.entries(entry.patch)) {
    if (entry.base === undefined || !hasKey(entry.base, key)) {
      replay[key] = value;
      continue;
    }
    const was = entry.base[key];
    const stored = latest[key] ?? null;
    if (sameValue(stored, was)) replay[key] = value;
    else if (isRecord(was) && isRecord(value) && isRecord(stored))
      replay[key] = mergeRecord(stored, was, value);
    // Otherwise another client changed the key after the save read it, and
    // a value derived from that older read must not overwrite the change.
  }
  return replay;
}

/**
 * The disk projection's read of the preferences row, read-only. Only the
 * primary proves authority, as the repository's `readAuthority` holds.
 */
export type PreferencesProjection =
  | {
      readonly kind: 'read';
      readonly source: 'primary' | 'lastGood';
      readonly preferences: Patch;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly denied: readonly string[] };

async function readEnvelope(
  path: string,
): Promise<Patch | 'missing' | 'unreadable'> {
  try {
    const record = readPreferencesEnvelopeRecord(
      parseJson(await readFile(path, 'utf8')),
    );
    return record ?? 'unreadable';
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

/** The preferences row's files the projection reads; the host resolves them. */
export interface PreferencesProjectionPaths {
  readonly document: string;
  readonly lastGood: string;
  readonly usageDataDenials: string;
}

/**
 * The stored preferences as the daemon last wrote them, never repaired or
 * written here (CAN-5573's projection-only fallback): the primary, else the
 * last-good copy, with the denial journal's revocations over it. The journal
 * reads as the daemon's does: unreadable or holding an unknown flow, it
 * denies every flow; held without a document, the document is unreadable.
 */
export async function readPreferencesProjection(
  paths: PreferencesProjectionPaths,
  usageDataKeys: readonly string[],
): Promise<PreferencesProjection> {
  let denied: readonly string[];
  try {
    const journal: unknown = JSON.parse(
      await readFile(paths.usageDataDenials, 'utf8'),
    );
    denied =
      isStringArray(journal) &&
      journal.every((flow) => usageDataKeys.includes(flow))
        ? journal
        : usageDataKeys;
  } catch (error) {
    denied = errorCode(error) === 'ENOENT' ? [] : usageDataKeys;
  }
  const revoked = revocationPatch(denied);
  const primary = await readEnvelope(paths.document);
  if (typeof primary !== 'string')
    return {
      kind: 'read',
      source: 'primary',
      preferences: applyPatch(primary, revoked),
    };
  const lastGood = await readEnvelope(paths.lastGood);
  if (typeof lastGood !== 'string')
    return {
      kind: 'read',
      source: 'lastGood',
      preferences: applyPatch(lastGood, revoked),
    };
  return primary === 'missing' && lastGood === 'missing' && denied.length === 0
    ? { kind: 'missing' }
    : { kind: 'unreadable', denied };
}

/**
 * A failure that proves nothing was sent: the daemon could not be reached.
 * An unknown outcome may have committed, so it is never queued.
 */
function isPreferencesDaemonUnavailable(error: unknown): boolean {
  return (
    !(error instanceof CanopyOutcomeUnknownError) &&
    toCanopyClientError(error).payload.kind === 'unavailable'
  );
}

/**
 * The `warn` the flip wires: CAN-5541's notice, once it enables the
 * `preferences` consumer with the daemon client.
 */
export function warnThroughDaemonHealth(
  health: Pick<ElectronDaemonHealth, 'noteFallback'>,
): () => void {
  return () => health.noteFallback('preferences', 'host_unavailable');
}

export interface PreferenceOutboxClientSeam<T extends object> {
  readonly hooks: DaemonPreferencesHooks<T>;
  readonly applyForeignCommit?: (
    commit: DaemonForeignCommit<T>,
  ) => Promise<void>;
}

export interface PreferenceOutboxPortOptions<T extends object> {
  /** Builds the daemon client with the hooks and commit consumer the outbox hands it. */
  readonly createClient: (
    seam: PreferenceOutboxClientSeam<T>,
  ) => DaemonPreferencesClient<T>;
  readonly hooks?: DaemonPreferencesHooks<T>;
  /** `applyForeignPreferenceCommit`; handed each commit with the queue over it. */
  readonly applyForeignCommit?: (
    commit: DaemonForeignCommit<T>,
  ) => Promise<void>;
  /** Overlays the stored record; `project` gives the runtime view of the result. */
  readonly codec: Pick<
    PreferencesCodec<T>,
    'defaults' | 'normalize' | 'project'
  >;
  readonly store: PreferenceOutboxStore;
  readonly readProjection: () => Promise<PreferencesProjection>;
  /** Every usage-data flow: a damaged outbox revokes them all. */
  readonly usageDataKeys: readonly string[];
  /** The in-memory deny (T15), before anything is written. */
  readonly denyUsageData?: (flows: readonly string[]) => void;
  /** CAN-5541's notice: a save was kept, or a read served from disk. */
  readonly warn: () => void;
  /** Calls `listener` once the daemon is reachable again; returns the unsubscribe. */
  readonly onReconnect?: (listener: () => void) => () => void;
  readonly maxEntries?: number;
  readonly log: { error(message: string, error?: unknown): void };
}

export interface PreferenceOutboxPort<
  T extends object,
> extends DaemonPreferencesClient<T> {
  /** Sends what is queued, in order, until it is empty or a send fails. */
  drain(): Promise<void>;
  /** Queued entries, revocations included; 0 when nothing is kept. */
  pending(): number;
}

/** The daemon refused the value itself: no resend can commit it. */
const isRefusedByDaemon = (error: unknown): boolean =>
  !(error instanceof CanopyOutcomeUnknownError) &&
  toCanopyClientError(error).payload.kind === 'invalid_argument';

/** As `core.config.document.update` refuses a key with its own owner. */
const refusedBySaveRules = (key: string): CanopyClientError =>
  new CanopyClientError({
    kind: 'invalid_argument',
    code: 'core.config.protectedKey',
    message: `${key} has its own owner and can't be saved here.`,
    retry: { kind: 'never' },
  });

// Only when no two queued saves of one route may merge (see mergeOldestPair).
// Not `unavailable`, which reads as a daemon this save could be queued for.
const outboxFull = (): CanopyClientError =>
  new CanopyClientError({
    kind: 'resource_exhausted',
    message:
      "Couldn't save this preference. Too many changes are already waiting for the background service.",
    retry: { kind: 'after_refresh', resource: 'core.config.document' },
  });

/** As the repository's and the client's refusal: callers match its `code`. */
class PreferenceOutboxRecoveryRequiredError extends Error {
  readonly code = 'PREFERENCES_RECOVERY_REQUIRED';
  constructor() {
    super('Preferences could not be read. Changes were not saved.');
  }
}

export function createPreferenceOutboxPort<T extends object>(
  options: PreferenceOutboxPortOptions<T>,
): PreferenceOutboxPort<T> {
  const { codec, store, hooks = {}, log } = options;
  const maxEntries = options.maxEntries ?? PREFERENCE_OUTBOX_MAX_ENTRIES;
  const noop = (): void => undefined;

  let state: PreferenceOutboxFile = EMPTY;
  let loading: Promise<void> | null = null;
  let draining = false;

  const queued = (): boolean =>
    state.revocations.length > 0 || state.entries.length > 0;
  const queuesUsageData = (): boolean =>
    state.revocations.length > 0 ||
    state.entries.some((entry) => hasKey(entry.patch, USAGE_DATA));

  const normalize = (record: Patch): T => codec.normalize(record, 'persisted');

  /** `value` as draining `file` would leave it. */
  function overlayWith(file: PreferenceOutboxFile, value: T): T {
    if (file.revocations.length === 0 && file.entries.length === 0)
      return value;
    let record = applyPatch(recordOf(value), revocationPatch(file.revocations));
    for (const entry of file.entries)
      record = applyPatch(record, replayPreferenceOutboxEntry(record, entry));
    return normalize(record);
  }
  const overlay = (value: T): T => overlayWith(state, value);

  function overlayCommit(
    commit: DaemonForeignCommit<T>,
  ): DaemonForeignCommit<T> | null {
    if (!queued()) return commit;
    const previous = overlay(commit.previous);
    const next = overlay(commit.next);
    const changedKeys = new Set(
      [...commit.changedKeys].filter(
        (key) => !sameValue(Reflect.get(previous, key), Reflect.get(next, key)),
      ),
    );
    return changedKeys.size === 0
      ? null
      : { ...commit, previous, next, changedKeys };
  }

  // The host sees the queue over every value the daemon hands it, and a
  // drain settles it once: an entry's own commit would undo those after it,
  // and confirm authority while a later one is still queued.
  const applyForeignCommit = options.applyForeignCommit;
  const client = options.createClient({
    hooks: {
      ...hooks,
      onSaveDurable: (change) => {
        if (!draining) hooks.onSaveDurable?.(change);
      },
      afterSave: async (change) => {
        if (!draining) await hooks.afterSave?.(change);
      },
      onCommitted: (next) => {
        if (!draining) hooks.onCommitted?.(next);
      },
    },
    ...(applyForeignCommit !== undefined && {
      applyForeignCommit: (commit: DaemonForeignCommit<T>): Promise<void> => {
        const seen = overlayCommit(commit);
        return seen === null ? Promise.resolve() : applyForeignCommit(seen);
      },
    }),
  });

  let tail: Promise<void> = Promise.resolve();
  function serial<R>(task: () => Promise<R>): Promise<R> {
    const run = tail.then(task);
    tail = run.then(noop, noop);
    return run;
  }

  /** Waits out every queued task, including one queued while it waited. */
  async function settled(): Promise<void> {
    for (let seen = tail; ; seen = tail) {
      await seen;
      if (seen === tail) return;
    }
  }

  type Base =
    | { readonly source: 'daemon'; readonly value: T }
    | { readonly source: 'disk'; readonly projection: PreferencesProjection };

  async function readBase(): Promise<Base> {
    try {
      return { source: 'daemon', value: await client.read('persisted') };
    } catch (error) {
      if (!isPreferencesDaemonUnavailable(error)) throw error;
    }
    options.warn();
    return { source: 'disk', projection: await options.readProjection() };
  }

  function baseValue(base: Base): T {
    if (base.source === 'daemon') return base.value;
    const { projection } = base;
    if (projection.kind === 'read') return normalize(projection.preferences);
    if (projection.kind === 'missing') return codec.defaults;
    return normalize(
      applyPatch(recordOf(codec.defaults), revocationPatch(projection.denied)),
    );
  }

  async function load(): Promise<void> {
    // Throws only when an unreadable file could not be set aside, so a file
    // that may hold saves is never overwritten.
    const read = await store.read();
    if (read.kind === 'read') {
      state = read.file;
    } else {
      // It may have held a revocation, which is never dropped.
      state = { ...EMPTY, revocations: options.usageDataKeys };
      await store.write(state).catch((error: unknown) => {
        log.error('The preference outbox could not be replaced.', error);
      });
    }
    if (!queued()) return;
    if (state.revocations.length > 0)
      options.denyUsageData?.(state.revocations);
    // An earlier run's saves: unconfirmed until they drain.
    const value = baseValue(await readBase());
    hooks.onSaveOutcomeUnknown?.({ previous: value, next: overlay(value) });
  }

  function loaded(): Promise<void> {
    loading ??= load().catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  }

  async function persist(next: PreferenceOutboxFile): Promise<void> {
    await store.write(next);
    state = next;
  }

  /** Inside a serial task only. Stops, keeping the rest, at the first failure. */
  async function drainNow(): Promise<void> {
    if (!queued()) return;
    let before: T;
    try {
      before = await client.read('persisted');
    } catch (error) {
      if (!isPreferencesDaemonUnavailable(error))
        log.error('Queued preference saves could not be sent.', error);
      return;
    }
    const shown = overlay(before);
    // Only the replayed keys, so the client diffs and judges the patch's
    // own shape, as when it was saved.
    const replay = (patch: (latest: Patch) => Patch): PreferencesUpdater<T> => {
      return (latest) => {
        const record = recordOf(latest);
        const keys = patch(record);
        const next = normalize(applyPatch(record, keys));
        const sent: Partial<T> = { ...next };
        for (const key of Object.keys(next))
          if (!hasKey(keys, key)) Reflect.deleteProperty(sent, key);
        for (const key of Object.keys(keys))
          if (!hasKey(next, key)) Reflect.set(sent, key, undefined);
        return sent;
      };
    };
    let sent = false;
    draining = true;
    try {
      if (state.revocations.length > 0) {
        const revocations = revocationPatch(state.revocations);
        await client.update(
          replay(() => revocations),
          undefined,
          { route: 'internal' },
        );
        await persist({ ...state, revocations: [] });
        sent = true;
      }
      while (state.entries.length > 0) {
        const [entry, ...rest] = state.entries;
        try {
          await client.update(
            replay((latest) => replayPreferenceOutboxEntry(latest, entry)),
            undefined,
            { route: entry.route },
          );
        } catch (error) {
          // Kept, it would hold every later save behind it.
          if (!isRefusedByDaemon(error)) throw error;
          log.error('The daemon refused a queued preference save.', error);
        }
        await persist({ ...state, entries: rest });
        sent = true;
      }
    } catch (error) {
      if (!isPreferencesDaemonUnavailable(error))
        log.error('Queued preference saves could not be sent.', error);
    } finally {
      draining = false;
    }
    if (!sent) return;
    const after = await client.read('persisted');
    if (!queued()) hooks.onSaveDurable?.({ previous: before, next: after });
    const change = { previous: shown, next: overlay(after) };
    await hooks.afterSave?.(change);
    hooks.onCommitted?.(change.next);
  }

  async function enqueue(
    updater: PreferencesUpdater<T>,
    onCommitted: ((committed: T) => void) | undefined,
    updateOptions: DomainPreferencesUpdateOptions,
  ): Promise<PortPreferencesChange<T>> {
    const read = await readBase();
    const stored = baseValue(read);
    const previous = overlay(stored);
    // No read proved the document: an unreadable projection, or a daemon read
    // the client holds latched (its legacy copy pending). Over the projection, `stored` is the codec's
    // defaults standing in for it: as the client on a cold cache, a
    // client-only save is answered on them, marked `unread`. Over the latched
    // daemon, as the client on a warm cache, it is refused. Every other save
    // is refused, as a latched repository refuses it, its revocations kept.
    const unproven =
      read.source === 'disk'
        ? read.projection.kind === 'unreadable'
        : client.isRecoveryLatched();
    const patch = await updater(previous);
    if (patch === null) {
      if (!unproven) return { previous, next: previous };
      if (read.source === 'disk' && updateOptions.isClientOnly?.() === true)
        return { previous, next: previous, unread: true };
      throw new PreferenceOutboxRecoveryRequiredError();
    }
    const document = recordOf(previous);
    const { route } = updateOptions;
    let sent = diffPatch(document, recordOf(patch));
    // A value the protocol refuses is this save's own error, never queued.
    if (Object.keys(sent).length > 0) ConfigDocumentPatchSchema.parse(sent);
    if (route === 'caller') {
      // The daemon's rules, as a live save of `sent` meets them.
      const rules = applyPreferenceSaveRules(sent);
      if ('refused' in rules) throw refusedBySaveRules(rules.refused);
      sent = rules.patch;
    }
    const revoked = revokedFlows(sent);
    if (unproven) {
      if (revoked.length > 0) {
        options.denyUsageData?.(revoked);
        await persist(keepRevocations(state, revoked));
        options.warn();
      }
      throw new PreferenceOutboxRecoveryRequiredError();
    }
    if (Object.keys(sent).length === 0) {
      const change = { previous, next: previous };
      await hooks.afterSave?.(change);
      hooks.onCommitted?.(previous);
      onCommitted?.(previous);
      return change;
    }
    const base: Patch = {};
    if (route === 'internal')
      for (const key of Object.keys(sent))
        if (key !== USAGE_DATA && !PROTECTED_KEYS.has(key))
          base[key] = document[key] ?? null;
    if (revoked.length > 0) options.denyUsageData?.(revoked);
    const entry = {
      route,
      patch: sent,
      ...(Object.keys(base).length > 0 && { base }),
    };
    const result = queuePreferenceSave(state, entry, maxEntries);
    const change = { previous, next: overlayWith(result.file, stored) };
    // The client's pre-commit steps, as before a send: a rejection keeps
    // nothing.
    await hooks.beforeSave?.(change);
    // As a failed preferences write in process: the save fails.
    await persist(result.file);
    options.warn();
    if (!result.queued) throw outboxFull();
    // Approval authority stays at its confirmed value, so a narrowing
    // applies at once and a widening only once it drains (T31).
    hooks.onSaveOutcomeUnknown?.(change);
    await hooks.afterSave?.(change);
    hooks.onCommitted?.(change.next);
    onCommitted?.(change.next);
    return change;
  }

  async function readAfterWrites(): Promise<Base> {
    await settled();
    await loaded();
    return readBase();
  }

  const drain = (): Promise<void> =>
    serial(async () => {
      await loaded();
      await drainNow();
    }).catch((error: unknown) =>
      log.error('Queued preference saves could not be sent.', error),
    );

  const unsubscribe = options.onReconnect?.(() => void drain()) ?? noop;

  return {
    update: (updater, onCommitted, updateOptions) =>
      serial(async () => {
        await loaded();
        await drainNow();
        if (!queued()) {
          try {
            // As the client answered it, `unread` included.
            return await client.update(updater, onCommitted, updateOptions);
          } catch (error) {
            if (!isPreferencesDaemonUnavailable(error)) throw error;
          }
        }
        return enqueue(updater, onCommitted, updateOptions);
      }),
    // The queue overlays the stored record, as the client caches it
    // (CAN-8045); a runtime read projects the result.
    read: async (view) => {
      const value = overlay(baseValue(await readAfterWrites()));
      return view === 'runtime' ? codec.project(value) : value;
    },
    readAuthority: async (readOptions = {}) => {
      const base = await readAfterWrites();
      if (base.source === 'daemon') {
        const read = await client.readAuthority(readOptions);
        if (!queued()) return read;
        const served = codec.project(overlay(base.value));
        if (read.authority === 'unreadable')
          return read.served === undefined ? read : { ...read, served };
        return { ...read, preferences: served, authority: 'ok' };
      }
      const { projection } = base;
      if (projection.kind === 'missing' && !queued())
        return { preferences: codec.defaults, authority: 'absent' };
      const served = codec.project(overlay(baseValue(base)));
      if (
        projection.kind === 'missing' ||
        (projection.kind === 'read' && projection.source === 'primary')
      )
        return { preferences: served, authority: 'ok' };
      // A corrupt or recovered document proves nothing, as in the repository.
      const unreadable: PreferencesAuthorityRead<T> = {
        preferences: codec.defaults,
        authority: 'unreadable',
      };
      return readOptions.includeServed === true
        ? { ...unreadable, served }
        : unreadable;
    },
    hasPersistedState: async () => {
      const base = await readAfterWrites();
      if (queued()) return true;
      return base.source === 'daemon'
        ? client.hasPersistedState()
        : base.projection.kind !== 'missing';
    },
    readStoredPayload: () => client.readStoredPayload(),
    stampGeneration: (isStopped) => client.stampGeneration(isStopped),
    flush: async () => {
      await settled();
      await client.flush();
    },
    idle: async () => {
      await settled();
      await client.idle();
    },
    isRecoveryLatched: () => client.isRecoveryLatched(),
    peekLoadError: () => client.peekLoadError(),
    acknowledgeLoadError: () => client.acknowledgeLoadError(),
    migrationTimestamp: () => client.migrationTimestamp(),
    resetForTests: () => {
      client.resetForTests();
      state = EMPTY;
      loading = null;
    },
    readLegacyClientLocal: () => client.readLegacyClientLocal(),
    // The daemon's stored choice is not the one a queued usage-data save
    // leaves, so it proves nothing until that drains.
    readStoredProductAnalyticsChoice: async () => {
      await settled();
      try {
        await loaded();
      } catch {
        return 'unconfirmed';
      }
      return queuesUsageData()
        ? 'unconfirmed'
        : client.readStoredProductAnalyticsChoice();
    },
    drain,
    pending: () =>
      state.entries.length + (state.revocations.length > 0 ? 1 : 0),
    dispose: () => {
      unsubscribe();
      client.dispose();
    },
  };
}
