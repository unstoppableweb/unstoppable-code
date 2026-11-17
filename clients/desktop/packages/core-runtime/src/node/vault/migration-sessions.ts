import { randomBytes, timingSafeEqual } from 'node:crypto';

import { CANOPY_SYSTEM_CLOCK, type CanopyDaemonClock } from '../daemon/leases';
import {
  migrationIdentityMismatch,
  type MigrationProcessIdentity,
} from './migration-platform';
import {
  MIGRATION_HOST_FIELDS,
  MIGRATION_LAUNCHER_TRANSPORT,
  MIGRATION_SLOTS_AT_PIN,
  MIGRATION_SLOT_ID_PATTERN,
  isMigrationImportResult,
  migrationSlotKey,
  readMigrationImportResult,
  sameMigrationSource,
  type MigrationAdmissionPort,
  type MigrationChannelFacts,
  type MigrationHostFacts,
  type MigrationHostOs,
  type MigrationImportPort,
  type MigrationImportResult,
  type MigrationSlotDefinition,
  type MigrationSourceIdentity,
  type MigrationSourcePort,
} from './migration-ports';

/*
 * Single-use migration sessions (ADR 7; CAN-4504 F5 T1–T18). VA-6b composes
 * this for qualification only; production migration remains disabled.
 *
 * issued -> pending -> completed | revoked | uncertain, or issued -> revoked.
 * A session reaches at most one terminal state. Once release may have
 * happened, failure is `uncertain` plus a fence on (slot key, generation),
 * never `revoked` or a re-issue. Release context comes only from the record.
 */

export const MIGRATION_OPERATION = 'import';
export const MIGRATION_PURPOSE = 'legacy-slot-import';

export type MigrationSessionState =
  | 'issued'
  | 'pending'
  | 'completed'
  | 'revoked'
  | 'uncertain';

type MigrationHostField = (typeof MIGRATION_HOST_FIELDS)[number];

export type MigrationChannelField =
  | 'transport'
  | 'channelId'
  | 'launcher.pid'
  | 'launcher.pidversion'
  | 'launcher.os'
  | 'launcher.identity'
  | 'launcherDigest'
  | 'source'
  | 'handle';

export type MigrationIssueRefusal =
  | 'closed'
  | 'no-native-evidence'
  | 'remote-or-unknown-transport'
  | 'host-unavailable'
  | `host:${MigrationHostField}`
  | 'unknown-slot'
  | 'slot-unavailable'
  | 'second-source'
  | 'slot-busy'
  | 'source-unavailable'
  | 'source:absent'
  | 'source:malformed'
  | 'source:unreadable'
  | 'source:outcome_unknown'
  | 'source-generation-fenced'
  | 'ambiguity:during-issue';

export type MigrationPresentationRefusal =
  | 'unknown-session'
  | `not-issued:${MigrationSessionState}`
  | 'expired'
  | 'no-native-evidence'
  | `binding:channel:${MigrationChannelField}`
  | 'binding:challenge'
  | 'binding:operation'
  | 'binding:purpose'
  | 'host-unavailable'
  | `binding:host:${MigrationHostField}`
  | 'source-unavailable'
  | 'binding:sourceGeneration';

export interface MigrationSessionOffer {
  readonly sessionId: string;
  readonly slot: string;
  readonly challenge: string;
  readonly operation: string;
  readonly purpose: string;
  readonly expiresAt: string;
}

export type MigrationIssueResult =
  | { readonly issued: true; readonly offer: MigrationSessionOffer }
  | { readonly issued: false; readonly reason: MigrationIssueRefusal };

export interface MigrationPresentation {
  /** The handle the frame arrived on, from the transport; never the payload. */
  readonly channel: object;
  readonly challenge: string;
  readonly operation: string;
  readonly purpose: string;
}

export interface MigrationReleaseContext {
  readonly slot: string;
  readonly source: MigrationSourceIdentity;
  readonly generation: string;
  readonly operation: string;
  /**
   * One-shot latch: true at most once, while the session may still release.
   * Call it synchronously at the release itself.
   */
  mayRelease(): boolean;
  /** Revalidate after an await; never grants a second release. */
  isCurrent(): boolean;
}

