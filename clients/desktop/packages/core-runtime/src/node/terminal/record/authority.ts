import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { CANOPY_DEFAULT_MAX_FRAME_BYTES } from '@canopy/core-transport';
import { producerRunKey, setOwn } from './identity';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  WORKER_TERMINAL_LOST_SIGNAL,
  WORKER_TERMINAL_RECORD_WATERMARK_KEY_MAX_LENGTH,
  WorkerTerminalRecordShutdownParamsSchema,
  type WorkerTerminalRecordApplyParams,
  type WorkerTerminalRecordApplyResult,
  type WorkerTerminalRecordClient,
  type WorkerTerminalRecordHistoryReadParams,
  type WorkerTerminalRecordHistoryReadResult,
  type WorkerTerminalRecordOp,
  type WorkerTerminalRecordOpenResult,
  type WorkerTerminalRecordRetireParams,
  type WorkerTerminalRecordStoredSession,
} from '@canopy/protocol/canopy-core';
import type {
  PersistedTerminalEntry,
  TerminalKind,
  TerminalSession,
} from '@canopy/protocol/terminal';
import {
  appendScrollbackLines,
  isDrawerOwnedTerminal,
  isShutdownExitSignal,
} from './codec';
import {
  applyTerminalRecordOp,
  discontinuousOutput,
  markHistoryTruncated,
  mergePendingRecord,
  sessionMatchesScope,
  upsertRecordSession,
  validateTerminalRecordOp,
} from './ops';
import {
  TerminalLegacyUnreadableError,
  type TerminalRecordEnvelope,
  type TerminalRecordImportInput,
  type TerminalRecordRepository,
  type TerminalRecordPublication,
  type TerminalRecordTombstone,
} from './repository';

/** Installs coalesce per worktree, as main's writes did. */
const INSTALL_DEBOUNCE_MS = 100;
const INSTALL_RETRY_MS = 1_000;
const HISTORY_PAGE_DEFAULT_BYTES = 1024 * 1024;
/**
 * The transport sends a reply within its default frame unsplit, whatever the
 * peer negotiated; negotiation only adds larger, multi-part replies, and the
 * handler cannot see it. Headroom covers the JSON-RPC envelope.
 */
const HISTORY_PAGE_REPLY_BYTES = CANOPY_DEFAULT_MAX_FRAME_BYTES - 64 * 1024;
const MAX_UNATTRIBUTED = 256;

function nextCounter(value: number, counter: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    throw new CanopyOperationError({
      kind: 'resource_exhausted',
      message: `The terminal record ${counter} counter is exhausted.`,
      retry: { kind: 'never' },
      details: { reason: 'terminal_record_counter_exhausted', counter },
    });
  return value + 1;
}

export interface TerminalRecordAuthorityOptions {
  readonly repository: TerminalRecordRepository;
  readonly log?: (message: string, details: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly installDebounceMs?: number;
}

/** A daemon terminal the record attributes, from its revision 2 create or restore. */
export interface TerminalRecordAttribution {
  readonly terminalId: string;
  readonly client: WorkerTerminalRecordClient;
  /** The client's session, under the client's ids. */
  readonly session: TerminalSession;
  /** Its output belongs in the record: a drawer shell or script. */
  readonly persist: boolean;
}

interface Scope {
  readonly key: string;
  /** Authority-local order of lifetime creation; disk loads do not start one. */
  lifetimeVersion: bigint;
  envelope: TerminalRecordEnvelope;
  /** Working mutations never advance publication evidence. */
  pendingInstall: boolean;
  publication: TerminalRecordPublication<TerminalRecordEnvelope>;
  retirement?: {
    publication: Exclude<
      TerminalRecordPublication<TerminalRecordTombstone>,
      { state: 'unpublished' }
    >;
    /**
     * Physical cleanup owed by the fence: `inherited` debt read from disk is
     * retried and synced only if it removes something; `pending` debt of
     * this process's failed or unfinished cleanup always syncs on retry.
     */
    cleanup: 'settled' | 'inherited' | 'pending';
  };
  confirmationFailed: boolean;
  /** Published record evidence used to release reports, still awaiting sync. */
  dischargeDebt?: { generation?: number; lifetimeIds: Set<string> };
  /** Named coverage a preserved record gained, discharged once an install renames it. */
  unpublishedCoverage?: Set<string>;
  readonly shutdownStamps: Set<ShutdownStamp>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** A cursor cannot continue a snapshot from an earlier load or lifetime. */
  historyEpoch: string;
  /** Each terminal's history revision this daemon run, for paged reads. */
  readonly historyRevisions: Map<string, number>;
}

/** One stamped entry instance, not the terminal name a recreation can reuse. */
interface ShutdownStamp {
  readonly terminalId: string;
  readonly signal: string;
  readonly revision: number;
  /** A later revision replaces/removes this instance; it must be durable too. */
  supersededAt?: number;
}

type RetirementDecision =
  | {
      kind: 'preserved-record';
      lifetimeIds: readonly string[];
      acknowledged: 0 | 1;
      retryCleanup: boolean;
    }
  | {
      kind: 'already-covered';
      lifetimeIds: readonly string[];
      evidence: 'record' | 'fence';
      generation?: number;
    }
  | { kind: 'names-only'; lifetimeIds: readonly string[] }
  | { kind: 'generation'; lifetimeIds: readonly string[]; generation: number };

/** A public name selects a route; only this handle owns its reports. */
export type TerminalRecordRegistration = symbol;

interface RegistrationOwner {
  readonly key: TerminalRecordRegistration;
  readonly order: bigint;
  readonly attribution: TerminalRecordAttribution;
  readonly lifetime: DeferredLifetime;
  bound?: { readonly scopeKey: string; readonly generation: number };
  /** Retained on the predecessor even after the newer registration exits. */
  supersededGeneration?: number;
  /** Released on exit even if the replay obligation must remain. */
  decoder: StringDecoder | undefined;
  /** Its output meanwhile, bounded as the record bounds it. */
  lines: string[];
  /** Retention moved the start of `lines`: replay must not join their head. */
  historyTruncated?: true;
  shutdownSignal?: string;
  exit: { exitCode: number | null; signal: string | null } | null;
}

interface DeferredLifetime {
  /** Scope-local admission order, retained across compatible recreation. */
  readonly order: bigint;
  readonly requestedAt: number;
  admission:
    | {
        kind: 'admitted';
        readonly generation: number;
        readonly inheritedCoverage?: InheritedCoverage;
      }
    | {
        kind: 'unresolved';
        /** Undefined when the initial record read failed before admission. */
        readonly generation: number | undefined;
        readonly incarnation: string | null;
        readonly version: bigint;
        /** The predecessor this unversioned attribution intended to replace. */
        predecessor?: { generation: number; incarnation: string | null };
      };
}

interface InheritedCoverage {
  readonly lifetimeIds: ReadonlySet<string>;
  readonly fence: TerminalRecordTombstone | undefined;
}

/**
 * Names-only retirement covers the named lifetimes without fencing the
 * generation or destroying a record it does not name. An incarnation filter
 * only narrows it, never widens it.
 */
function namesOnlyRetirement(
  params: WorkerTerminalRecordRetireParams,
): boolean {
  return (
    params.lifetimeIds !== undefined &&
    params.generation === undefined &&
    params.requestedAt === undefined
  );
}

/**
 * Whether an unknown-generation lifetime was requested after a fence that
 * already satisfies this generation-bounded request: the fence's successor
 * intent, which a retry of that request must not widen to.
 */
function fenceSuccessor(
  params: WorkerTerminalRecordRetireParams,
  fence: TerminalRecordTombstone | undefined,
  lifetime: DeferredLifetime,
): boolean {
  return (
    params.generation !== undefined &&
    params.requestedAt === undefined &&
    fence !== undefined &&
    fence.namedOnly !== true &&
    fence.damaged !== true &&
    Number.isSafeInteger(fence.retiredAt) &&
    fence.generation >= params.generation &&
    fence.retiredAt < lifetime.requestedAt
  );
}

/** Whether a decision leaves the current record in place. */
function preservesRecord(decision: RetirementDecision): decision is
  | Extract<RetirementDecision, { kind: 'preserved-record' }>
  | (Extract<RetirementDecision, { kind: 'already-covered' }> & {
      evidence: 'record';
    }) {
  return (
    decision.kind === 'preserved-record' ||
    (decision.kind === 'already-covered' && decision.evidence === 'record')
  );
}

/** Whether a retirement names one of the record's own lifetimes. */
function retirementNames(
  params: WorkerTerminalRecordRetireParams,
  record: Pick<TerminalRecordEnvelope, 'lifetimeIds'>,
): boolean {
  return (
    params.lifetimeIds?.some((id) => record.lifetimeIds?.includes(id)) === true
  );
}

/** Admission fixes the destination; import lineage is only publication evidence. */
function deferredGeneration(lifetime: DeferredLifetime): number | undefined {
  const admission = lifetime.admission;
  return admission.kind === 'admitted'
    ? admission.generation
    : admission.predecessor
      ? nextCounter(admission.predecessor.generation, 'generation')
      : admission.generation;
}

interface AdmissionScope {
  order: bigint;
  transition: bigint;
  readonly waiting: Set<TerminalRecordRegistration>;
}

type AttributionResolution =
  | { kind: 'bound'; scope: Scope }
  | { kind: 'pending' }
  | { kind: 'retired'; scope: Scope };

type ReportDischarge =
  | {
      kind: 'retired';
      scope: Scope;
      covered?: ReadonlySet<DeferredLifetime>;
    }
  | { kind: 'capacity' };

/** A scope's state before any decision: what `admit` orders a request by. */
type Peek =
  | { kind: 'live'; scope: Scope }
  | {
      kind: 'tombstone';
      scope: Scope;
      generation: number;
      retiredLifetimeIds?: string[];
    }
  | { kind: 'none'; scope?: Scope };

/**
 * How a request is served: against the current record, or as stale (or a
 * read of a retired scope), answered with the record's or tombstone's
 * generation and changing nothing.
 */
type Admission =
  | { kind: 'current'; scope: Scope }
  | {
      kind: 'stale';
      generation: number;
      revision: number;
      /** Cold receipts stay uncached so an admitted retry still recovers. */
      scope?: Scope;
    };

/** Its legacy state is not imported yet (`import.pending`). */
function importPending(scope: Scope): boolean {
  return scope.envelope.import.pending === true;
}

function hasRecordContent(envelope: TerminalRecordEnvelope): boolean {
  return (
    envelope.record.terminals.length > 0 ||
    envelope.record.bindings.length > 0 ||
    Object.keys(envelope.record.terminalCustomNames).length > 0
  );
}

function scopeKey(projectId: string, worktreeId: string): string {
  return `${projectId}\u0000${worktreeId}`;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

const SESSION_KINDS: ReadonlySet<unknown> = new Set<TerminalKind>([
  'shell',
  'script',
  'claude-code',
  'claude-worker',
]);

function isTerminalKind(value: unknown): value is TerminalKind {
  return SESSION_KINDS.has(value);
}

/**
 * A session as `open` serves it: what main's legacy state holds beyond the
 * read schema (an unknown kind, a field of another type) is left out rather
 * than failing the whole read.
 */
function storedSessionOf(
  session: TerminalSession,
): WorkerTerminalRecordStoredSession {
  const {
    running,
    processName,
    initialCommand,
    kind,
    focusOnSpawn,
    title,
    chatId,
    sessionKey,
  } = session;
  return {
    id: session.id,
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    shell: session.shell,
    shellBasename: session.shellBasename,
    cwd: session.cwd,
    createdAt: session.createdAt,
    ...(typeof running === 'boolean' && { running }),
    ...((typeof processName === 'string' || processName === null) && {
      processName,
    }),
    ...(typeof initialCommand === 'string' && { initialCommand }),
    ...(isTerminalKind(kind) && { kind }),
    ...(typeof focusOnSpawn === 'boolean' && { focusOnSpawn }),
    ...(typeof title === 'string' && { title }),
    ...(typeof chatId === 'string' && { chatId }),
    ...(typeof sessionKey === 'string' && { sessionKey }),
  };
}

function stringValues(names: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(names).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function historyText(entry: PersistedTerminalEntry): string {
  return entry.scrollbackLines.join('\n');
}

/** The prefix of `text` that fits in `maxBytes` of UTF-8, never splitting a pair. */
function fitBytes(text: string, maxBytes: number): string {
  let chunk = text.slice(0, maxBytes);
  for (;;) {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    if (bytes <= maxBytes) break;
    chunk = chunk.slice(
      0,
      Math.max(1, Math.floor((chunk.length * maxBytes) / bytes) - 1),
    );
  }
  const last = chunk.charCodeAt(chunk.length - 1);
  if (chunk.length > 1 && last >= 0xd800 && last <= 0xdbff)
    chunk = chunk.slice(0, -1);
  return chunk;
}

/** UTF-8 bytes `JSON.stringify` emits for one code unit outside a pair. */
function jsonUnitBytes(unit: number): number {
  if (unit === 0x22 || unit === 0x5c) return 2;
  // \b \t \n \f \r; every other control character becomes \u00XX.
  if (unit < 0x20)
    return unit === 0x08 || (unit >= 0x09 && unit <= 0x0d && unit !== 0x0b)
      ? 2
      : 6;
  if (unit < 0x80) return 1;
  if (unit < 0x800) return 2;
  // A lone surrogate becomes \uXXXX.
  if (unit >= 0xd800 && unit <= 0xdfff) return 6;
  return 3;
}

/**
 * The prefix of `text` whose `JSON.stringify` body fits in `maxBytes` of
 * UTF-8, never splitting a pair; at least one code point, so reads progress.
 */
function fitJsonBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    const pair =
      unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    const cost = pair ? 4 : jsonUnitBytes(unit);
    if (index > 0 && bytes + cost > maxBytes) break;
    bytes += cost;
    index += pair ? 2 : 1;
  }
  return text.slice(0, index);
}

/**
 * The one writer of every worktree's terminal record (CAN-7051), in the
 * daemon's `worker.terminal` module and outside the PTY host. Daemon
 * terminals reach it through their host's reports; in-process terminals
 * through a producer's `apply` batches, at most once under the record's
 * watermarks. It reads main's legacy state once per scope, on the scope's
 * first write-authorized touch, and never writes it. Nothing here refuses a
 * write that used to succeed: a stale batch is dropped, a repeat is a
 * duplicate, and a failed install is retried.
 */
export class TerminalRecordAuthority {
  private readonly scopes = new Map<string, Scope>();