export type MigrationSessionOutcome<T> =
  | { readonly state: 'completed'; readonly value: T }
  | { readonly state: 'revoked' | 'uncertain'; readonly reason: string };

export type MigrationConsumeResult<T> =
  | {
      readonly accepted: true;
      /** Resolves once the session is terminal; never rejects. */
      readonly outcome: Promise<MigrationSessionOutcome<T>>;
    }
  | { readonly accepted: false; readonly reason: MigrationPresentationRefusal };

export type MigrationDeclineReason =
  | 'absent'
  | 'malformed'
  | 'unreadable'
  | 'outcome_unknown';

/** What the record binds; the challenge stays private to the registry. */
export interface MigrationSessionBinding {
  readonly sessionId: string;
  readonly channelId: string;
  readonly launcher: MigrationProcessIdentity;
  readonly launcherDigest: string;
  readonly source: MigrationSourceIdentity;
  readonly slot: string;
  readonly host: MigrationHostFacts;
  readonly sourceGeneration: string;
  readonly operation: string;
  readonly purpose: string;
  readonly expiresAt: number;
}

export interface MigrationSessionSnapshot {
  readonly state: MigrationSessionState;
  readonly reason: string | null;
  readonly released: boolean;
  readonly flagged: string | null;
  readonly slot: string;
  readonly source: MigrationSourceIdentity;
  readonly generation: string;
  readonly terminalTransitions: number;
  readonly history: readonly string[];
}

export interface MigrationSessionRegistryDeps {
  readonly admission: MigrationAdmissionPort;
  readonly source: MigrationSourcePort;
  readonly importer: MigrationImportPort;
  readonly clock?: CanopyDaemonClock;
}

export interface MigrationSessionRegistryOptions {
  /** Supplied by the host; this package reads no platform. */
  readonly os: MigrationHostOs;
  readonly slots?: readonly MigrationSlotDefinition[];
  /** How long an issued session may wait for its presentation. */
  readonly ttlMs?: number;
  /** How long a pending session may wait to settle before `uncertain`. */
  readonly settleMs?: number;
  /** Terminal records kept for `get`; live ones are bounded by slot count. */
  readonly maxRetainedSessions?: number;
}

export interface MigrationSessionRegistry {
  issue(channel: object, slot: string): MigrationIssueResult;
  /** Non-consuming admission; cannot release, select or mint a receipt. */
  preflight(
    sessionId: string,
    presentation: MigrationPresentation,
  ):
    | {
        readonly accepted: true;
        readonly source: MigrationSourceIdentity;
        readonly generation: string;
        readonly slot: string;
      }
    | {
        readonly accepted: false;
        readonly reason: MigrationPresentationRefusal;
      };
  /** `initiate` runs synchronously inside `consume`; `isResult` checks its fulfilment. */
  consume<T>(
    sessionId: string,
    presentation: MigrationPresentation,
    initiate: (context: MigrationReleaseContext) => unknown,
    isResult: (value: unknown) => value is T,
  ): MigrationConsumeResult<T>;
  /** Create-only import of `value`, zeroed once the import settles. */
  importSlot(
    sessionId: string,
    presentation: MigrationPresentation,
    value: Uint8Array,
  ): MigrationConsumeResult<MigrationImportResult>;
  decline(
    sessionId: string,
    presentation: MigrationPresentation,
    reason: MigrationDeclineReason,
  ):
    | { readonly accepted: true }
    | {
        readonly accepted: false;
        readonly reason: MigrationPresentationRefusal;
      };
  /** Revokes an issued session; flags a pending one and blocks its release. */
  revoke(sessionId: string, reason: string): boolean;
  /** As `revoke` for every live match; returns how many matched. */
  revokeWhere(
    match: (binding: MigrationSessionBinding) => boolean,
    reason: string,
  ): number;
  /** R-6: revokes issued sessions and flags pending ones. */
  reportAmbiguity(reason: string): void;
  /** Launcher exit: `revoked` before release, `uncertain` plus fence after. */
  endChannel(channel: object, reason: string): void;
  close(): void;
  get(sessionId: string): MigrationSessionSnapshot | null;
}

type Terminal = 'completed' | 'revoked' | 'uncertain';

interface SessionRecord {
  readonly channel: object;
  readonly binding: MigrationSessionBinding;
  readonly key: string;
  readonly challenge: Buffer;
  state: MigrationSessionState;
  reason: string | null;
  released: boolean;
  releaseBlocked: boolean;
  flagged: string | null;
  deadline: { cancel(): void } | null;
  terminalTransitions: number;
  readonly history: string[];
  notify:
    | ((outcome: {
        readonly state: 'revoked' | 'uncertain';
        readonly reason: string;
      }) => void)
    | null;
}

const MAX_HISTORY = 32;

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function slotCatalog(
  slots: readonly MigrationSlotDefinition[],
): ReadonlyMap<string, MigrationSlotDefinition> {
  const byId = new Map<string, MigrationSlotDefinition>();
  for (const slot of slots) {
    if (!MIGRATION_SLOT_ID_PATTERN.test(slot.id) || byId.has(slot.id))
      throw new RangeError(`Invalid or duplicate migration slot "${slot.id}".`);
    if (slot.platforms.length === 0)
      throw new RangeError(`Migration slot "${slot.id}" has no platform.`);
    byId.set(slot.id, slot);
  }
  return byId;
}

/** Port reads fail closed: a throwing port reads as unavailable. */
function read<T>(get: () => T): { readonly value: T } | null {
  try {
    return { value: get() };
  } catch {
    return null;
  }
}

function hostMismatch(
  expected: MigrationHostFacts,
  actual: MigrationHostFacts,
): MigrationHostField | null {
  for (const field of MIGRATION_HOST_FIELDS)
    if (expected[field] !== actual[field]) return field;
  return null;
}

function channelMismatch(
  record: SessionRecord,
  handle: object,
  facts: MigrationChannelFacts,
): MigrationChannelField | null {
  const bound = record.binding;
  if (facts.transport !== MIGRATION_LAUNCHER_TRANSPORT) return 'transport';
  if (facts.channelId !== bound.channelId) return 'channelId';
  const identity = migrationIdentityMismatch(bound.launcher, facts.launcher);
  if (identity !== null) return identity;
  if (facts.launcherDigest !== bound.launcherDigest) return 'launcherDigest';
  if (!sameMigrationSource(facts.source, bound.source)) return 'source';
  return handle === record.channel ? null : 'handle';
}