  private lifetimeVersion = 0n;
  private registrationVersion = 0n;

  private readonly registrations = new Map<
    TerminalRecordRegistration,
    RegistrationOwner
  >();
  private readonly currentByTerminalId = new Map<
    string,
    TerminalRecordRegistration
  >();

  /** Scopes reconciled this daemon run (CAN-7051 §5.11). */
  private readonly reconciled = new Set<string>();

  /** Admission order and held reports per scope, cached or cold. */
  private readonly admissions = new Map<string, AdmissionScope>();

  /**
   * The one owner of published fences whose directory sync is unconfirmed,
   * cached or cold: shutdown confirms each. A successful fence receipt or a
   * durable fence publication clears its scope.
   */
  private readonly unconfirmedFences = new Map<string, Scope>();

  private attributionTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly options: TerminalRecordAuthorityOptions,
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private log(message: string, details: Record<string, unknown>): void {
    this.options.log?.(message, details);
  }

  // ---------------------------------------------------------------------
  // Scopes
  // ---------------------------------------------------------------------

  /**
   * A record read from disk is kept in memory. Only write-authorized
   * touches recover damaged files; queries leave absent scopes uncached
   * so a later writer still gets to recover them, including behind a fence.
   */
  private peek(
    client: WorkerTerminalRecordClient,
    access: 'read' | 'recover' = 'read',
  ): Peek {
    const key = scopeKey(client.projectId, client.worktreeId);
    const existing = this.scopes.get(key);
    if (existing) return this.peekOwner(existing);
    const loaded = this.options.repository.load(
      client.projectId,
      client.worktreeId,
      access,
    );
    if (loaded.kind === 'absent' && !loaded.tombstone) return { kind: 'none' };
    const envelope =
      loaded.kind === 'record'
        ? loaded.envelope
        : this.options.repository.empty(
            {
              projectId: client.projectId,
              worktreeId: client.worktreeId,
              incarnation: loaded.tombstone?.incarnation ?? null,
              generation: Math.max(1, loaded.tombstone?.generation ?? 1),
            },
            'none',
          );
    const scope: Scope = {
      key,
      lifetimeVersion: 0n,
      envelope,
      pendingInstall: false,
      publication:
        loaded.kind === 'record'
          ? { state: 'published-unconfirmed', image: structuredClone(envelope) }
          : { state: 'unpublished', error: undefined },
      confirmationFailed: false,
      shutdownStamps: new Set(),
      timer: undefined,
      historyEpoch: randomUUID(),
      historyRevisions: new Map(),
      ...(loaded.tombstone
        ? {
            retirement: {
              publication: {
                state: 'published-unconfirmed' as const,
                image: loaded.tombstone,
              },
              cleanup:
                loaded.tombstone.cleanupFiles?.length === 0
                  ? ('settled' as const)
                  : ('inherited' as const),
            },
          }
        : {}),
    };
    if (loaded.kind === 'record' || access === 'recover') {
      this.scopes.set(key, scope);
      this.trackFenceConfirmation(scope);
    }
    return this.peekOwner(scope);
  }

  /** Registers a published fence still awaiting its directory sync. */
  private trackFenceConfirmation(scope: Scope): void {
    if (scope.retirement?.publication.state === 'published-unconfirmed')
      this.unconfirmedFences.set(scope.key, scope);
  }

  /** Whether a scope's fence is published and owes no directory sync. */
  private fenceConfirmed(scope: Scope): boolean {
    return (
      scope.retirement?.publication.state === 'durable' &&
      !this.unconfirmedFences.has(scope.key)
    );
  }

  private peekOwner(scope: Scope): Peek {
    const fence = scope.retirement?.publication.image;
    if (
      fence?.generation === 0 &&
      scope.lifetimeVersion === 0n &&
      scope.publication.state === 'unpublished'
    )
      return { kind: 'none', scope };
    return fence && fence.generation >= scope.envelope.generation
      ? {
          kind: 'tombstone',
          scope,
          generation: fence.generation,
          retiredLifetimeIds: fence.retiredLifetimeIds,
        }
      : { kind: 'live', scope };
  }

  /**
   * The one admission rule of every client request (CAN-7051 §5.7, §5.12).
   * Lifetimes are ordered by generation only: a request of an older one is
   * stale, and its reads are empty and its writes dropped, never an error.
   * The incarnation only tells a reused worktree id apart, since a
   * worktree's creation time can recur (a split or join copies it). A
   * request without a generation is trusted to be the current lifetime's:
   * the producer attaches the generation whenever it knows one, so only a
   * client that never saw this record omits it. Such a request of another
   * known incarnation is the successor of a reused worktree id, which
   * retires the record it replaces, unless it only reads. Reads never
   * create, retire, import or reconcile a record, and never import
   * behind a tombstone. By design, an old lifetime's request that omits its
   * generation can still reach that successor path; only the producer's
   * rules (a detached scope never sends, a generation is always attached
   * once known) keep it from doing so. Internally held reports instead use
   * `admitDeferredAttribution`, which never takes that successor path.
   */
  private admit(
    intent: 'open' | 'apply' | 'attribute' | 'read',
    client: WorkerTerminalRecordClient,
    generation: number | undefined = client.generation,
  ): Admission {
    // Fence admission is observational, even when recovery would fail.
    const observed = this.peek(client);
    const observedGeneration =
      observed.kind === 'live'
        ? observed.scope.envelope.generation
        : observed.kind === 'tombstone'
          ? observed.generation
          : undefined;
    const observedIds =
      observed.kind === 'live'
        ? observed.scope.envelope.retiredLifetimeIds
        : observed.scope?.retirement?.publication.image.retiredLifetimeIds;
    if (
      (client.lifetimeId !== undefined &&
        observedIds?.includes(client.lifetimeId)) ||
      (generation !== undefined &&
        observedGeneration !== undefined &&
        (generation < observedGeneration ||
          (observed.kind === 'tombstone' && generation === observedGeneration)))
    )
      return {
        kind: 'stale',
        generation: observedGeneration ?? 1,
        scope: observed.scope,
        revision:
          observed.kind === 'live' ? observed.scope.envelope.revision : 0,
      };
    const peeked = this.peek(client, intent === 'read' ? 'read' : 'recover');
    const retiredIds =
      peeked.kind === 'tombstone'
        ? peeked.retiredLifetimeIds
        : peeked.kind === 'live'
          ? peeked.scope.envelope.retiredLifetimeIds
          : peeked.scope?.retirement?.publication.image.retiredLifetimeIds;
    if (client.lifetimeId && retiredIds?.includes(client.lifetimeId))
      return {
        kind: 'stale',
        generation:
          peeked.kind === 'live'
            ? peeked.scope.envelope.generation
            : peeked.kind === 'tombstone'
              ? peeked.generation
              : 1,
        revision: 0,
      };
    if (peeked.kind === 'tombstone') {
      if (
        intent === 'read' ||
        (generation !== undefined && generation <= peeked.generation)
      )
        return { kind: 'stale', generation: peeked.generation, revision: 0 };
      const nextGeneration = nextCounter(peeked.generation, 'generation');
      this.receipt(peeked.scope, { kind: 'fence' });
      const successor = this.create(
        client,
        nextGeneration,
        false,
        peeked.retiredLifetimeIds,
      );
      return this.started(successor);
    }
    if (peeked.kind === 'none') {
      // Only a write-authorized touch may choose the one-time legacy source.
      if (intent === 'read')
        return { kind: 'stale', generation: 1, revision: 0 };
      return this.started(this.create(client, 1, true, retiredIds));
    }
    const { scope } = peeked;
    const { envelope } = scope;
    const stale = (): Admission => ({
      kind: 'stale',
      generation: envelope.generation,
      revision: envelope.revision,
    });
    if (generation !== undefined && generation < envelope.generation)
      return stale();
    const recorded = envelope.incarnation;
    const mismatched =
      client.incarnation !== null &&
      recorded !== null &&
      client.incarnation !== recorded;
    if (mismatched && generation === undefined) {
      if (intent === 'read') return stale();
      // A reused worktree id: the old worktree's record never carries over.
      this.log(
        'Terminal record belongs to an earlier worktree; starting fresh',
        {
          projectId: client.projectId,
        },
      );
      try {
        this.executeRetirement(
          scope,
          this.retirementDecision(
            scope,
            { ...envelope.scope, generation: envelope.generation },
            envelope,
            [],
            new Set(),
          ),
        );
      } catch (error) {
        // A durable logical fence permits reuse even if physical cleanup owes work.
        if (
          !this.fenceConfirmed(scope) ||
          !this.retirementCovers(scope, envelope.generation)
        )
          throw error;
        this.log('Terminal retirement cleanup remains pending', {
          code: errorCode(error),
        });
      }
      return this.started(
        this.create(
          client,
          nextCounter(envelope.generation, 'generation'),
          false,
          [
            ...(envelope.retiredLifetimeIds ?? []),
            ...(envelope.lifetimeIds ?? []),
          ],
        ),
      );
    }
    if (mismatched)
      // Same generation or newer, so not older: never refused, never retagged.
      this.log('Terminal record incarnation differs at its generation', {
        projectId: client.projectId,
      });
    else if (
      intent !== 'read' &&
      recorded === null &&
      client.incarnation !== null
    ) {
      envelope.incarnation = client.incarnation;
      this.markDirty(scope);
    }
    return this.current(scope, client, intent);
  }

  /**
   * A write retries a pending legacy import and reconciles daemon terminals
   * that died with an earlier daemon; read admission does neither.
   */
  private current(
    scope: Scope,
    client: WorkerTerminalRecordClient,
    intent: 'open' | 'apply' | 'attribute' | 'read',
  ): Admission {
    // A read-only reopen must not reinstall an unchanged record. The first
    // mutation commits its lifetime identity with the content it introduces.
    if (
      (intent === 'apply' || intent === 'attribute') &&
      client.lifetimeId &&
      !scope.envelope.lifetimeIds?.includes(client.lifetimeId)
    ) {
      scope.envelope.lifetimeIds = [
        ...(scope.envelope.lifetimeIds ?? []),
        client.lifetimeId,
      ];
      this.markDirty(scope);
    }
    if (intent !== 'read' && importPending(scope))
      this.retryImport(scope, client);
    if (intent !== 'read') this.reconcile(scope);
    return { kind: 'current', scope };
  }

  /** Replays may replace the owner in place or fence the same generation. */
  private revalidateAdmission(
    client: WorkerTerminalRecordClient,
    generation: number,
    inheritedCoverage?: InheritedCoverage,
  ): Admission {
    const scope = this.scopes.get(
      scopeKey(client.projectId, client.worktreeId),
    );
    // Explicit host recreation may inherit its own retired name. Only coverage
    // already accounted for by that admission can be bypassed, never a new fence.
    const inherited =
      inheritedCoverage !== undefined &&
      scope !== undefined &&
      this.coverageUnchanged(scope, inheritedCoverage);
    const admitted = this.admit(
      'read',
      inherited ? { ...client, lifetimeId: undefined } : client,
      generation,
    );
    if (
      admitted.kind === 'current' &&
      admitted.scope.envelope.generation !== generation
    )
      return {
        kind: 'stale',
        generation: admitted.scope.envelope.generation,
        revision: admitted.scope.envelope.revision,
      };
    return admitted;
  }

  /** Whether a scope's coverage is still exactly what an admission inherited. */
  private coverageUnchanged(
    scope: Scope,
    inheritedCoverage: InheritedCoverage,
  ): boolean {
    const current = new Set(scope.envelope.retiredLifetimeIds);
    return (
      scope.retirement?.publication.image === inheritedCoverage.fence &&
      current.size === inheritedCoverage.lifetimeIds.size &&
      Array.from(current).every((id): boolean =>
        inheritedCoverage.lifetimeIds.has(id),
      )
    );
  }

  /**
   * Whether a registration's own retired name was accounted for by its
   * admission, so it is no new coverage of it. A bound handle's inheritance
   * was confirmed when it bound: only a fence of its generation reaches it,
   * never a later retirement of other names. An admission still binding keeps
   * it only while the scope's coverage is unchanged.
   */
  private inheritedName(
    scope: Scope,
    owner: RegistrationOwner,
    lifetimeId: string,
  ): boolean {
    const admission = owner.lifetime.admission;
    if (
      admission.kind !== 'admitted' ||
      admission.inheritedCoverage?.lifetimeIds.has(lifetimeId) !== true
    )
      return false;
    return (
      owner.bound?.scopeKey === scope.key ||
      this.coverageUnchanged(scope, admission.inheritedCoverage)
    );
  }

  /** A record this request just created: its import was just tried. */
  private started(scope: Scope): Admission {
    this.reconcile(scope);
    return { kind: 'current', scope };
  }

  /**
   * A new lifetime's record, installed at once: imported from the legacy
   * state on the scope's first write-authorized touch, else empty behind its
   * tombstone.
   */
  private create(
    client: WorkerTerminalRecordClient,
    generation: number,
    importLegacy: boolean,
    retiredLifetimeIds?: string[],
  ): Scope {
    const { projectId, worktreeId } = client;
    const input: TerminalRecordImportInput = {
      projectId,
      worktreeId,
      layout: client.legacyLayout,
      incarnation: client.incarnation,
      generation,
    };
    const envelope = importLegacy
      ? (this.importLegacy(input) ?? this.pendingImport(input))
      : this.options.repository.empty(input, 'none');
    envelope.lifetimeIds = client.lifetimeId ? [client.lifetimeId] : [];
    envelope.retiredLifetimeIds = retiredLifetimeIds;
    const previous = this.scopes.get(scopeKey(projectId, worktreeId));
    const scope: Scope = {
      key: scopeKey(projectId, worktreeId),
      lifetimeVersion: (this.lifetimeVersion += 1n),
      envelope,
      pendingInstall: true,
      publication: { state: 'unpublished', error: undefined },
      confirmationFailed: false,
      unpublishedCoverage: undefined,
      shutdownStamps: new Set(),
      ...(previous?.retirement ? { retirement: previous.retirement } : {}),
      timer: undefined,
      historyEpoch: randomUUID(),
      historyRevisions: new Map(),
    };
    // Preserve the per-scope owner across lifetime replacement and cleanup debt.
    const owner = previous ? Object.assign(previous, scope) : scope;
    this.scopes.set(owner.key, owner);
    this.installNow(owner);
    return owner;
  }

  /**
   * The legacy state imported with its backup written, else `null`: an
   * unreadable source or a backup that could not be written is retried,
   * never imported empty, and the source is never fenced meanwhile.
   */
  private importLegacy(
    input: TerminalRecordImportInput,
  ): TerminalRecordEnvelope | null {
    try {
      return this.options.repository.importLegacy(input);
    } catch (error) {
      if (!(error instanceof TerminalLegacyUnreadableError))
        this.log('Could not import legacy terminal state; retrying', {
          code: errorCode(error),
        });
      return null;
    }
  }

  /**
   * An empty record marked `import.pending`, installed like any other so
   * what daemon terminals report meanwhile survives the daemon; a reader
   * never fences the legacy state behind it.
   */
  private pendingImport(
    input: TerminalRecordImportInput,
  ): TerminalRecordEnvelope {
    const envelope = this.options.repository.empty(input, 'none');
    return { ...envelope, import: { ...envelope.import, pending: true } };
  }

  /**
   * Imports a pending scope's legacy state once it can be read, with what
   * daemon terminals reported meanwhile laid over it, and installs it. The
   * record reads as imported only once that install lands.
   */
  private retryImport(scope: Scope, client: WorkerTerminalRecordClient): void {
    const pending = scope.envelope;
    // Exhaustion leaves the pending snapshot readable, never an import receipt.
    if (pending.revision === Number.MAX_SAFE_INTEGER) return;
    const revision = nextCounter(pending.revision, 'revision');
    const imported = this.importLegacy({
      projectId: pending.scope.projectId,
      worktreeId: pending.scope.worktreeId,
      layout: client.legacyLayout,
      incarnation: pending.incarnation,
      generation: pending.generation,
    });
    if (!imported) return;
    const record = mergePendingRecord(imported.record, pending.record);
    const historyRevisions = new Map(scope.historyRevisions);
    for (const entry of record.terminals) {
      const id = entry.session.id;
      historyRevisions.set(
        id,
        nextCounter(historyRevisions.get(id) ?? 0, 'history revision'),
      );
    }
    scope.envelope = {
      ...imported,
      // The lifetime started with the pending record, not with its import.
      startedAt: pending.startedAt,
      lifetimeIds: pending.lifetimeIds,
      retiredLifetimeIds: pending.retiredLifetimeIds,
      record,
      producerWatermarks: { ...pending.producerWatermarks },
      runs: { ...pending.runs },
      hostTerminals: Array.from(
        new Set([...imported.hostTerminals, ...pending.hostTerminals]),
      ),
      revision,
    };
    // Every history now reads differently: a paged reader restarts.
    for (const [id, revision] of historyRevisions)
      scope.historyRevisions.set(id, revision);
    scope.pendingInstall = true;
    this.installNow(scope);
  }

  /**
   * Producer batches wait until the legacy state is imported: their forgets
   * and layouts are meant for the imported terminals. The producer keeps
   * them in its outbox meanwhile.
   */
  private assertImported(scope: Scope): void {
    if (importPending(scope))
      throw new Error('The terminal record is waiting on its legacy import.');
  }

  /** Stamps daemon terminals of an earlier daemon run that never reported an exit. */
  private reconcile(scope: Scope): void {
    if (this.reconciled.has(scope.key)) return;
    this.reconciled.add(scope.key);
    const { envelope } = scope;
    const stale = envelope.hostTerminals.filter((id): boolean => {
      return !this.boundOwner(scope, id);
    });
    if (stale.length === 0) return;
    for (const terminalId of stale) {
      const entry = this.entry(envelope, terminalId);
      if (entry && entry.exitCode === null && entry.signal === null)
        entry.signal = WORKER_TERMINAL_LOST_SIGNAL;
    }
    envelope.hostTerminals = envelope.hostTerminals.filter(
      (id) => !stale.includes(id),
    );
    this.markDirty(scope);
  }

  private entry(
    envelope: TerminalRecordEnvelope,
    terminalId: string,
  ): PersistedTerminalEntry | undefined {
    return envelope.record.terminals.find(
      (candidate) => candidate.session.id === terminalId,
    );
  }

  private bumpHistory(scope: Scope, terminalId: string): void {
    scope.historyRevisions.set(
      terminalId,
      nextCounter(
        scope.historyRevisions.get(terminalId) ?? 0,
        'history revision',
      ),
    );
  }

  private supersedeShutdownStamps(
    scope: Scope,
    terminalId: string,
    revision: number,
  ): void {
    for (const stamp of scope.shutdownStamps)
      if (stamp.terminalId === terminalId && stamp.supersededAt === undefined)
        stamp.supersededAt = revision;
  }

  private markDirty(scope: Scope): void {
    scope.pendingInstall = true;
    this.scheduleInstall(
      scope,
      this.options.installDebounceMs ?? INSTALL_DEBOUNCE_MS,
    );
  }

  private scheduleInstall(scope: Scope, delay: number): void {
    if (scope.timer !== undefined || this.peekOwner(scope).kind !== 'live')
      return;
    scope.timer = setTimeout(() => {
      scope.timer = undefined;
      this.installNow(scope);
    }, delay);
    scope.timer.unref?.();
  }

  private installNow(scope: Scope): boolean {
    if (scope.timer !== undefined) clearTimeout(scope.timer);
    scope.timer = undefined;
    if (this.peekOwner(scope).kind !== 'live') return false;
    const publication = this.options.repository.publishRecord(scope.envelope);
    // A failed replacement cannot turn the previous committed image into evidence
    // for the working image. Post-rename failure retains the exact candidate.
    if (publication.state !== 'unpublished') {
      scope.publication = publication;
      this.dischargePublishedCoverage(scope, publication.image);
    }
    scope.pendingInstall = publication.state !== 'durable';
    scope.confirmationFailed = false;
    if (publication.state === 'durable') return true;
    this.log('Failed to install a terminal record; retrying', {
      code: errorCode(publication.error),
    });
    this.scheduleInstall(scope, INSTALL_RETRY_MS);
    return false;
  }

  /**
   * The one discharge of a preserved record's named coverage, on whichever
   * path renames it (retirement, timer or flush). Before the rename its
   * handles stay writable: a refused report would be lost.
   */
  private dischargePublishedCoverage(
    scope: Scope,
    image: TerminalRecordEnvelope,
  ): void {
    const awaiting = scope.unpublishedCoverage;
    if (
      !awaiting ||
      image.generation !== scope.envelope.generation ||
      image.lineage !== scope.envelope.lineage ||
      Array.from(awaiting).some(
        (id): boolean => image.retiredLifetimeIds?.includes(id) !== true,
      )
    )
      return;
    try {
      this.rememberRetiredLifetime(scope);
      scope.unpublishedCoverage = undefined;
    } catch (error) {
      // The next install retries; meanwhile the handles stay writable.
      this.log('Could not discharge published terminal coverage; retrying', {
        code: errorCode(error),
      });
    }
  }

  /** The only gate for results that let callers discard a replay copy. */
  private receipt(
    scope: Scope,
    effect:
      | { kind: 'record'; producer?: string; seq?: number }
      | {
          kind: 'coverage';
          generation?: number;
          lifetimeIds?: readonly string[];
        }
      | {
          kind: 'fence';
          cleanup?: boolean;
          generation?: number;
          lifetimeIds?: readonly string[];
        }
      | { kind: 'shutdown'; stamp: ShutdownStamp }
      | { kind: 'import' },
  ): TerminalRecordEnvelope {
    const { projectId, worktreeId } = scope.envelope.scope;
    if (effect.kind === 'fence') {
      const retirement = scope.retirement;
      if (!retirement)
        throw new Error('The terminal retirement has not been published.');
      if (
        !this.retirementCovers(
          scope,
          effect.generation ?? 0,
          effect.lifetimeIds,
        )
      )
        throw new Error(
          'The terminal retirement fence does not cover the request.',
        );
      if (
        retirement.publication.state !== 'durable' ||
        this.unconfirmedFences.has(scope.key)
      ) {
        this.options.repository.confirmDurability(projectId, worktreeId);
        retirement.publication = {
          state: 'durable',
          image: retirement.publication.image,
        };
        // The sync covers every rename of this directory before it.
        this.unconfirmedFences.delete(scope.key);
      }
      // After confirmation: a deletion must never outlive an unsynced fence.
      if (effect.cleanup && retirement.cleanup !== 'settled') {
        this.options.repository.retryRetirement(
          projectId,
          worktreeId,
          retirement.cleanup === 'pending',
        );
        retirement.cleanup = 'settled';
      }
      return scope.envelope;
    }
    const publication = scope.publication;
    if (
      publication.state === 'unpublished' ||
      this.peekOwner(scope).kind !== 'live'
    )
      throw new Error('The terminal record has no published receipt.');
    if (
      publication.image.generation !== scope.envelope.generation ||
      publication.image.lineage !== scope.envelope.lineage
    )
      throw new Error(
        'The terminal record receipt belongs to another lifetime.',
      );
    if (
      effect.kind === 'coverage' &&
      !this.recordCovers(
        publication.image,
        effect.generation,
        effect.lifetimeIds,
      )
    )
      throw new Error('The terminal record has no published coverage receipt.');
    if (publication.state !== 'durable') {
      this.options.repository.confirmDurability(projectId, worktreeId);
      scope.publication = { state: 'durable', image: publication.image };
      scope.confirmationFailed = false;
    }
    const image = publication.image;
    if (
      effect.kind === 'record' &&
      effect.producer !== undefined &&
      (image.producerWatermarks[effect.producer] ?? 0) < (effect.seq ?? 0)
    )
      throw new Error('The terminal producer batch has no durable receipt.');
    if (
      effect.kind === 'import' &&
      (image.import.pending || scope.pendingInstall)
    )
      throw new Error('The terminal import has no durable receipt.');
    if (
      effect.kind === 'shutdown' &&
      (image.revision < (effect.stamp.supersededAt ?? effect.stamp.revision) ||
        (effect.stamp.supersededAt === undefined &&
          this.entry(image, effect.stamp.terminalId)?.signal !==
            effect.stamp.signal))
    )
      throw new Error('The terminal shutdown stamp has no durable receipt.');
    return image;
  }

  private visibleReceipt(scope: Scope): TerminalRecordEnvelope | undefined {
    if (scope.confirmationFailed) return undefined;
    try {
      return this.receipt(scope, { kind: 'record' });
    } catch (error) {
      scope.confirmationFailed = true;
      this.log(
        'Terminal record durability is unconfirmed; serving visible history',
        { code: errorCode(error) },
      );
      return undefined;
    }
  }

  private retirementCovers(
    scope: Scope,
    generation: number,
    lifetimeIds: readonly string[] = [],
  ): boolean {
    const fence = scope.retirement?.publication.image;
    return (
      fence !== undefined &&
      fence.generation >= generation &&
      lifetimeIds.every((id) => fence.retiredLifetimeIds?.includes(id))
    );
  }

  private recordCovers(
    image: TerminalRecordEnvelope,
    generation?: number,
    lifetimeIds: readonly string[] = [],
  ): boolean {
    return (
      (generation === undefined || image.generation > generation) &&
      lifetimeIds.every(
        (id): boolean => image.retiredLifetimeIds?.includes(id) === true,
      )
    );
  }

  private retiredIds(scope: Scope, ids: readonly string[]): string[] {
    return Array.from(
      new Set([
        ...(scope.envelope.retiredLifetimeIds ?? []),
        ...(scope.retirement?.publication.image.retiredLifetimeIds ?? []),
        ...ids,
      ]),
    );
  }

  /** A preserved successor publishes named coverage without changing its lifetime. */
  private publishRetiredCoverage(
    scope: Scope,
    lifetimeIds: readonly string[],
  ): void {
    const ids = this.retiredIds(scope, lifetimeIds);
    const added = ids.filter(
      (id): boolean => !scope.envelope.retiredLifetimeIds?.includes(id),
    );
    if (added.length > 0) {
      scope.envelope.retiredLifetimeIds = ids;
      scope.unpublishedCoverage = new Set([
        ...(scope.unpublishedCoverage ?? []),
        ...added,
      ]);
      this.markDirty(scope);
    }
    // Only the immutable published image can release reports, even after rename.
    if (scope.pendingInstall) this.installNow(scope);
    // A retry resumes a discharge that failed after an earlier rename.
    if (scope.publication.state !== 'unpublished')
      this.dischargePublishedCoverage(scope, scope.publication.image);
  }

  private recordDischarge(
    scope: Scope,
    generation?: number,
    lifetimeIds: readonly string[] = [],
  ): boolean {
    const publication = scope.publication;
    if (
      publication.state === 'unpublished' ||
      this.peekOwner(scope).kind !== 'live' ||
      publication.image.generation !== scope.envelope.generation ||
      publication.image.lineage !== scope.envelope.lineage ||
      !this.recordCovers(publication.image, generation, lifetimeIds)
    )
      return false;
    if (publication.state !== 'durable') {
      const debt = (scope.dischargeDebt ??= { lifetimeIds: new Set() });
      if (generation !== undefined)
        debt.generation = Math.max(debt.generation ?? 0, generation);
      for (const id of lifetimeIds) debt.lifetimeIds.add(id);
    }
    return true;
  }