function sameChallenge(expected: Buffer, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const bytes = Buffer.from(presented, 'utf8');
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

function isLive(record: SessionRecord): boolean {
  return record.state === 'issued' || record.state === 'pending';
}

/** Helpers, not inline checks: narrowing would survive the port reads. */
function notIssued(record: SessionRecord): MigrationPresentationRefusal | null {
  return record.state === 'issued' ? null : `not-issued:${record.state}`;
}

function releasable(record: SessionRecord): boolean {
  return (
    record.state === 'pending' && !record.released && !record.releaseBlocked
  );
}

function note(record: SessionRecord, entry: string): void {
  if (record.history.length < MAX_HISTORY) record.history.push(entry);
}

export function createMigrationSessionRegistry(
  deps: MigrationSessionRegistryDeps,
  options: MigrationSessionRegistryOptions,
): MigrationSessionRegistry {
  const { admission, source, importer } = deps;
  const clock = deps.clock ?? CANOPY_SYSTEM_CLOCK;
  const ttlMs = positive('ttlMs', options.ttlMs ?? 60_000);
  const settleMs = positive('settleMs', options.settleMs ?? 30_000);
  const maxRetained = positive(
    'maxRetainedSessions',
    options.maxRetainedSessions ?? 64,
  );
  const slots = slotCatalog(options.slots ?? MIGRATION_SLOTS_AT_PIN);
  const sessions = new Map<string, SessionRecord>();
  /** Slots this process may have released, by source; survives pruning. */
  const claims = new Map<string, MigrationSourceIdentity>();
  /** Backs the durable fence when its write fails. */
  const localFences = new Set<string>();
  let closed = false;
  /** Bumped by issue, ambiguity, exit and close, for an in-flight issue. */
  let revision = 0;

  const fenceId = (key: string, generation: string): string =>
    JSON.stringify([key, generation]);

  const prune = (): void => {
    for (const [id, record] of Array.from(sessions)) {
      if (sessions.size <= maxRetained) return;
      if (!isLive(record)) sessions.delete(id);
    }
  };

  const settle = (
    record: SessionRecord,
    state: Terminal,
    reason: string,
  ): boolean => {
    if (!isLive(record)) {
      note(record, `late:${state}:${reason}`);
      return false;
    }
    record.deadline?.cancel();
    record.deadline = null;
    record.state = state;
    record.reason = reason;
    record.terminalTransitions += 1;
    note(record, `${state}:${reason}`);
    return true;
  };

  const fence = (record: SessionRecord): void => {
    const generation = record.binding.sourceGeneration;
    localFences.add(fenceId(record.key, generation));
    if (read(() => source.fence(record.key, generation)) === null)
      note(record, 'fence-failed');
  };

  const end = (
    record: SessionRecord,
    state: 'revoked' | 'uncertain',
    reason: string,
  ): void => {
    if (!settle(record, state, reason)) return;
    if (state === 'uncertain') fence(record);
    const notify = record.notify;
    record.notify = null;
    notify?.({ state, reason });
  };

  /** Expiry is checked on access, so a stale offer never holds its slot. */
  const expireIfDue = (record: SessionRecord): boolean => {
    if (record.state !== 'issued' || clock.now() < record.binding.expiresAt)
      return false;
    end(record, 'revoked', 'expired');
    return true;
  };

  /** Ends a session whose release may be in flight (exit, shutdown). */
  const abandon = (record: SessionRecord, reason: string): void => {
    if (record.state === 'issued') end(record, 'revoked', reason);
    else if (!record.released)
      end(record, 'revoked', `not-initiated:${reason}`);
    else end(record, 'uncertain', reason);
  };

  const flag = (record: SessionRecord, reason: string): void => {
    record.flagged = reason;
    if (!record.released) record.releaseBlocked = true;
    note(record, `flagged:${reason}`);
  };

  const revokeLive = (record: SessionRecord, reason: string): boolean => {
    if (record.state === 'issued') {
      end(record, 'revoked', reason);
      return true;
    }
    if (record.state === 'pending') flag(record, reason);
    return false;
  };

  /**
   * Issue, presentation and release each end with this read, then check only
   * registry state: a re-entrant retire, exit, close or ambiguity from any port
   * read, this one included, is seen before they commit.
   */
  const channelFacts = (handle: object): MigrationChannelFacts | null =>
    read(() => admission.channel(handle))?.value ?? null;

  const releaseBlocker = (record: SessionRecord): string | null => {
    const channelBlocker = (): string | null => {
      const facts = channelFacts(record.channel);
      if (facts === null) return 'no-native-evidence';
      const field = channelMismatch(record, record.channel, facts);
      return field === null ? null : `channel:${field}`;
    };
    const channel = channelBlocker();
    if (channel !== null) return channel;
    const host = read(() => admission.host());
    if (host === null) return 'host-unavailable';
    const field = hostMismatch(record.binding.host, host.value);
    if (field !== null) return `host:${field}`;
    const generation = read(() => source.currentGeneration(record.key));
    if (generation?.value !== record.binding.sourceGeneration)
      return 'sourceGeneration';
    return channelBlocker();
  };

  const releaseLatch =
    (record: SessionRecord): (() => boolean) =>
    (): boolean => {
      if (!releasable(record)) return false;
      const blocker =
        clock.now() >= record.binding.expiresAt
          ? 'expired'
          : releaseBlocker(record);
      if (blocker !== null) {
        record.releaseBlocked = true;
        note(record, `release-blocked:${blocker}`);
        return false;
      }
      // A port read above may have re-entered: ended, flagged or released.
      if (!releasable(record)) return false;
      record.released = true;
      claims.set(record.binding.slot, record.binding.source);
      note(record, 'released');
      return true;
    };

  const issueRefusal = (
    facts: MigrationChannelFacts,
    slot: string,
  ): MigrationIssueRefusal | null => {
    if (facts.transport !== MIGRATION_LAUNCHER_TRANSPORT)
      return 'remote-or-unknown-transport';
    const host = read(() => admission.host());
    if (host === null) return 'host-unavailable';
    const field = hostMismatch(facts.admittedHost, host.value);
    if (field !== null) return `host:${field}`;
    const definition = slots.get(slot);
    if (!definition) return 'unknown-slot';
    if (!definition.platforms.includes(options.os)) return 'slot-unavailable';
    return slotHolderRefusal(facts.source, slot);
  };

  const slotHolderRefusal = (
    from: MigrationSourceIdentity,
    slot: string,
  ): MigrationIssueRefusal | null => {
    const progress = read(() => source.slotProgress(slot));
    if (progress === null) return 'source-unavailable';
    const durable =
      progress.value.state === 'not_started' ? null : progress.value.source;
    // Either holder may disagree with the other; both must match `from`.
    for (const holder of [claims.get(slot), durable])
      if (holder && !sameMigrationSource(holder, from)) return 'second-source';
    for (const record of Array.from(sessions.values())) {
      if (record.binding.slot !== slot || expireIfDue(record)) continue;
      if (!isLive(record)) continue;
      return sameMigrationSource(record.binding.source, from)
        ? 'slot-busy'
        : 'second-source';
    }
    return null;
  };

  const generationFor = (
    key: string,
  ): { readonly generation: string } | MigrationIssueRefusal => {
    const generation = read(() => source.currentGeneration(key));
    if (generation === null) return 'source-unavailable';
    if (localFences.has(fenceId(key, generation.value)))
      return 'source-generation-fenced';
    const fenced = read(() => source.isFenced(key, generation.value));
    if (fenced === null) return 'source-unavailable';
    return fenced.value
      ? 'source-generation-fenced'
      : { generation: generation.value };
  };

  const record = (
    channel: object,
    facts: MigrationChannelFacts,
    slot: string,
    generation: string,
    expiresAt: number,
  ): MigrationSessionOffer => {
    revision += 1;
    const sessionId = randomBytes(16).toString('hex');
    const challenge = randomBytes(32).toString('base64url');
    const binding: MigrationSessionBinding = Object.freeze({
      sessionId,
      channelId: facts.channelId,
      launcher: Object.freeze({ ...facts.launcher }),
      launcherDigest: facts.launcherDigest,
      source: Object.freeze({ ...facts.source }),
      slot,
      host: Object.freeze({ ...facts.admittedHost }),
      sourceGeneration: generation,
      operation: MIGRATION_OPERATION,
      purpose: MIGRATION_PURPOSE,
      expiresAt,
    });
    sessions.set(sessionId, {
      channel,
      binding,
      key: migrationSlotKey(binding.source, slot),
      challenge: Buffer.from(challenge, 'utf8'),
      state: 'issued',
      reason: null,
      released: false,
      releaseBlocked: false,
      flagged: null,
      deadline: null,
      terminalTransitions: 0,
      history: ['issued'],
      notify: null,
    });
    prune();
    return {
      sessionId,
      slot,
      challenge,
      operation: binding.operation,
      purpose: binding.purpose,
      expiresAt: new Date(binding.expiresAt).toISOString(),
    };
  };

  const presentationRefusal = (
    record: SessionRecord,
    presentation: MigrationPresentation,
  ): MigrationPresentationRefusal | null => {
    const facts = channelFacts(presentation.channel);
    if (facts === null) return 'no-native-evidence';
    const channel = channelMismatch(record, presentation.channel, facts);
    if (channel !== null) return `binding:channel:${channel}`;
    if (!sameChallenge(record.challenge, presentation.challenge))
      return 'binding:challenge';
    if (presentation.operation !== record.binding.operation)
      return 'binding:operation';
    if (presentation.purpose !== record.binding.purpose)
      return 'binding:purpose';
    const host = read(() => admission.host());
    if (host === null) return 'host-unavailable';
    const field = hostMismatch(record.binding.host, host.value);
    if (field !== null) return `binding:host:${field}`;
    const generation = read(() => source.currentGeneration(record.key));
    if (generation === null) return 'source-unavailable';
    if (generation.value !== record.binding.sourceGeneration)
      return 'binding:sourceGeneration';
    const finalFacts = channelFacts(record.channel);
    if (finalFacts === null) return 'no-native-evidence';
    const finalChannel = channelMismatch(record, record.channel, finalFacts);
    return finalChannel === null ? null : `binding:channel:${finalChannel}`;
  };

  /** Single use: any failed presentation revokes the issued session. */
  const admit = (
    sessionId: string,
    presentation: MigrationPresentation,
  ): SessionRecord | MigrationPresentationRefusal => {
    const found = sessions.get(sessionId);
    if (!found) return 'unknown-session';
    const before = notIssued(found);
    if (before !== null) return before;
    if (expireIfDue(found)) return 'expired';
    const refusal = presentationRefusal(found, presentation);
    // A port read above may have re-entered and ended the session.
    const after = notIssued(found);
    if (after !== null) return after;
    if (refusal === null) return found;
    end(found, 'revoked', refusal);
    return refusal;
  };

  /** F5b r2 initiation: synchronous call, `then` read once, deadline armed first. */
  const initiate = <T>(
    session: SessionRecord,
    run: (context: MigrationReleaseContext) => unknown,
    isResult: (value: unknown) => value is T,
    resolve: (outcome: MigrationSessionOutcome<T>) => void,
  ): void => {
    session.notify = resolve;
    const fail = (reason: string): void =>
      session.released
        ? end(session, 'uncertain', reason)
        : end(session, 'revoked', `not-initiated:${reason}`);
    const fulfilled = (value: unknown): void => {
      if (!session.released) {
        end(session, 'revoked', 'not-initiated:fulfilled-without-release');
        return;
      }
      const recognized = read(() => (isResult(value) ? { value } : null));
      if (recognized === null || recognized.value === null) {
        end(session, 'uncertain', 'unrecognized-result');
        return;
      }
      if (!settle(session, 'completed', 'fulfilled')) return;
      session.notify = null;
      resolve({ state: 'completed', value: recognized.value.value });
    };
    const deadline = read(() =>
      clock.setTimer(
        () => end(session, 'uncertain', 'settlement-deadline'),
        settleMs,
      ),
    );
    if (deadline === null) {
      fail('deadline-unavailable');
      return;
    }
    session.deadline = deadline.value;
    const context: MigrationReleaseContext = Object.freeze({
      slot: session.binding.slot,
      source: session.binding.source,
      generation: session.binding.sourceGeneration,
      operation: session.binding.operation,
      mayRelease: releaseLatch(session),
      isCurrent: (): boolean => {
        const valid = releaseBlocker(session) === null;
        return (
          valid &&
          session.state === 'pending' &&
          session.released &&
          !session.flagged
        );
      },
    });
    let returned: unknown;
    try {
      returned = run(context);
    } catch {
      fail('sync-throw');
      return;
    }
    subscribe(returned, fulfilled, () => fail('rejected'), fail);
  };

  const consume = <T>(
    sessionId: string,
    presentation: MigrationPresentation,
    run: (context: MigrationReleaseContext) => unknown,
    isResult: (value: unknown) => value is T,
  ): MigrationConsumeResult<T> => {
    const admitted = admit(sessionId, presentation);
    if (typeof admitted === 'string')
      return { accepted: false, reason: admitted };
    admitted.state = 'pending';
    note(admitted, 'pending');
    const outcome = new Promise<MigrationSessionOutcome<T>>((resolve) =>
      initiate(admitted, run, isResult, resolve),
    );
    return { accepted: true, outcome };
  };

  return {
    consume,
    issue(channel, slot): MigrationIssueResult {
      if (closed) return { issued: false, reason: 'closed' };
      const start = revision;
      const facts = channelFacts(channel);
      if (facts === null)
        return { issued: false, reason: 'no-native-evidence' };
      const refusal = issueRefusal(facts, slot);
      if (refusal !== null) return { issued: false, reason: refusal };
      const generation = generationFor(migrationSlotKey(facts.source, slot));
      if (typeof generation === 'string')
        return { issued: false, reason: generation };
      const expiresAt = clock.now() + ttlMs;
      if (channelFacts(channel) === null || revision !== start)
        return { issued: false, reason: 'ambiguity:during-issue' };
      return {
        issued: true,
        offer: record(channel, facts, slot, generation.generation, expiresAt),
      };
    },
    importSlot(
      sessionId,
      presentation,
      value,
    ): MigrationConsumeResult<MigrationImportResult> {
      const zero = (): void => void value.fill(0);
      let handedOff = false;
      try {
        return consume(
          sessionId,
          presentation,
          (context) => {
            if (!context.mayRelease()) {
              zero();
              return Promise.resolve(undefined);
            }
            handedOff = true;
            const request = {
              slot: context.slot,
              source: context.source,
              generation: context.generation,
              value,
            };
            // A null copy fails `isMigrationImportResult`, so the session is
            // uncertain and fenced.
            return (async (): Promise<MigrationImportResult | null> => {
              try {
                return readMigrationImportResult(
                  await importer.createIfAbsent(request),
                );
              } finally {
                zero();
              }
            })();
          },
          isMigrationImportResult,
        );
      } finally {
        // Initiation is synchronous, so the importer has the value by now or
        // never will (refused, deadline unavailable, release blocked, throw).
        if (!handedOff) zero();
      }
    },
    preflight(sessionId, presentation) {
      const record = admit(sessionId, presentation);
      if (typeof record === 'string')
        return { accepted: false, reason: record };
      return {
        accepted: true,
        source: { ...record.binding.source },
        generation: record.binding.sourceGeneration,
        slot: record.binding.slot,
      };
    },
    decline(
      sessionId,
      presentation,
      reason,
    ): ReturnType<MigrationSessionRegistry['decline']> {
      const admitted = admit(sessionId, presentation);
      if (typeof admitted === 'string')
        return { accepted: false, reason: admitted };
      end(admitted, 'revoked', `declined:${reason}`);
      return { accepted: true };
    },
    revoke(sessionId, reason): boolean {
      const found = sessions.get(sessionId);
      return found ? revokeLive(found, reason) : false;
    },
    revokeWhere(match, reason): number {
      let matched = 0;
      for (const found of Array.from(sessions.values())) {
        if (!isLive(found) || !match(found.binding)) continue;
        matched += 1;
        revokeLive(found, reason);
      }
      return matched;
    },
    reportAmbiguity(reason): void {
      // Pending sessions are flagged, not ended; an unreleased one also loses
      // its release, since refusing ambiguity costs nothing before release.
      revision += 1;
      for (const found of Array.from(sessions.values()))
        revokeLive(found, reason);
    },
    endChannel(channel, reason): void {
      revision += 1;
      for (const found of Array.from(sessions.values()))
        if (found.channel === channel && isLive(found)) abandon(found, reason);
    },
    close(): void {
      closed = true;
      revision += 1;
      for (const found of Array.from(sessions.values()))
        if (isLive(found)) abandon(found, 'closed');
    },
    get(sessionId): MigrationSessionSnapshot | null {
      const found = sessions.get(sessionId);
      if (!found) return null;
      return {
        state: found.state,
        reason: found.reason,
        released: found.released,
        flagged: found.flagged,
        slot: found.binding.slot,
        source: found.binding.source,
        generation: found.binding.sourceGeneration,
        terminalTransitions: found.terminalTransitions,
        history: [...found.history],
      };
    },
  };
}

/**
 * Subscribes to a thenable, reading `then` exactly once (Promises/A+
 * 2.3.3.1) so a getter cannot change the classification between reads.
 */
function subscribe(
  returned: unknown,
  fulfilled: (value: unknown) => void,
  rejected: () => void,
  fail: (reason: string) => void,
): void {
  let then: unknown;
  try {
    then =
      (typeof returned === 'object' || typeof returned === 'function') &&
      returned !== null
        ? Reflect.get(returned, 'then')
        : undefined;
  } catch {
    fail('then-getter-threw');
    return;
  }
  if (typeof then !== 'function') {
    fail('non-thenable');
    return;
  }
  try {
    Reflect.apply(then, returned, [fulfilled, rejected]);
  } catch {
    fail('then-threw');
  }
}