  private confirmDischarges(scope: Scope): void {
    const debt = scope.dischargeDebt;
    if (!debt) return;
    const lifetimeIds = Array.from(debt.lifetimeIds);
    if (this.retirementCovers(scope, debt.generation ?? 0, lifetimeIds))
      this.receipt(scope, {
        kind: 'fence',
        generation: debt.generation,
        lifetimeIds,
      });
    else
      this.receipt(scope, {
        kind: 'coverage',
        generation: debt.generation,
        lifetimeIds,
      });
    scope.dischargeDebt = undefined;
  }

  /** Select effects once; publication and retries cannot widen this decision. */
  private retirementDecision(
    scope: Scope,
    params: WorkerTerminalRecordRetireParams,
    record: TerminalRecordEnvelope | undefined,
    lifetimeIds: readonly string[],
    covered: ReadonlySet<DeferredLifetime>,
  ): RetirementDecision {
    const namedOnly = namesOnlyRetirement(params);
    lifetimeIds = this.retiredIds(scope, lifetimeIds);
    const generation =
      record?.generation ?? scope.retirement?.publication.image.generation ?? 0;
    const incarnation = record?.incarnation ?? null;
    const identified =
      record !== undefined &&
      (retirementNames(params, record) || params.generation === generation);
    // A generation-only retry behind a successor still finishes its fence's
    // cleanup; the successor is preserved, so it acknowledges nothing.
    const generationCleanup =
      params.lifetimeIds === undefined &&
      params.generation !== undefined &&
      generation > params.generation &&
      scope.retirement !== undefined &&
      scope.retirement.cleanup !== 'settled' &&
      this.retirementCovers(scope, params.generation) &&
      (params.incarnation == null ||
        scope.retirement.publication.image.incarnation === null ||
        params.incarnation === scope.retirement.publication.image.incarnation);
    if (
      record &&
      params.lifetimeIds?.length &&
      params.lifetimeIds.every((id) =>
        record.retiredLifetimeIds?.includes(id),
      ) &&
      (params.generation === undefined ||
        generation > params.generation ||
        this.retirementCovers(scope, params.generation))
    )
      return { kind: 'already-covered', evidence: 'record', lifetimeIds };
    // Another incarnation's record is narrowed out before names-only coverage.
    if (
      record &&
      params.incarnation != null &&
      incarnation !== null &&
      params.incarnation !== incarnation
    )
      return {
        kind: 'preserved-record',
        lifetimeIds,
        acknowledged: 0,
        retryCleanup: generationCleanup,
      };
    if (record && namedOnly && !identified)
      return {
        kind: 'preserved-record',
        lifetimeIds,
        acknowledged: 1,
        retryCleanup: true,
      };
    if (
      (params.generation !== undefined &&
        record &&
        generation > params.generation) ||
      (params.requestedAt !== undefined &&
        !identified &&
        record &&
        (record.startedAt === undefined ||
          record.startedAt >= params.requestedAt))
    )
      return {
        kind: 'preserved-record',
        lifetimeIds,
        acknowledged: 0,
        retryCleanup: generationCleanup,
      };
    const ids = this.retiredIds(scope, [
      ...(record?.lifetimeIds ?? []),
      ...lifetimeIds,
    ]);
    // With no record and no held lifetime reached, a cutoff must not fence the
    // scope's later reports or legacy import.
    const reachesNothing =
      covered.size === 0 &&
      params.generation === undefined &&
      params.requestedAt !== undefined;
    if (!record && (namedOnly || reachesNothing))
      return this.retirementCovers(scope, 0, ids)
        ? { kind: 'already-covered', evidence: 'fence', lifetimeIds: ids }
        : { kind: 'names-only', lifetimeIds: ids };
    const fenceGeneration = Math.max(
      generation,
      scope.envelope.generation,
      params.generation ?? 1,
      1,
      ...Array.from(covered, (lifetime) => deferredGeneration(lifetime) ?? 1),
    );
    return this.retirementCovers(scope, fenceGeneration, ids)
      ? {
          kind: 'already-covered',
          evidence: 'fence',
          generation: fenceGeneration,
          lifetimeIds: ids,
        }
      : { kind: 'generation', generation: fenceGeneration, lifetimeIds: ids };
  }

  /** One publication, destruction and receipt boundary, also used by replacement. */
  private executeRetirement(
    scope: Scope,
    decision: RetirementDecision,
    covered: ReadonlySet<DeferredLifetime> = new Set(),
  ): number {
    const { envelope } = scope;
    const { projectId, worktreeId } = envelope.scope;
    if (preservesRecord(decision)) {
      this.publishRetiredCoverage(scope, decision.lifetimeIds);
      this.receipt(scope, {
        kind: 'coverage',
        lifetimeIds: decision.lifetimeIds,
      });
      if (decision.kind === 'already-covered' || decision.retryCleanup) {
        if (scope.retirement)
          this.receipt(scope, { kind: 'fence', cleanup: true });
        else if (decision.kind === 'already-covered')
          // A successor's coverage proves fencing, never ownership of its files.
          this.options.repository.retryRetirement(projectId, worktreeId);
      }
      return decision.kind === 'preserved-record' ? decision.acknowledged : 1;
    }
    if (decision.kind !== 'already-covered') {
      if (decision.kind === 'generation')
        // A fence must leave a representable successor.
        nextCounter(decision.generation, 'generation');
      const tombstone: TerminalRecordTombstone =
        decision.kind === 'generation'
          ? {
              generation: decision.generation,
              incarnation: envelope.incarnation,
              retiredAt: this.now(),
              retiredLifetimeIds: [...decision.lifetimeIds],
            }
          : {
              ...(scope.retirement?.publication.image ?? {
                generation: 0,
                namedOnly: true as const,
                incarnation: null,
                retiredAt: 0,
                damaged: true as const,
              }),
              retiredLifetimeIds: [...decision.lifetimeIds],
              // Names alone acquire no artifacts; the repository unions prior debt.
              cleanupFiles: [],
            };
      this.options.repository.retire(
        projectId,
        worktreeId,
        tombstone,
        (publication) => {
          scope.retirement = {
            publication,
            // Names-only coverage acquires no artifacts, only inherited debt.
            cleanup:
              decision.kind === 'generation'
                ? 'pending'
                : (scope.retirement?.cleanup ?? 'inherited'),
          };
          // Names-only coverage leaves a cold scope uncached, so the next
          // write-authorized load still sets a damaged record aside first;
          // its unconfirmed fence is still tracked for shutdown.
          if (decision.kind === 'generation') this.scopes.set(scope.key, scope);
          // This publication's sync covers every earlier rename of the directory.
          if (publication.state === 'durable')
            this.unconfirmedFences.delete(scope.key);
          else this.trackFenceConfirmation(scope);
          this.rememberRetiredLifetime(scope, covered);
          if (decision.kind !== 'generation') return;
          if (scope.timer !== undefined) clearTimeout(scope.timer);
          scope.timer = undefined;
          // Published fences release working history even when cleanup needs retry.
          scope.envelope = {
            ...envelope,
            generation: decision.generation,
            record: { bindings: [], terminals: [], terminalCustomNames: {} },
            hostTerminals: [],
            producerWatermarks: {},
            runs: {},
          };
          scope.publication = { state: 'unpublished', error: undefined };
          scope.pendingInstall = false;
          scope.unpublishedCoverage = undefined;
          scope.historyRevisions.clear();
          scope.shutdownStamps.clear();
          this.reconciled.delete(scope.key);
        },
      );
      if (scope.retirement) scope.retirement.cleanup = 'settled';
    } else {
      // A retry resumes the published fence's discharge, never widened to
      // lifetimes requested after that fence.
      const fence = scope.retirement?.publication.image;
      this.rememberRetiredLifetime(
        scope,
        new Set(
          Array.from(covered).filter(
            (lifetime): boolean =>
              fence !== undefined &&
              fence.damaged !== true &&
              lifetime.requestedAt <= fence.retiredAt,
          ),
        ),
      );
    }
    this.receipt(scope, {
      kind: 'fence',
      cleanup: true,
      generation:
        decision.kind === 'names-only' ? undefined : decision.generation,
      lifetimeIds: decision.lifetimeIds,
    });
    return 1;
  }

  /** Resolve held reports once the retirement fence is published. */
  private rememberRetiredLifetime(
    scope: Scope,
    covered: ReadonlySet<DeferredLifetime> = new Set(),
  ): void {
    for (const pending of this.registrations.values()) {
      const { client } = pending.attribution;
      if (scopeKey(client.projectId, client.worktreeId) !== scope.key) continue;
      this.discharge(pending, { kind: 'retired', scope, covered });
    }
  }

  private admissionScope(
    client: Pick<WorkerTerminalRecordClient, 'projectId' | 'worktreeId'>,
  ): AdmissionScope {
    const key = scopeKey(client.projectId, client.worktreeId);
    let admissions = this.admissions.get(key);
    if (!admissions) {
      admissions = { order: 0n, transition: 0n, waiting: new Set() };
      this.admissions.set(key, admissions);
    }
    return admissions;
  }

  /** Storage observation alone never authorizes a new successor. */
  private authorize(
    kind: 'open' | 'apply' | 'attribute',
    client: WorkerTerminalRecordClient,
    generation = client.generation,
    original?: DeferredLifetime,
  ): Admission {
    const admissions = this.admissionScope(client);
    const order = (admissions.order += 1n);
    const boundary = admissions.transition;
    const previousVersion =
      this.scopes.get(scopeKey(client.projectId, client.worktreeId))
        ?.lifetimeVersion ?? 0n;
    const admitted = this.admit(kind, client, generation);
    if (admitted.kind !== 'current') return admitted;
    const { scope } = admitted;
    const link = (lifetime: DeferredLifetime): void => {
      if (lifetime.admission.kind === 'admitted') return;
      if (lifetime.order < boundary) return;
      const intended = deferredGeneration(lifetime);
      if (intended !== undefined && intended < scope.envelope.generation)
        return;
      lifetime.admission = {
        kind: 'admitted',
        generation: scope.envelope.generation,
        ...(client.lifetimeId &&
        scope.envelope.retiredLifetimeIds?.includes(client.lifetimeId)
          ? {
              inheritedCoverage: {
                lifetimeIds: new Set(scope.envelope.retiredLifetimeIds),
                fence: scope.retirement?.publication.image,
              },
            }
          : {}),
      };
    };
    for (const id of admissions.waiting) {
      const pending = this.registrations.get(id);
      if (
        pending &&
        this.compatibleClients(pending.attribution.client, {
          ...client,
          generation,
        })
      )
        link(pending.lifetime);
    }
    if (original) link(original);
    if (scope.lifetimeVersion > previousVersion) admissions.transition = order;
    return admitted;
  }

  private compatibleClients(
    left: WorkerTerminalRecordClient,
    right: WorkerTerminalRecordClient,
  ): boolean {
    return (
      left.projectId === right.projectId &&
      left.worktreeId === right.worktreeId &&
      left.incarnation === right.incarnation &&
      left.lifetimeId === right.lifetimeId &&
      (left.generation === undefined ||
        right.generation === undefined ||
        left.generation === right.generation)
    );
  }

  private supersededUnknownLifetime(
    scope: Scope,
    lifetime: DeferredLifetime,
  ): boolean {
    const fence = scope.retirement?.publication.image;
    const admission = lifetime.admission;
    if (
      admission.kind === 'admitted' ||
      admission.generation !== undefined ||
      admission.predecessor !== undefined ||
      admission.incarnation === null ||
      !Number.isFinite(lifetime.requestedAt) ||
      scope.lifetimeVersion !== 0n ||
      this.peekOwner(scope).kind !== 'live' ||
      scope.envelope.incarnation === null ||
      scope.envelope.incarnation === admission.incarnation ||
      !fence ||
      fence.damaged ||
      !Number.isFinite(fence.retiredAt) ||
      fence.incarnation !== admission.incarnation ||
      scope.envelope.generation <= fence.generation ||
      !(lifetime.requestedAt < fence.retiredAt) ||
      lifetime.order < this.admissionScope(scope.envelope.scope).transition
    )
      return false;
    // A later matching fence and loaded successor prove this intent was retired.
    this.receipt(scope, { kind: 'fence' });
    this.receipt(scope, { kind: 'record' });
    return true;
  }

  private pendingRegistrations(): RegistrationOwner[] {
    return Array.from(this.registrations.values()).filter(
      (owner): boolean => !owner.bound,
    );
  }

  private release(owner: RegistrationOwner): void {
    this.registrations.delete(owner.key);
    if (
      this.currentByTerminalId.get(owner.attribution.terminalId) === owner.key
    )
      this.currentByTerminalId.delete(owner.attribution.terminalId);
    owner.decoder = undefined;
    this.removeWaiting(owner);
  }

  private removeWaiting(owner: RegistrationOwner): void {
    const { client } = owner.attribution;
    const key = scopeKey(client.projectId, client.worktreeId);
    const admissions = this.admissions.get(key);
    admissions?.waiting.delete(owner.key);
    if (admissions?.waiting.size === 0 && !this.scopes.has(key))
      this.admissions.delete(key);
  }

  /** Reports leave their owner only after replay or positively covered disposal. */
  private discharge(pending: RegistrationOwner, reason: ReportDischarge): void {
    if (this.registrations.get(pending.key) !== pending) return;
    if (reason.kind === 'retired') {
      const { scope } = reason;
      const { lifetime, attribution } = pending;
      if (
        scope.key !==
        scopeKey(attribution.client.projectId, attribution.client.worktreeId)
      )
        return;
      const intended = deferredGeneration(lifetime);
      const fence = scope.retirement?.publication.image;
      const identified = attribution.client.lifetimeId;
      const covered =
        reason.covered?.has(lifetime) ||
        (intended !== undefined &&
          ((fence !== undefined && intended <= fence.generation) ||
            (intended < scope.envelope.generation &&
              this.recordDischarge(scope, intended)))) ||
        (identified !== undefined &&
          !this.inheritedName(scope, pending, identified) &&
          (fence?.retiredLifetimeIds?.includes(identified) ||
            (scope.envelope.retiredLifetimeIds?.includes(identified) &&
              this.recordDischarge(scope, undefined, [identified])))) ||
        this.supersededUnknownLifetime(scope, lifetime);
      if (!covered) return;
      // The fence that let these reports go owes its sync, cached or cold.
      this.trackFenceConfirmation(scope);
    }
    this.release(pending);
  }

  private hold(pending: RegistrationOwner): void {
    pending.bound = undefined;
    this.admissionScope(pending.attribution.client).waiting.add(pending.key);
  }

  // ---------------------------------------------------------------------
  // Daemon terminals: attribution and host reports
  // ---------------------------------------------------------------------

  /**
   * A daemon terminal was created or recreated under a revision 2 client.
   * Never throws: a record that cannot be read now keeps the terminal's
   * reports here, and attributes it once the record can be read again.
   */
  public attribute(
    input: TerminalRecordAttribution,
  ): TerminalRecordRegistration | undefined {
    // Host callers may reuse their client object; a held report is a snapshot.
    if (
      input.terminalId !== input.session.id ||
      !sessionMatchesScope(input.session, input.client)
    ) {
      this.log('Ignoring inconsistent terminal record attribution', {
        terminalId: input.terminalId,
      });
      return;
    }
    const attribution = {
      ...structuredClone(input),
      persist: input.persist && isDrawerOwnedTerminal(input.session),
    };
    const { terminalId } = attribution;
    const admissions = this.admissionScope(attribution.client);
    const lifetime = this.observeLifetime(
      attribution.client,
      (admissions.order += 1n),
    );
    const previousKey = this.currentByTerminalId.get(terminalId);
    const registered =
      previousKey === undefined
        ? undefined
        : this.registrations.get(previousKey);
    // A recreated terminal's earlier lifetime may still be waiting: its
    // output stays ahead of this one's, and this lifetime supersedes its exit.
    const earlier = registered;
    const scope = this.scopes.get(
      scopeKey(attribution.client.projectId, attribution.client.worktreeId),
    );
    const compatible =
      earlier !== undefined &&
      (earlier.lifetime.admission.kind === 'admitted'
        ? scope !== undefined &&
          scope.key ===
            scopeKey(
              earlier.attribution.client.projectId,
              earlier.attribution.client.worktreeId,
            ) &&
          earlier.attribution.client.lifetimeId ===
            attribution.client.lifetimeId &&
          deferredGeneration(earlier.lifetime) === scope.envelope.generation &&
          lifetime.admission.kind === 'unresolved' &&
          this.matchesDeferredLifetime(scope, lifetime.admission)
        : this.compatibleClients(
            earlier.attribution.client,
            attribution.client,
          ) && earlier.lifetime.order >= admissions.transition);
    const carry =
      compatible && attribution.persist && earlier.attribution.persist;
    const pending: RegistrationOwner = {
      key: Symbol(terminalId),
      order: (this.registrationVersion += 1n),
      attribution,
      lifetime: compatible ? earlier.lifetime : lifetime,
      decoder: new StringDecoder('utf8'),
      lines: [],
      exit: null,
    };
    // Recreation starts a separate byte stream, even within the same lifetime.
    // The predecessor's stream ends only once the successor is current or
    // held: a stale attribution, or one revalidation retires, leaves its
    // decoder (any split code point included) and its reports intact.
    let inherited = carry
      ? {
          decoder: earlier.decoder,
          lines: earlier.lines,
          historyTruncated: earlier.historyTruncated,
        }
      : undefined;
    const inherit = (): void => {
      if (!inherited) return;
      const { decoder, lines } = inherited;
      let { historyTruncated } = inherited;
      inherited = undefined;
      const trailing = decoder?.end() ?? '';
      pending.lines =
        trailing.length > 0
          ? appendScrollbackLines(lines, trailing, () => {
              historyTruncated = true;
            })
          : lines;
      pending.historyTruncated = historyTruncated;
    };
    // Admission can fence the predecessor. Keep the proposed successor local
    // until that transition finishes, so its reused client ID is not coverage.
    try {
      const admitted = this.authorize(
        'attribute',
        attribution.client,
        pending.lifetime.admission.kind === 'admitted'
          ? deferredGeneration(pending.lifetime)
          : attribution.client.generation,
        pending.lifetime,
      );
      if (admitted.kind === 'stale') {
        // A fence that drops this terminal's reports owes its sync, cached or cold.
        if (admitted.scope) this.trackFenceConfirmation(admitted.scope);
        const scope = this.scopes.get(
          scopeKey(attribution.client.projectId, attribution.client.worktreeId),
        );
        if (earlier && scope)
          this.discharge(earlier, {
            kind: 'retired',
            scope,
          });
        this.release(pending);
        return;
      }
      // Older same-record owners replay before this stream resets the entry.
      // Retry never changes the current-route index, including across scopes.
      const admittedGeneration = admitted.scope.envelope.generation;
      this.retryAttributions(carry ? earlier.key : undefined, {
        terminalId,
        scopeKey: admitted.scope.key,
      });
      if (
        this.revalidateAdmission(
          attribution.client,
          admittedGeneration,
          pending.lifetime.admission.kind === 'admitted'
            ? pending.lifetime.admission.inheritedCoverage
            : undefined,
        ).kind !== 'current'
      ) {
        this.registrations.set(pending.key, pending);
        this.hold(pending);
        this.discharge(pending, { kind: 'retired', scope: admitted.scope });
        if (earlier)
          this.discharge(earlier, { kind: 'retired', scope: admitted.scope });
        if (!this.registrations.has(pending.key)) return;
        this.boundUnattributed();
        this.scheduleAttributionRetry();
        return pending.key;
      }
      inherit();
      this.registrations.set(pending.key, pending);
      if (carry) this.release(earlier);
      this.replay(pending, admitted.scope);
    } catch (error) {
      this.log('Could not attribute a terminal to its record; retrying', {
        code: errorCode(error),
      });
      // Retain the original intent while recording a newly observed predecessor.
      const observed = this.observeLifetime(
        attribution.client,
        pending.lifetime.order,
      );
      if (
        pending.lifetime.admission.kind === 'unresolved' &&
        !pending.lifetime.admission.predecessor &&
        pending.lifetime.admission.generation === undefined &&
        observed.admission.kind === 'unresolved' &&
        observed.admission.predecessor
      )
        pending.lifetime.admission.predecessor = observed.admission.predecessor;
      // The destination retains the copied reports before the source releases.
      inherit();
      this.registrations.set(pending.key, pending);
      if (carry) this.release(earlier);
      this.hold(pending);
    }
    if (!this.registrations.has(pending.key)) return;
    const destination = this.scopes.get(
      scopeKey(attribution.client.projectId, attribution.client.worktreeId),
    );
    if (
      destination &&
      pending.lifetime.admission.kind === 'admitted' &&
      this.revalidateAdmission(
        attribution.client,
        pending.lifetime.admission.generation,
        pending.lifetime.admission.inheritedCoverage,
      ).kind !== 'current'
    ) {
      this.discharge(pending, { kind: 'retired', scope: destination });
      if (!this.registrations.has(pending.key)) return;
      this.boundUnattributed();
      this.scheduleAttributionRetry();
      return pending.key;
    }
    this.currentByTerminalId.set(terminalId, pending.key);
    if (!pending.bound) {
      this.boundUnattributed();
      this.scheduleAttributionRetry();
    }
    return pending.key;
  }

  private bindAttribution(pending: RegistrationOwner, scope: Scope): boolean {
    const { attribution } = pending;
    const generation = deferredGeneration(pending.lifetime);
    if (
      generation === undefined ||
      this.revalidateAdmission(
        attribution.client,
        generation,
        pending.lifetime.admission.kind === 'admitted'
          ? pending.lifetime.admission.inheritedCoverage
          : undefined,
      ).kind !== 'current'
    ) {
      this.hold(pending);
      this.discharge(pending, { kind: 'retired', scope });
      return false;
    }
    const { terminalId, session } = attribution;
    const persists = attribution.persist && isDrawerOwnedTerminal(session);
    const superseded = this.isSuperseded(scope, pending);
    const revision =
      persists && !superseded
        ? nextCounter(scope.envelope.revision, 'revision')
        : scope.envelope.revision;
    // Reserve the whole held replay before publishing any registration or prefix.
    const hasEntry =
      persists || this.entry(scope.envelope, terminalId) !== undefined;
    let replayRevision = revision;
    let historyRevision = scope.historyRevisions.get(terminalId) ?? 0;
    if (hasEntry && pending.lines.length > 0) {
      replayRevision = nextCounter(replayRevision, 'revision');
      historyRevision = nextCounter(historyRevision, 'history revision');
    }
    if (hasEntry && pending.shutdownSignal && !superseded)
      replayRevision = nextCounter(replayRevision, 'revision');
    if (pending.exit) {
      nextCounter(replayRevision, 'revision');
      nextCounter(historyRevision, 'history revision');
    }
    pending.bound = {
      scopeKey: scope.key,
      generation: scope.envelope.generation,
    };
    // Public routing does not confer saved-status or host-membership ownership.
    if (!persists || superseded) return true;
    // A successor's release cannot restore its predecessors' status ownership.
    // Pending owners may not know their generation yet; qualify this evidence
    // when they bind, rather than assigning them the successor's destination.
    for (const owner of this.registrations.values())
      if (
        owner.order < pending.order &&
        owner.attribution.terminalId === terminalId &&
        scopeKey(
          owner.attribution.client.projectId,
          owner.attribution.client.worktreeId,
        ) === scope.key
      )
        owner.supersededGeneration = scope.envelope.generation;
    const { envelope } = scope;
    upsertRecordSession(envelope.record, session);
    if (!envelope.hostTerminals.includes(terminalId))
      envelope.hostTerminals.push(terminalId);
    envelope.revision = revision;
    this.supersedeShutdownStamps(scope, terminalId, envelope.revision);
    this.markDirty(scope);
    return true;
  }

  private observeLifetime(
    client: WorkerTerminalRecordClient,
    order: bigint,
  ): DeferredLifetime {
    const scope = this.scopes.get(
      scopeKey(client.projectId, client.worktreeId),
    );
    const retired = scope && this.peekOwner(scope).kind === 'tombstone';
    return {
      order,
      requestedAt: this.now(),
      admission: {
        kind: 'unresolved',
        generation:
          client.generation ??
          (scope &&
          !retired &&
          (client.incarnation === null ||
            scope.envelope.incarnation === null ||
            client.incarnation === scope.envelope.incarnation)
            ? scope.envelope.generation
            : undefined),
        ...(scope &&
        client.generation === undefined &&
        (retired ||
          (client.incarnation !== null &&
            scope.envelope.incarnation !== null &&
            client.incarnation !== scope.envelope.incarnation))
          ? {
              predecessor: {
                generation: scope.envelope.generation,
                incarnation: scope.envelope.incarnation,
              },
            }
          : {}),
        incarnation: client.incarnation,
        version: this.lifetimeVersion,
      },
    };
  }

  private matchesDeferredLifetime(
    scope: Pick<Scope, 'envelope' | 'lifetimeVersion'>,
    lifetime: Extract<DeferredLifetime['admission'], { kind: 'unresolved' }>,
  ): boolean {
    const { generation, incarnation } = scope.envelope;
    if (lifetime.predecessor)
      return (
        generation ===
          nextCounter(lifetime.predecessor.generation, 'generation') &&
        (lifetime.incarnation === null || incarnation === lifetime.incarnation)
      );
    // A loaded record can reveal an unknown generation. A newly started
    // successor cannot; generation 1 is the first lifetime, not a successor.
    if (lifetime.generation !== undefined)
      return lifetime.generation >= generation;
    return (
      (generation === 1 || scope.lifetimeVersion <= lifetime.version) &&
      (lifetime.incarnation === null ||
        incarnation === null ||
        lifetime.incarnation === incarnation)
    );
  }

  /** A failed identity comparison is pending, never retirement evidence. */
  private admitDeferredAttribution(
    client: WorkerTerminalRecordClient,
    lifetime: DeferredLifetime,
  ): AttributionResolution {
    const peeked = this.peek(client);
    const finish = (admitted: Admission): AttributionResolution => {
      if (admitted.kind === 'current') {
        if (lifetime.admission.kind === 'unresolved')
          lifetime.admission = {
            kind: 'admitted',
            generation: admitted.scope.envelope.generation,
          };
        return { kind: 'bound', scope: admitted.scope };
      }
      const scope = this.scopes.get(
        scopeKey(client.projectId, client.worktreeId),
      );
      return scope ? { kind: 'retired', scope } : { kind: 'pending' };
    };
    const intended = deferredGeneration(lifetime);
    const admission = lifetime.admission;
    if (
      peeked.kind === 'none' &&
      client.lifetimeId &&
      peeked.scope?.retirement?.publication.image.retiredLifetimeIds?.includes(
        client.lifetimeId,
      )
    )
      return { kind: 'retired', scope: peeked.scope };
    if (admission.kind === 'admitted') {
      const checked = this.revalidateAdmission(
        client,
        admission.generation,
        admission.inheritedCoverage,
      );
      if (checked.kind === 'current')
        return finish(this.current(checked.scope, client, 'attribute'));
    }
    if (peeked.kind !== 'none') {
      const generation =
        peeked.kind === 'live'
          ? peeked.scope.envelope.generation
          : peeked.generation;
      const retiredIds =
        peeked.kind === 'live'
          ? peeked.scope.envelope.retiredLifetimeIds
          : peeked.retiredLifetimeIds;
      if (
        (client.lifetimeId !== undefined &&
          retiredIds?.includes(client.lifetimeId)) ||
        (intended !== undefined &&
          (intended < generation ||
            (peeked.kind === 'tombstone' && intended <= generation)))
      )
        return { kind: 'retired', scope: peeked.scope };
      if (this.supersededUnknownLifetime(peeked.scope, lifetime))
        return { kind: 'retired', scope: peeked.scope };
    }
    if (admission.kind === 'admitted') {
      return { kind: 'pending' };
    }
    if (admission.predecessor) {
      const predecessor = admission.predecessor;
      if (
        (peeked.kind === 'live' &&
          peeked.scope.envelope.generation === predecessor.generation &&
          peeked.scope.envelope.incarnation === predecessor.incarnation) ||
        (peeked.kind === 'tombstone' &&
          peeked.generation === predecessor.generation)
      )
        return finish(this.admit('attribute', client, undefined));
      if (
        peeked.kind === 'live' &&
        peeked.scope.envelope.generation === intended &&
        peeked.scope.envelope.incarnation === client.incarnation
      )
        return finish(
          this.admit('attribute', client, peeked.scope.envelope.generation),
        );
      return { kind: 'pending' };
    }
    if (peeked.kind === 'live') {
      if (!this.matchesDeferredLifetime(peeked.scope, admission))
        return { kind: 'pending' };
      return finish(
        this.admit(
          'attribute',
          client,
          admission.generation ?? peeked.scope.envelope.generation,
        ),
      );
    }
    if (peeked.kind === 'tombstone' && admission.generation === undefined) {
      const fence = peeked.scope.retirement?.publication.image;
      const boundary = this.admissionScope(client).transition;
      // Resume the original authorized start only behind a demonstrably older
      // fence, with no intervening local lifetime. Observation is not admission.
      if (
        !fence ||
        fence.damaged ||
        !Number.isSafeInteger(fence.retiredAt) ||
        !(fence.retiredAt < lifetime.requestedAt) ||
        lifetime.order < boundary
      )
        return { kind: 'pending' };
      admission.predecessor = {
        generation: fence.generation,
        incarnation: fence.incarnation,
      };
      return this.admitDeferredAttribution(client, lifetime);
    }
    return finish(this.admit('attribute', client, admission.generation ?? 1));
  }

  /**
   * Attributes the terminals whose record could not be read, then replays
   * what they reported meanwhile, in order: output, then exit.
   */
  private retryAttributions(
    skip?: TerminalRecordRegistration,
    only?: { terminalId?: string; scopeKey: string },
  ): void {
    const failures: unknown[] = [];
    for (const pending of this.pendingRegistrations()) {
      if (pending.key === skip) continue;
      if (
        only &&
        ((only.terminalId !== undefined &&
          pending.attribution.terminalId !== only.terminalId) ||
          scopeKey(
            pending.attribution.client.projectId,
            pending.attribution.client.worktreeId,
          ) !== only.scopeKey)
      )
        continue;
      let resolved: AttributionResolution;
      try {
        resolved = this.admitDeferredAttribution(
          pending.attribution.client,
          pending.lifetime,
        );
      } catch {
        continue;
      }
      if (resolved.kind === 'pending') continue;
      if (resolved.kind === 'retired') {
        this.discharge(pending, resolved);
        continue;
      }
      try {
        this.replay(pending, resolved.scope);
      } catch (error) {
        this.registrations.set(pending.key, pending);
        this.hold(pending);
        this.log('Could not replay held terminal reports; retrying', {
          code: errorCode(error),
        });
        if (
          !(
            error instanceof CanopyOperationError &&
            error.payload.kind === 'resource_exhausted'
          )
        )
          failures.push(error);
        continue;
      }
    }
    if (this.pendingRegistrations().length > 0) this.scheduleAttributionRetry();
    if (failures.length > 0)
      throw Object.assign(new Error('Terminal attribution replay failed.'), {
        errors: failures,
      });
  }

  private replay(pending: RegistrationOwner, scope: Scope): void {
    if (!this.bindAttribution(pending, scope)) return;
    const { terminalId } = pending.attribution;
    if (pending.lines.length > 0)
      this.appendText(
        scope,
        terminalId,
        pending.lines.join('\n'),
        pending.historyTruncated,
      );
    pending.lines = [];
    pending.historyTruncated = undefined;
    if (pending.shutdownSignal && !this.isSuperseded(scope, pending)) {
      const entry = this.entry(scope.envelope, terminalId);
      if (entry) {
        const revision = nextCounter(scope.envelope.revision, 'revision');
        entry.exitCode = null;
        entry.signal = pending.shutdownSignal;
        scope.envelope.revision = revision;
        scope.shutdownStamps.add({
          terminalId,
          signal: pending.shutdownSignal,
          revision: scope.envelope.revision,
        });
        this.markDirty(scope);
      }
    }
    pending.shutdownSignal = undefined;
    this.removeWaiting(pending);
    if (pending.exit)
      this.exited(pending.key, pending.exit.exitCode, pending.exit.signal);
  }

  /** Write-authorized recovery drains held reports; queries retry only locally. */
  private retryAttributionsOf(client: WorkerTerminalRecordClient): void {
    for (const { attribution } of this.pendingRegistrations())
      if (
        attribution.client.projectId === client.projectId &&
        attribution.client.worktreeId === client.worktreeId
      ) {
        this.retryAttributions();
        return;
      }
  }

  private scheduleAttributionRetry(): void {
    if (this.attributionTimer !== undefined) return;
    this.attributionTimer = setTimeout(() => {
      this.attributionTimer = undefined;
      try {
        this.retryAttributions();
      } catch (error) {
        this.log('Terminal attribution retry failed', {
          code: errorCode(error),
        });
      }
    }, INSTALL_RETRY_MS);
    this.attributionTimer.unref?.();
  }

  /** Keeps at most this many waiting, dropping exited ones first. */
  private boundUnattributed(): void {
    const waiting = this.pendingRegistrations();
    while (waiting.length > MAX_UNATTRIBUTED) {
      const dropped =
        waiting.find((pending): boolean => pending.exit !== null) ?? waiting[0];
      this.discharge(dropped, { kind: 'capacity' });
      waiting.splice(waiting.indexOf(dropped), 1);
      this.log('Dropped the reports of a terminal its record never read', {});
    }
  }

  private liveScope(key: TerminalRecordRegistration | undefined): {
    terminal: RegistrationOwner;
    scope: Scope;
  } | null {
    const terminal =
      key === undefined ? undefined : this.registrations.get(key);
    if (!terminal?.bound) return null;
    const scope = this.scopes.get(terminal.bound.scopeKey);
    // A retired scope's late reports are dropped.
    if (
      !scope ||
      this.peekOwner(scope).kind !== 'live' ||
      scope.envelope.generation !== terminal.bound.generation
    )
      return null;
    return { terminal, scope };
  }

  /** Status ownership outlives a successor's resources, not the record generation. */
  private isSuperseded(scope: Scope, owner: RegistrationOwner): boolean {
    return owner.supersededGeneration === scope.envelope.generation;
  }

  /** Scope membership is independent of which registration owns the public route. */
  private boundOwner(
    scope: Scope,
    terminalId: string,
  ): RegistrationOwner | undefined {
    let newest: RegistrationOwner | undefined;
    for (const owner of this.registrations.values())
      if (
        owner.attribution.terminalId === terminalId &&
        owner.attribution.persist &&
        owner.bound?.scopeKey === scope.key &&
        owner.bound.generation === scope.envelope.generation &&
        !this.isSuperseded(scope, owner) &&
        (!newest || owner.order > newest.order)
      )
        newest = owner;
    return newest;
  }

  /** A persisted daemon terminal's output bytes, in order. */
  public output(
    key: TerminalRecordRegistration | undefined,
    data: Uint8Array,
  ): void {
    const pending = key === undefined ? undefined : this.registrations.get(key);
    if (pending && !pending.bound) {
      if (!pending.attribution.persist) return;
      const text = pending.decoder?.write(Buffer.from(data)) ?? '';
      if (text.length > 0)
        pending.lines = appendScrollbackLines(pending.lines, text, () => {
          pending.historyTruncated = true;
        });
      return;
    }
    const live = this.liveScope(key);
    if (!live?.terminal.attribution.persist) return;
    const { terminalId } = live.terminal.attribution;
    const text = live.terminal.decoder?.write(Buffer.from(data)) ?? '';
    if (text.length === 0) return;
    if (!this.hostMutationAvailable(live.scope, terminalId)) {
      const pending = this.deferHostReports(live.terminal);
      pending.lines = appendScrollbackLines([], text, () => {
        pending.historyTruncated = true;
      });
      return;
    }
    this.appendText(live.scope, terminalId, text);
  }

  private hostMutationAvailable(scope: Scope, terminalId: string): boolean {
    try {
      nextCounter(scope.envelope.revision, 'revision');
      nextCounter(
        scope.historyRevisions.get(terminalId) ?? 0,
        'history revision',
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Recording exhaustion must not interrupt host output or process teardown. */
  private deferHostReports(terminal: RegistrationOwner): RegistrationOwner {
    this.hold(terminal);
    this.boundUnattributed();
    this.scheduleAttributionRetry();
    return terminal;
  }

  private appendText(
    scope: Scope,
    terminalId: string,
    text: string,
    discontinuous = false,
    advanceRevision = true,
  ): boolean {
    const entry = this.entry(scope.envelope, terminalId);
    if (!entry) return false;
    const revision = advanceRevision
      ? nextCounter(scope.envelope.revision, 'revision')
      : scope.envelope.revision;
    nextCounter(
      scope.historyRevisions.get(terminalId) ?? 0,
      'history revision',
    );
    const truncated = importPending(scope)
      ? (): void => markHistoryTruncated(scope.envelope.record, terminalId)
      : undefined;
    if (discontinuous) truncated?.();
    entry.scrollbackLines = appendScrollbackLines(
      entry.scrollbackLines,
      discontinuous ? discontinuousOutput(entry.scrollbackLines, text) : text,
      truncated,
    );
    this.bumpHistory(scope, terminalId);
    scope.envelope.revision = revision;
    this.markDirty(scope);
    return true;
  }

  /** A daemon terminal's exit, after every byte it reported. */
  public exited(
    key: TerminalRecordRegistration | undefined,
    exitCode: number | null,
    signal: string | null,
  ): void {
    const pending = key === undefined ? undefined : this.registrations.get(key);
    if (!pending) return;
    if (!pending.attribution.persist) {
      this.release(pending);
      return;
    }
    const { terminalId } = pending.attribution;
    if (!pending.bound) {
      const trailing = pending.decoder?.end() ?? '';
      pending.decoder = undefined;
      if (trailing.length > 0 && pending.attribution.persist)
        pending.lines = appendScrollbackLines(pending.lines, trailing, () => {
          pending.historyTruncated = true;
        });
      if (!pending.exit || !isShutdownExitSignal(pending.exit.signal))
        pending.exit = { exitCode, signal };
      this.retryAttributions();
      return;
    }
    const live = this.liveScope(key);
    const terminal = pending;
    if (!live) {
      this.release(terminal);
      return;
    }
    const { scope } = live;
    if (!this.hostMutationAvailable(scope, terminalId)) {
      this.deferHostReports(terminal);
      this.exited(key, exitCode, signal);
      return;
    }
    const revision = nextCounter(scope.envelope.revision, 'revision');
    nextCounter(
      scope.historyRevisions.get(terminalId) ?? 0,
      'history revision',
    );
    const trailing = terminal.decoder?.end() ?? '';
    const superseded = this.isSuperseded(scope, terminal);
    this.release(terminal);
    // Decoder completion and exit are one record mutation.
    if (trailing.length > 0)
      this.appendText(scope, terminalId, trailing, false, false);
    const { envelope } = scope;
    if (!superseded)
      envelope.hostTerminals = envelope.hostTerminals.filter(
        (id) => id !== terminalId,
      );
    const entry = this.entry(envelope, terminalId);
    if (entry && !superseded && !isShutdownExitSignal(entry.signal)) {
      entry.exitCode = exitCode;
      entry.signal = signal;
    }
    envelope.revision = revision;
    this.markDirty(scope);
  }

  /**
   * Stamps every live daemon terminal with the quit's reason and installs
   * at once (CAN-7051 §5.10): their exits that follow never overwrite it.
   */
  public shutdown(signal: string): { stamped: number } {
    WorkerTerminalRecordShutdownParamsSchema.parse({ signal });
    for (const pending of this.pendingRegistrations())
      if (
        pending.attribution.persist &&
        !pending.exit &&
        !pending.shutdownSignal
      )
        pending.shutdownSignal = signal;
    this.retryAttributions();
    for (const terminal of this.registrations.values()) {
      if (!terminal.bound) continue;
      const live = this.liveScope(terminal.key);
      if (!live) {
        this.release(terminal);
        continue;
      }
      if (
        !live.terminal.attribution.persist ||
        this.isSuperseded(live.scope, terminal)
      )
        continue;
      const { terminalId } = terminal.attribution;
      const entry = this.entry(live.scope.envelope, terminalId);
      if (!entry) continue;
      if (!isShutdownExitSignal(entry.signal)) {
        const revision = nextCounter(live.scope.envelope.revision, 'revision');
        entry.exitCode = null;
        entry.signal = signal;
        live.scope.envelope.revision = revision;
        live.scope.shutdownStamps.add({
          terminalId,
          signal,
          revision: live.scope.envelope.revision,
        });
        this.markDirty(live.scope);
      }
    }
    // Attempt every owner once; never count an unreferenced retry timer as a stamp.
    this.flushSync();
    if (
      this.pendingRegistrations().some((pending) => pending.attribution.persist)
    )
      throw new Error(
        'The terminal shutdown still has unresolved attributions.',
      );
    // Published fences can release held reports before their sync succeeds,
    // including names-only fences over scopes left uncached.
    for (const scope of Array.from(this.unconfirmedFences.values()))
      this.receipt(scope, { kind: 'fence' });
    for (const scope of this.scopes.values()) this.confirmDischarges(scope);
    const obligations = Array.from(this.scopes.values()).flatMap((scope) =>
      this.peekOwner(scope).kind === 'live'
        ? Array.from(scope.shutdownStamps)
            .filter(
              (stamp) =>
                stamp.signal === signal || stamp.supersededAt !== undefined,
            )
            .map((stamp) => ({ scope, stamp }))
        : [],
    );
    for (const { scope, stamp } of obligations)
      this.receipt(scope, { kind: 'shutdown', stamp });
    for (const { scope, stamp } of obligations)
      scope.shutdownStamps.delete(stamp);
    const stamped = obligations.filter(
      ({ stamp }) => stamp.supersededAt === undefined,
    ).length;
    return { stamped };
  }

  // ---------------------------------------------------------------------
  // Clients: open, history, apply, retire
  // ---------------------------------------------------------------------

  public open(
    client: WorkerTerminalRecordClient,
  ): WorkerTerminalRecordOpenResult {
    const authorized = this.authorize('open', client);
    const authorizedGeneration =
      authorized.kind === 'current'
        ? authorized.scope.envelope.generation
        : undefined;
    if (authorized.kind === 'current') this.retryAttributionsOf(client);
    // Authorization binds unknown reports; their replay can replace this lifetime.
    const admitted =
      authorized.kind === 'current'
        ? this.revalidateAdmission(
            client,
            authorizedGeneration ?? authorized.scope.envelope.generation,
          )
        : authorized;
    // A stale lifetime sees an empty record of its own generation: what it
    // writes is dropped, and the newer record is never shown or touched.
    if (admitted.kind === 'stale')
      return {
        generation:
          client.generation ?? authorizedGeneration ?? admitted.generation,
        lineage: randomUUID(),
        revision: 0,
        bindings: [],
        terminalCustomNames: {},
        terminals: [],
        import: this.importStatus(),
        producerWatermarks: {},
      };
    const { scope } = admitted;
    // A reader fences the legacy state once it sees the import, so the
    // import must be durable first; reports keep it in memory meanwhile.
    // A pending import is served as it is, marked, and never fenced.
    // Once content is durable, later write failures must not hide its history.
    if (
      !importPending(scope) &&
      scope.pendingInstall &&
      !this.installNow(scope) &&
      (scope.publication.state === 'unpublished' ||
        !hasRecordContent(scope.publication.image))
    )
      throw new Error('The terminal record could not be installed.');
    scope.confirmationFailed = false;
    const committed = this.visibleReceipt(scope);
    const importStatus = this.importStatus({
      scope,
      committed: committed !== undefined,
    });
    const { envelope } = scope;
    return {
      generation: envelope.generation,
      lineage: envelope.lineage,
      revision: envelope.revision,
      bindings: structuredClone(envelope.record.bindings),
      terminalCustomNames: stringValues(envelope.record.terminalCustomNames),
      terminals: envelope.record.terminals.map((entry) => ({
        session: storedSessionOf(entry.session),
        exitCode: entry.exitCode,
        signal: entry.signal,
        historyBytes: Buffer.byteLength(historyText(entry), 'utf8'),
        historyRevision: scope.historyRevisions.get(entry.session.id) ?? 0,
      })),
      import: importStatus,
      producerWatermarks: committed ? { ...committed.producerWatermarks } : {},
      snapshotProducerWatermarks: { ...envelope.producerWatermarks },
    };
  }

  /**
   * The only builder of an import status. A reader may fence the legacy
   * state only behind a settled one, so only a durable import receipt of the
   * current lifetime's committed record settles it. A stale lifetime (no
   * `current`) confirms nothing; it and every unconfirmed case read `pending`.
   */
  private importStatus(current?: {
    scope: Scope;
    committed: boolean;
  }): WorkerTerminalRecordOpenResult['import'] {
    if (!current) return { from: 'none', sourceSha256: null, pending: true };
    const { scope, committed } = current;
    let confirmed = false;
    if (committed && !importPending(scope)) {
      try {
        this.receipt(scope, { kind: 'import' });
        confirmed = true;
      } catch {
        /* Visible history remains available without a fencing receipt. */
      }
    }
    const { from, sourceSha256 } = scope.envelope.import;
    return confirmed
      ? { from, sourceSha256 }
      : { from, sourceSha256, pending: true };
  }

  /** Only a current query may retry reports, and only in its requested scope. */
  private historySnapshot(client: WorkerTerminalRecordClient): {
    terminals: readonly PersistedTerminalEntry[];
    historyEpoch: string;
    historyRevisions: ReadonlyMap<string, number>;
    producerWatermarks: Record<string, number> | undefined;
    snapshotProducerWatermarks: Record<string, number> | undefined;
  } | null {
    const peeked = this.peek(client);
    const generation =
      peeked.kind === 'live'
        ? peeked.scope.envelope.generation
        : peeked.kind === 'tombstone'
          ? peeked.generation
          : undefined;
    const retiredIds =
      peeked.kind === 'live'
        ? peeked.scope.envelope.retiredLifetimeIds
        : peeked.scope?.retirement?.publication.image.retiredLifetimeIds;
    if (
      (client.lifetimeId !== undefined &&
        retiredIds?.includes(client.lifetimeId)) ||
      (client.generation !== undefined &&
        generation !== undefined &&
        (client.generation < generation ||
          (peeked.kind === 'tombstone' && client.generation === generation)))
    )
      return null;
    // No readable snapshot does not mean stale: a held write may still own
    // the successor behind this fence or a different-incarnation predecessor.
    const awaitingSuccessor =
      peeked.kind === 'tombstone' ||
      (peeked.kind === 'live' &&
        client.generation === undefined &&
        client.incarnation !== null &&
        peeked.scope.envelope.incarnation !== null &&
        client.incarnation !== peeked.scope.envelope.incarnation);
    if (
      awaitingSuccessor &&
      !this.pendingRegistrations().some(({ attribution, lifetime }) => {
        if (!this.compatibleClients(attribution.client, client)) return false;
        // Compatibility identifies the caller, not permission to start over.
        // Only an unresolved write's original successor intent can do that.
        const admission = lifetime.admission;
        if (admission.kind !== 'unresolved') return false;
        if (peeked.kind === 'live')
          return (
            admission.predecessor?.generation === generation &&
            admission.predecessor?.incarnation ===
              peeked.scope.envelope.incarnation
          );
        if (peeked.kind !== 'tombstone') return false;
        if (admission.predecessor)
          return admission.predecessor.generation === peeked.generation;
        if (admission.generation !== undefined)
          return admission.generation > peeked.generation;
        const fence = peeked.scope.retirement?.publication.image;
        return (
          fence !== undefined &&
          !fence.damaged &&
          Number.isSafeInteger(fence.retiredAt) &&
          fence.retiredAt < lifetime.requestedAt &&
          lifetime.order >=
            (this.admissions.get(scopeKey(client.projectId, client.worktreeId))
              ?.transition ?? 0n)
        );
      })
    )
      return null;
    this.retryAttributions(undefined, {
      scopeKey: scopeKey(client.projectId, client.worktreeId),
    });
    // Replay can replace or fence the lifetime; recheck before serving history.
    return this.historyPreview(client);
  }

  /** Preview an unimported source without letting a query choose its lifetime. */
  private historyPreview(client: WorkerTerminalRecordClient): {
    terminals: readonly PersistedTerminalEntry[];
    historyEpoch: string;
    historyRevisions: ReadonlyMap<string, number>;
    producerWatermarks: Record<string, number> | undefined;
    snapshotProducerWatermarks: Record<string, number> | undefined;
  } | null {
    const peeked = this.peek(client);
    if (peeked.kind === 'tombstone') return null;
    if (peeked.kind === 'none') {
      if (
        client.lifetimeId &&
        peeked.scope?.retirement?.publication.image.retiredLifetimeIds?.includes(
          client.lifetimeId,
        )
      )
        return null;
      const preview = this.options.repository.previewLegacy({
        projectId: client.projectId,
        worktreeId: client.worktreeId,
        layout: client.legacyLayout,
      });
      return {
        terminals: preview.terminals,
        // Source changes restart pagination; installation switches to a load epoch.
        historyEpoch: `legacy-${preview.sourceSha256?.slice(0, 32) ?? 'absent'}`,
        historyRevisions: new Map(),
        // No producer batch is acknowledged by an uninstalled preview.
        producerWatermarks: undefined,
        snapshotProducerWatermarks: undefined,
      };
    }
    const admitted = this.admit('read', client);
    if (admitted.kind === 'stale') return null;
    const { scope } = admitted;
    // Confirmation is cached; dirty visible history never acknowledges unsaved batches.
    const committed =
      Object.keys(scope.envelope.producerWatermarks).length > 0
        ? this.visibleReceipt(scope)
        : undefined;
    return {
      terminals: scope.envelope.record.terminals,
      historyEpoch: scope.historyEpoch,
      historyRevisions: scope.historyRevisions,
      producerWatermarks: committed
        ? { ...committed.producerWatermarks }
        : undefined,
      snapshotProducerWatermarks: { ...scope.envelope.producerWatermarks },
    };
  }

  public historyRead(
    params: WorkerTerminalRecordHistoryReadParams,
  ): WorkerTerminalRecordHistoryReadResult {
    // A stale lifetime's read, or one of a retired scope, is empty and
    // changes nothing (R4-F1).
    const snapshot = this.historySnapshot(params.client);
    if (!snapshot)
      return {
        text: '',
        nextCursor: null,
        historyRevision: 0,
        restarted:
          params.cursor !== undefined || params.historyRevision !== undefined,
      };
    const entry = snapshot.terminals.filter(
      (candidate) => candidate.session.id === params.terminalId,
    )[params.occurrence ?? 0];
    const historyRevision =
      snapshot.historyRevisions.get(params.terminalId) ?? 0;
    const historyEpoch = createHash('sha256')
      .update(
        JSON.stringify([
          params.client.projectId,
          params.client.worktreeId,
          snapshot.historyEpoch,
          params.terminalId,
          params.occurrence ?? 0,
          historyRevision,
        ]),
      )
      .digest('base64url');
    const { producerWatermarks, snapshotProducerWatermarks } = snapshot;
    const [epoch, offset, extra] = params.cursor?.split(':') ?? [];
    const text = entry ? historyText(entry) : '';
    const parsed = Number(offset);
    const splitsSurrogatePair =
      parsed > 0 && (text.codePointAt(parsed - 1) ?? 0) > 0xffff;
    const validCursor =
      epoch === historyEpoch &&
      offset !== undefined &&
      /^(0|[1-9]\d*)$/.test(offset) &&
      extra === undefined &&
      Number.isSafeInteger(parsed) &&
      parsed >= 0 &&
      parsed <= text.length &&
      !splitsSurrogatePair;
    const restarted =
      (params.historyRevision !== undefined &&
        params.historyRevision !== historyRevision) ||
      (params.cursor !== undefined && !validCursor);
    const start = !restarted && validCursor ? parsed : 0;
    const rawPage = fitBytes(
      text.slice(start),
      params.maxBytes ?? HISTORY_PAGE_DEFAULT_BYTES,
    );
    const snapshotFields = {
      historyRevision,
      restarted,
      ...(snapshotProducerWatermarks !== undefined
        ? { snapshotProducerWatermarks }
        : {}),
    };
    const metadataBytes = (candidate: object): number =>
      Buffer.byteLength(
        JSON.stringify({
          text: '',
          nextCursor: `${historyEpoch}:${text.length}`,
          ...candidate,
        }),
        'utf8',
      );
    // A page needs room for one escaped code point, at most 6 bytes.
    const textRequired = rawPage.length > 0 ? 6 : 0;
    let fields: typeof snapshotFields & {
      producerWatermarks?: Record<string, number>;
    } = {
      ...snapshotFields,
      ...(producerWatermarks !== undefined ? { producerWatermarks } : {}),
    };
    if (
      producerWatermarks !== undefined &&
      metadataBytes(fields) + textRequired > HISTORY_PAGE_REPLY_BYTES
    )
      // Without durable receipts the page releases no replay copy; snapshot
      // coverage stays exact, so overlays are still suppressed correctly.
      fields = snapshotFields;
    // `maxBytes` counts raw text; JSON escaping can grow it sixfold.
    const textBudget = HISTORY_PAGE_REPLY_BYTES - metadataBytes(fields);
    if (textBudget < textRequired)
      throw new CanopyOperationError({
        kind: 'resource_exhausted',
        message:
          "The terminal record's producer watermarks are too large for a history reply.",
        retry: { kind: 'never' },
        details: { reason: 'terminal_record_history_metadata_too_large' },
      });
    const page =
      Buffer.byteLength(rawPage, 'utf8') * 6 <= textBudget
        ? rawPage
        : fitJsonBytes(rawPage, textBudget);
    const end = start + page.length;
    return {
      text: page,
      nextCursor: end < text.length ? `${historyEpoch}:${end}` : null,
      ...fields,
    };
  }

  /** History and exit intent from the same current record, for a daemon restore. */
  public restoreHistoryTail(
    client: WorkerTerminalRecordClient,
    terminalId: string,
    maxChars: number,
  ): { scrollback: string; signal: string | null } | null {
    const snapshot = this.historySnapshot(client);
    const entry = snapshot?.terminals.find(
      (candidate) => candidate.session.id === terminalId,
    );
    if (!entry) return null;
    const text = historyText(entry);
    return {
      scrollback: text.length > maxChars ? text.slice(-maxChars) : text,
      signal: entry.signal,
    };
  }

  /** The newest `maxChars` of a terminal's history, for a daemon restore. */
  public historyTail(
    client: WorkerTerminalRecordClient,
    terminalId: string,
    maxChars: number,
  ): string {
    const snapshot = this.historySnapshot(client);
    const entry = snapshot?.terminals.find(
      (candidate) => candidate.session.id === terminalId,
    );
    if (!entry) return '';
    const text = historyText(entry);
    return text.length > maxChars ? text.slice(-maxChars) : text;
  }

  /**
   * One producer batch, acknowledged after its durable install together
   * with the producer's watermark. Stale generations are dropped and
   * repeats are duplicates; neither is an error.
   */
  public apply(
    params: WorkerTerminalRecordApplyParams,
  ): WorkerTerminalRecordApplyResult {
    const producer = producerRunKey(params.producer);
    if (producer.length > WORKER_TERMINAL_RECORD_WATERMARK_KEY_MAX_LENGTH)
      throw new Error('The terminal producer watermark key is too long.');
    // Reject malformed batches before admission can import or retire a lifetime.
    for (const op of params.ops) validateTerminalRecordOp(op, params.client);
    // A batch of an older generation is dropped, answering the current
    // generation, before its incarnation can retire the newer record.
    const authorized = this.authorize(
      'apply',
      params.client,
      params.generation ?? params.client.generation,
    );
    const authorizedGeneration =
      authorized.kind === 'current'
        ? authorized.scope.envelope.generation
        : undefined;
    if (authorized.kind === 'current') this.retryAttributionsOf(params.client);
    const admitted =
      authorized.kind === 'current'
        ? this.revalidateAdmission(
            params.client,
            authorizedGeneration ?? authorized.scope.envelope.generation,
          )
        : authorized;
    if (admitted.kind === 'stale') {
      const owner =
        admitted.scope ??
        this.scopes.get(
          scopeKey(params.client.projectId, params.client.worktreeId),
        );
      if (!owner)
        throw new Error('The terminal retirement has no durable receipt.');
      const requestGeneration =
        authorizedGeneration ?? params.generation ?? params.client.generation;
      const fence = owner.retirement?.publication.image;
      if (
        fence &&
        ((requestGeneration !== undefined &&
          requestGeneration <= fence.generation) ||
          (params.client.lifetimeId !== undefined &&
            fence.retiredLifetimeIds?.includes(params.client.lifetimeId)))
      )
        this.receipt(owner, {
          kind: 'fence',
          ...(requestGeneration !== undefined &&
          requestGeneration <= fence.generation
            ? { generation: requestGeneration }
            : {
                lifetimeIds: params.client.lifetimeId
                  ? [params.client.lifetimeId]
                  : [],
              }),
        });
      else {
        const image = this.receipt(owner, { kind: 'record' });
        if (
          !(
            (requestGeneration !== undefined &&
              image.generation > requestGeneration) ||
            (params.client.lifetimeId !== undefined &&
              image.retiredLifetimeIds?.includes(params.client.lifetimeId))
          )
        )
          throw new Error(
            'The terminal lifetime has no durable supersession receipt.',
          );
      }
      return {
        outcome: 'dropped',
        revision: admitted.revision,
        generation: admitted.generation,
      };
    }
    const { scope } = admitted;
    this.assertImported(scope);
    const current = scope.envelope;
    const answer = (
      outcome: WorkerTerminalRecordApplyResult['outcome'],
    ): WorkerTerminalRecordApplyResult => ({
      outcome,
      revision: current.revision,
      generation: current.generation,
    });
    if (params.seq <= (current.producerWatermarks[producer] ?? 0)) {
      // A recovered watermark must not release the producer's replay copy
      // until the previous rename is known durable. Reads may still serve it.
      this.receipt(scope, { kind: 'record', producer, seq: params.seq });
      this.log('Terminal record batch already applied', {
        producer: params.producer.id,
        seq: params.seq,
      });
      return answer('duplicate');
    }
    // The candidate includes the watermark: uncertainty retains this exact
    // image for retry, while a prepublication failure can still roll it back.
    const draft = structuredClone(current);
    const historyRevisions = new Map(scope.historyRevisions);
    const historyChanged = (terminalId: string): void => {
      historyRevisions.set(
        terminalId,
        nextCounter(historyRevisions.get(terminalId) ?? 0, 'history revision'),
      );
    };
    const replaced = new Set<string>();
    for (const op of params.ops) {
      if (op.op === 'session.upsert' && isDrawerOwnedTerminal(op.session))
        replaced.add(op.session.id);
      this.applyOp(scope, draft, op, historyChanged, replaced);
    }
    setOwn(draft.producerWatermarks, producer, params.seq);
    if (params.sealed)
      // This v3 format has no deployed writer (the slice is inert). Stored
      // seals use canonical producer/run keys. Raw-run development snapshots
      // are unsupported, not migrated by guessing provenance from watermarks.
      setOwn(draft.runs, producer, {
        sealed: { reason: params.sealed.reason, at: this.now() },
      });
    draft.revision = nextCounter(draft.revision, 'revision');
    scope.envelope = draft;
    if (!this.installNow(scope)) {
      // Only a prepublication failure may roll back the candidate. A visible
      // candidate is kept for exact-once retry, even before its receipt is durable.
      if (
        scope.publication.state === 'unpublished' ||
        (scope.publication.image !== draft &&
          (scope.publication.image.revision !== draft.revision ||
            scope.publication.image.lineage !== draft.lineage))
      )
        scope.envelope = current;
      else {
        for (const terminalId of replaced)
          this.supersedeShutdownStamps(scope, terminalId, draft.revision);
        for (const [terminalId, revision] of historyRevisions)
          scope.historyRevisions.set(terminalId, revision);
      }
      throw new Error('The terminal record could not be installed.');
    }
    for (const terminalId of replaced)
      this.supersedeShutdownStamps(scope, terminalId, draft.revision);
    for (const [terminalId, revision] of historyRevisions)
      scope.historyRevisions.set(terminalId, revision);
    this.receipt(scope, { kind: 'record', producer, seq: params.seq });
    return {
      outcome: 'applied',
      revision: draft.revision,
      generation: draft.generation,
    };
  }

  private applyOp(
    scope: Scope,
    envelope: TerminalRecordEnvelope,
    op: WorkerTerminalRecordOp,
    historyChanged: (terminalId: string) => void,
    replaced: Set<string>,
  ): void {
    applyTerminalRecordOp(envelope.record, op, {
      // Producer admission waits for import: no future legacy merge needs a marker.
      trackHistoryTruncation: false,
      historyChanged,
      forgotten: (terminalId) => {
        replaced.add(terminalId);
        historyChanged(terminalId);
        envelope.hostTerminals = envelope.hostTerminals.filter(
          (id) => id !== terminalId,
        );
      },
      // A referenced live daemon terminal forgotten earlier rejoins.
      liveSession: (terminalId) => {
        const host = this.boundOwner(scope, terminalId);
        if (!host?.attribution.persist) return null;
        if (!envelope.hostTerminals.includes(terminalId))
          envelope.hostTerminals.push(terminalId);
        return host.attribution.session;
      },
    });
  }

  /**
   * Retires the records of the worktrees a request names. A cutoff request
   * naming no worktree, or marked `projectWide`, also reaches the project's
   * worktree records on disk that started before its cutoff (CAN-7704). A
   * record of another known incarnation, or newer than the generation named,
   * is left alone.
   */
  public retire(params: WorkerTerminalRecordRetireParams): { retired: number } {
    if (params.generation !== undefined)
      nextCounter(params.generation, 'generation');
    const namedOnly = namesOnlyRetirement(params);
    if (namedOnly && params.lifetimeIds?.length === 0) return { retired: 0 };
    const { repository } = this.options;
    const named = new Set([
      ...(params.worktreeId !== undefined ? [params.worktreeId] : []),
      ...(params.worktreeIds ?? []),
    ]);
    // Named worktrees are the whole selection unless `projectWide` widens it.
    // Discovery needs a cutoff: it is the only bound that keeps a retry from
    // reaching a later worktree.
    const discovered =
      (named.size === 0 || params.projectWide === true) &&
      params.requestedAt !== undefined
        ? repository.worktreesOf(params.projectId)
        : [];
    let retired = 0;
    for (const worktreeId of new Set([...named, ...discovered])) {
      const key = scopeKey(params.projectId, worktreeId);
      // Observational: the decision never quarantines or prunes recovery copies.
      const observed = this.peek({
        projectId: params.projectId,
        worktreeId,
        incarnation: null,
        legacyLayout: 'workspaces',
      });
      const record =
        observed.kind === 'live' ? observed.scope.envelope : undefined;
      const fence = observed.scope?.retirement?.publication.image;
      const isNamed = named.has(worktreeId);
      // A discovered scope is reached only through a record started before the
      // cutoff, even one its selectors identify, or through an existing fence.
      if (
        !isNamed &&
        (record
          ? record.startedAt === undefined ||
            params.requestedAt === undefined ||
            record.startedAt >= params.requestedAt
          : observed.kind !== 'tombstone')
      )
        continue;
      const covered = new Set<DeferredLifetime>();
      for (const terminalId of this.admissions.get(key)?.waiting ?? []) {
        const pending = this.registrations.get(terminalId);
        if (!pending) continue;
        const { lifetime, attribution } = pending;
        const intended = deferredGeneration(lifetime);
        const named =
          attribution.client.lifetimeId !== undefined &&
          params.lifetimeIds?.includes(attribution.client.lifetimeId) === true;
        if (
          (params.lifetimeIds === undefined || named) &&
          (params.generation === undefined ||
            (intended === undefined
              ? named || !fenceSuccessor(params, fence, lifetime)
              : intended <= params.generation)) &&
          (params.incarnation == null ||
            attribution.client.incarnation === null ||
            attribution.client.incarnation === params.incarnation) &&
          (params.requestedAt === undefined ||
            lifetime.requestedAt <= params.requestedAt ||
            named)
        )
          covered.add(lifetime);
      }
      const generation = record?.generation ?? fence?.generation ?? 0;
      const incarnation = record?.incarnation ?? null;
      const lifetimeIds = Array.from(
        new Set([
          ...(params.lifetimeIds ?? []),
          ...Array.from(this.admissions.get(key)?.waiting ?? []).flatMap(
            (terminalId): string[] => {
              const pending = this.registrations.get(terminalId);
              const id = pending?.attribution.client.lifetimeId;
              return pending && covered.has(pending.lifetime) && id ? [id] : [];
            },
          ),
        ]),
      );
      // An absent scope gains a cached owner only after fence publication.
      const owner: Scope = observed.scope ?? {
        key,
        lifetimeVersion: 0n,
        envelope: repository.empty(
          {
            projectId: params.projectId,
            worktreeId,
            generation: 1,
            incarnation: null,
          },
          'none',
        ),
        pendingInstall: false,
        publication: { state: 'unpublished', error: undefined },
        confirmationFailed: false,
        shutdownStamps: new Set(),
        timer: undefined,
        historyEpoch: randomUUID(),
        historyRevisions: new Map(),
      };
      const decision = this.retirementDecision(
        owner,
        params,
        record,
        lifetimeIds,
        covered,
      );
      // A discovered scope without a record gains no new fence: only an
      // existing one that covers the request is confirmed and its debt retried.
      if (
        !isNamed &&
        record === undefined &&
        decision.kind !== 'already-covered'
      )
        continue;
      if (record && !preservesRecord(decision)) {
        // A qualified retirement of this record identifies the predecessor of
        // a surviving already-authorized successor, without creating its
        // lifetime here. A preserved record is no successor's predecessor.
        for (const terminalId of this.admissions.get(key)?.waiting ?? []) {
          const pending = this.registrations.get(terminalId);
          if (
            pending &&
            !covered.has(pending.lifetime) &&
            pending.lifetime.admission.kind === 'unresolved' &&
            pending.lifetime.admission.generation === undefined &&
            !pending.lifetime.admission.predecessor &&
            pending.lifetime.order >=
              (this.admissions.get(key)?.transition ?? 0n) &&
            pending.attribution.client.incarnation !== null &&
            incarnation !== null &&
            pending.attribution.client.incarnation !== incarnation &&
            (params.generation === generation ||
              params.incarnation === incarnation)
          )
            pending.lifetime.admission.predecessor = {
              generation,
              incarnation,
            };
        }
      }
      // Counts recorded scope fences, not physically deleted records.
      retired += this.executeRetirement(owner, decision, covered);
    }
    return { retired };
  }

  /** Installs every pending record, then throws if any scope failed. */
  public flushSync(): void {
    const failures: Error[] = [];
    for (const scope of this.scopes.values()) {
      if (this.peekOwner(scope).kind !== 'live') continue;
      if (scope.pendingInstall && !this.installNow(scope))
        failures.push(new Error('The terminal record could not be installed.'));
    }
    if (failures.length > 0)
      throw new Error(
        `Terminal record flush failed for ${failures.length} scopes.`,
      );
  }

  /** The daemon's last retry: attempt every live scope before surfacing debt. */
  public finalFlushSync(): void {
    let attributionRetryFailed = false;
    try {
      this.retryAttributions();
    } catch {
      attributionRetryFailed = true;
    }
    const pendingAttributions = this.pendingRegistrations().filter(
      (pending) => pending.attribution.persist,
    ).length;
    let failedScopes = 0;
    for (const scope of this.scopes.values()) {
      try {
        if (this.peekOwner(scope).kind !== 'live') continue;
        if (scope.pendingInstall && !this.installNow(scope)) failedScopes += 1;
      } catch {
        failedScopes += 1;
      }
    }
    if (failedScopes > 0 || pendingAttributions > 0 || attributionRetryFailed)
      throw new Error(
        `Terminal record flush failed for ${failedScopes} scopes.` +
          (attributionRetryFailed ? ' Attribution retry failed.' : '') +
          (pendingAttributions > 0
            ? ` ${pendingAttributions} persisted terminals still await attribution.`
            : ''),
      );
  }

  /** Cancels deferred work when the host releases this authority. */
  public dispose(): void {
    if (this.attributionTimer !== undefined)
      clearTimeout(this.attributionTimer);
    this.attributionTimer = undefined;
    for (const scope of this.scopes.values()) {
      if (scope.timer !== undefined) clearTimeout(scope.timer);
      scope.timer = undefined;
    }
  }

  /** Whether a terminal is attributed to a live scope (test seam). */
  public isAttributed(terminalId: string): boolean {
    return this.liveScope(this.currentByTerminalId.get(terminalId)) !== null;
  }
}
