import {
  hydrateChatTurnState,
  initialChatTurnState,
  reduceChatTurn,
  reduceChatTurnHostEvent,
  serializeChatTurnState,
  settleChatTurnForStop,
} from '@canopy/agent-transcript/turn';
import type {
  ChatTurnEffect,
  ChatTurnRecord,
  ChatTurnHostPauseEvent,
  ChatTurnState,
  PersistedChatTurnState,
} from '@canopy/agent-transcript/turn';
import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import type { TurnLifecycleOwnership } from './chat-turn-phase';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';

export interface ChatTurnStateScope {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export type ChatTurnStateHandoffScope = ChatTurnStateScope;

export type ChatTurnStateChangeCause =
  | 'lifecycle'
  | 'pause'
  | 'hydrate'
  | 'restart'
  | 'reset';

export interface ChatTurnStateChange {
  scope: ChatTurnStateScope;
  state: PersistedChatTurnState;
  effects: readonly ChatTurnEffect[];
  generation: number;
  /** The producing entry; generations restart when eviction recreates it. */
  incarnation?: number;
  cause: ChatTurnStateChangeCause;
}

export interface ChatTurnStateCommit {
  effects?: readonly ChatTurnEffect[];
  lifecycle?: readonly TurnLifecycleOwnership[];
  timerMessages?: readonly PersistedChatMessage[];
  /** The tab's Auto-routed models by user message id, for the timer chip. */
  autoRoutedModels?: Readonly<Record<string, string>>;
  scope: ChatTurnStateScope;
  state: PersistedChatTurnState;
  generation: number;
  /** See {@link ChatTurnStateChange.incarnation}. */
  incarnation?: number;
}

export type ChatTurnPauseObservation = {
  type: 'PauseOpened' | 'PauseClosed';
  ownerKind: 'approval' | 'question';
  ownerId: string;
  turnId?: string;
  atMs?: number;
};

export interface ChatTurnStateHandoffSnapshot {
  readonly key: string;
  readonly identity: number;
  readonly generation: number;
  readonly scope: ChatTurnStateHandoffScope;
  readonly turn: PersistedChatTurnState;
  /** Ordered, unacknowledged effects through this snapshot's generation. */
  readonly effects?: readonly ChatTurnEffect[];
  readonly lifecycle?: readonly TurnLifecycleOwnership[];
  /** Latest retained record per T, including intermediate executions. */
  readonly turnRecords?: readonly ChatTurnRecord[];
  /** Set on a staged Stop's snapshot; only that exact stage may adopt it. */
  readonly stageToken?: number;
}

/**
 * An explicit Stop reduced into a draft that only its owning transaction can
 * see. It is published only when that transaction's repository commit
 * applies; otherwise it is discarded and leaves no trace for a fallback.
 */
export interface ChatTurnStopStage {
  readonly key: string;
  readonly identity: number;
  readonly generation: number;
  readonly token: number;
  readonly scope: ChatTurnStateHandoffScope;
}

interface StagedStop {
  readonly token: number;
  readonly generation: number;
  readonly state: ChatTurnState;
  readonly effects: readonly ChatTurnEffect[];
  readonly journal: JournalGeneration;
  /** Resolves once the stage is published or dropped. */
  readonly settled: Promise<void>;
  readonly release: () => void;
}

interface PauseRequest {
  readonly kind: 'pause';
  readonly value: ChatTurnPauseObservation;
  readonly hostSequence: number;
}

type QueuedTurnEvent =
  | { readonly kind: 'lifecycle'; readonly value: ChatTurnLifecycleEvent }
  | PauseRequest;

interface JournalGeneration {
  readonly generation: number;
  readonly effects: readonly ChatTurnEffect[];
  readonly lifecycle: readonly TurnLifecycleOwnership[];
  readonly turnRecords: readonly ChatTurnRecord[];
}

interface HandoffEntry {
  readonly journal: JournalGeneration[];
  readonly key: string;
  readonly identity: number;
  readonly scope: ChatTurnStateHandoffScope;
  state: ChatTurnState;
  generation: number;
  durableGeneration: number;
  hostSequence: number;
  readonly pendingEvents: QueuedTurnEvent[];
  readonly pausedOwners: Map<string, string>;
  loading: Promise<void>;
  /** The persisted state has been read (or failed to read) into `state`. */
  loaded: boolean;
  /** A canonical restart transaction is preparing to replace this state. */
  restartPending: boolean;
  /** Suppress reentrant receipts while an invalidation is being published. */
  invalidating: boolean;
  /** A monotonic repository acknowledgement makes older generations duplicates. */
  committedGeneration: number;
  timer?: ReturnType<typeof setTimeout>;
  flushing?: Promise<void>;
  /**
   * A Stop awaiting its repository commit. While set, receipts queue
   * unreduced, the fallback is suspended, and neither the live state nor a
   * snapshot is exposed to anyone but the stage's owner.
   */
  stagedStop?: StagedStop;
  disposed: boolean;
}

export interface ChatTurnStateHandoffOptions {
  load: (scope: ChatTurnStateHandoffScope) => Promise<unknown>;
  /** `written` is the snapshot actually committed, when it differs from the request. */
  commit: (snapshot: ChatTurnStateHandoffSnapshot) => Promise<{
    applied: boolean;
    written?: ChatTurnStateHandoffSnapshot;
    /** The timer rows the commit wrote, passed on to commit listeners. */
    timerMessages?: readonly PersistedChatMessage[];
    autoRoutedModels?: Readonly<Record<string, string>>;
  }>;
  onReduced?: (
    scope: ChatTurnStateHandoffScope,
    event: ChatTurnLifecycleEvent,
    state: ChatTurnState,
    effects: readonly ChatTurnEffect[],
  ) => void;
  onChange?: (change: ChatTurnStateChange) => void;
  onCommitted?: (commit: ChatTurnStateCommit) => void;
  now?: () => number;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  fallbackDelayMs?: number;
  onError?: (error: unknown) => void;
}

const DEFAULT_FALLBACK_DELAY_MS = 2_000;
const MAX_ENTRIES = 512;

function keyFor(scope: ChatTurnStateHandoffScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]);
}

function pauseOwnerKey(
  ownerKind: ChatTurnPauseObservation['ownerKind'],
  ownerId: string,
): string {
  return `${ownerKind}\u0000${ownerId}`;
}

function persistedTurn(value: unknown): ChatTurnState {
  return hydrateChatTurnState(value) ?? initialChatTurnState();
}

function serializedTurn(value: unknown): PersistedChatTurnState {
  return serializeChatTurnState(persistedTurn(value));
}

function hasDurableChanges(
  before: ChatTurnState,
  after: ChatTurnState,
): boolean {
  return (
    JSON.stringify(serializeChatTurnState(before)) !==
    JSON.stringify(serializeChatTurnState(after))
  );
}

/**
 * Bridges provider-host observations into the chat-state transaction stream.
 * Provider cursors remain process-local; only serialized reducer state crosses
 * the repository boundary.
 */
export class ChatTurnStateHandoff {
  private readonly entries = new Map<string, HandoffEntry>();
  private readonly recentResetKeys = new Map<string, number>();
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly fallbackDelayMs: number;
  private readonly onError: (error: unknown) => void;
  private nextIdentity = 1;
  private nextResetSequence = 1;
  private nextStageToken = 1;
  private disposed = false;

  public constructor(private readonly options: ChatTurnStateHandoffOptions) {
    this.now = options.now ?? Date.now;
    // Resolve the globals per call so installed fake timers apply.
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs): ReturnType<typeof setTimeout> =>
        setTimeout(callback, delayMs));
    this.clearTimer =
      options.clearTimer ?? ((timer): void => clearTimeout(timer));
    this.fallbackDelayMs = Math.min(
      2_000,
      Math.max(0, options.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS),
    );
    this.onError = options.onError ?? ((): void => undefined);
  }

  public observeLifecycle(event: ChatTurnLifecycleEvent): void {
    if (this.disposed) return;
    const entry = this.getOrCreate({
      projectId: event.projectId,
      worktreeId: event.worktreeId,
      chatId: event.chatId,
    });
    entry.pendingEvents.push({ kind: 'lifecycle', value: event });
    this.scheduleFallback(entry, true);
    this.processWhenLoaded(entry);
  }

  public observePause(
    scope: ChatTurnStateHandoffScope,
    observation: ChatTurnPauseObservation,
  ): void {
    if (this.disposed) return;
    const entry = this.getOrCreate(scope);
    this.enqueuePause(entry, observation);
  }

  /** Use the transaction's already-serialized snapshot when no entry exists. */
  public observePauseFromState(
    scope: ChatTurnStateHandoffScope,
    observation: ChatTurnPauseObservation,
    persisted: unknown,
  ): void {
    if (this.disposed) return;
    const entry = this.getOrCreate(scope, persisted, true);
    this.enqueuePause(entry, observation);
  }

  /**
   * Read the installed reducer state without starting an asynchronous load.
   * Withheld while a Stop is staged: the pre-Stop state would be stale beside
   * a repository that may already hold the Stop optimistically, and the Stop
   * itself is speculative until its commit applies. Callers fall back to the
   * canonical `runtime.turn`; the stage's owner reads {@link stagedSnapshot}.
   */
  public getState(
    scope: ChatTurnStateHandoffScope,
  ): PersistedChatTurnState | undefined {
    const entry = this.entries.get(keyFor(scope));
    if (!entry || entry.disposed || !entry.loaded || entry.stagedStop)
      return undefined;
    return serializeChatTurnState(entry.state);
  }

  /**
   * Reduce an explicit Stop into a draft without touching the live entry.
   * Returns undefined when nothing settles, the entry cannot take a Stop, or
   * another Stop is already staged for the chat. The owner must resolve the
   * stage: {@link acknowledge} of its {@link stagedSnapshot} with an applied
   * commit publishes it, and {@link discardStop} drops it. Until then later receipts queue, so a discarded Stop rolls back
   * nothing else and they reduce, in order, on whichever state wins.
   */
  public stageStop(
    scope: ChatTurnStateHandoffScope,
    turnId: string,
    endedAt: number,
    persisted: unknown,
  ): ChatTurnStopStage | undefined {
    if (this.disposed) return undefined;
    const entry = this.getOrCreate(scope, persisted, true);
    this.seedFromState(scope, persisted);
    if (
      !entry.loaded ||
      entry.disposed ||
      entry.restartPending ||
      entry.invalidating ||
      entry.stagedStop
    )
      return undefined;
    const before = entry.state;
    const { state, effects } = settleChatTurnForStop(before, turnId, endedAt);
    if (effects.length === 0) return undefined;
    const generation = entry.generation + 1;
    const token = this.nextStageToken++;
    let release: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    entry.stagedStop = {
      token,
      generation,
      state,
      effects: effects.map((effect) => ({ ...effect })),
      journal: this.journalItem(generation, before, state, effects),
      settled,
      release,
    };
    // A fallback must not commit around the draft while its write is open.
    this.cancelFallback(entry);
    return {
      key: entry.key,
      identity: entry.identity,
      generation,
      token,
      scope: { ...entry.scope },
    };
  }

  /** The owner's view of its draft; undefined once published, dropped or stale. */
  public stagedSnapshot(
    stage: ChatTurnStopStage,
  ): ChatTurnStateHandoffSnapshot | undefined {
    const entry = this.stagedEntry(stage);
    const staged = entry?.stagedStop;
    if (!entry || !staged) return undefined;
    return {
      key: entry.key,
      identity: entry.identity,
      generation: staged.generation,
      scope: entry.scope,
      turn: serializeChatTurnState(staged.state),
      ...this.journalPrefix(entry, staged.generation, [staged.journal]),
      stageToken: staged.token,
    };
  }

  /**
   * Drop a Stop whose commit failed, did not apply, or did not carry its
   * snapshot; a no-op once published. Call it unconditionally when the
   * owning transaction settles.
   */
  public discardStop(stage: ChatTurnStopStage): void {
    const entry = this.stagedEntry(stage);
    const staged = entry?.stagedStop;
    if (!entry || !staged) return;
    entry.stagedStop = undefined;
    this.resumeAfterStage(entry, staged);
  }

  /** Stop a stale fallback from racing the repository's restart settlement. */
  public prepareRestart(scope: ChatTurnStateHandoffScope): void {
    if (this.disposed) return;
    const key = keyFor(scope);
    let entry = this.entries.get(key);
    if (entry?.invalidating) return;
    if (!entry || entry.disposed) {
      // An unloaded fence queues receipts that arrive while the restart
      // publishes; adopting the settlement drains them.
      entry = this.createEntry(scope, initialChatTurnState(), false);
      this.entries.set(key, entry);
      this.recentResetKeys.delete(key);
      this.trimEntries(entry);
    }
    this.cancelFallback(entry);
    entry.restartPending = true;
    // Preserve queued receipts while restart settles; success drains them from
    // the canonical settlement and failure resumes them from the old state.
  }

  /** Resume a suspended fallback when canonical restart settlement fails. */
  public cancelRestart(scope: ChatTurnStateHandoffScope): void {
    const entry = this.entries.get(keyFor(scope));
    if (!entry || entry.disposed || entry.invalidating) return;
    entry.restartPending = false;
    // A fence installed without an entry never started its load.
    if (!entry.loaded) entry.loading = this.loadEntry(entry);
    this.processWhenLoaded(entry);
    this.scheduleFallback(entry);
  }

  /** Adopt the restart transaction's durable turn without grafting a handoff snapshot. */
  public restartFromState(
    scope: ChatTurnStateHandoffScope,
    persisted: unknown,
  ): void {
    if (this.disposed) return;
    const key = keyFor(scope);
    let entry = this.entries.get(key);
    if (!entry || entry.disposed || entry.invalidating) {
      entry = this.createEntry(scope, persistedTurn(persisted), true);
      entry.generation = 1;
      entry.durableGeneration = 1;
      this.entries.set(key, entry);
      this.recentResetKeys.delete(key);
      this.trimEntries(entry);
    } else {
      this.cancelFallback(entry);
      // The restart transaction is ordered after any Stop write, so its
      // persisted turn already holds that Stop when the write applied.
      this.dropStage(entry);
      entry.state = persistedTurn(persisted);
      entry.hostSequence = Math.max(
        entry.hostSequence,
        entry.state.cursors.host ?? 0,
      );
      entry.loaded = true;
      entry.restartPending = false;
      entry.generation =
        Math.max(entry.generation, entry.durableGeneration) + 1;
      entry.durableGeneration = entry.generation;
      entry.pausedOwners.clear();
      entry.journal.length = 0;
      this.recentResetKeys.delete(key);
    }
    this.notifyChange(entry, 'restart', []);
    this.drainPending(entry);
    this.scheduleFallback(entry);
  }

  private enqueuePause(
    entry: HandoffEntry,
    observation: ChatTurnPauseObservation,
  ): void {
    const hostSequence =
      Math.max(entry.hostSequence, entry.state.cursors.host ?? 0) + 1;
    entry.hostSequence = hostSequence;
    entry.pendingEvents.push({
      kind: 'pause',
      value: observation,
      hostSequence,
    });
    this.scheduleFallback(entry, true);
    this.processWhenLoaded(entry);
  }

  /** Wait for receipt-ordered events and snapshot only unacknowledged state. */
  public async prepare(
    scope: ChatTurnStateHandoffScope,
  ): Promise<ChatTurnStateHandoffSnapshot | undefined> {
    if (this.disposed) return undefined;
    const entry = this.entries.get(keyFor(scope));
    if (!entry) return undefined;
    await this.processPending(entry);
    if (
      entry.disposed ||
      entry.restartPending ||
      entry.stagedStop !== undefined ||
      this.entries.get(entry.key) !== entry ||
      entry.generation <= entry.durableGeneration
    ) {
      return undefined;
    }
    return {
      key: entry.key,
      identity: entry.identity,
      generation: entry.generation,
      scope: entry.scope,
      turn: serializeChatTurnState(entry.state),
      ...this.journalPrefix(entry),
    };
  }

  /** Hydrates a still-loading entry from a transaction's committed turn, then reduces its queue. */
  public seedFromState(
    scope: ChatTurnStateHandoffScope,
    persisted: unknown,
  ): void {
    if (this.disposed) return;
    const entry = this.entries.get(keyFor(scope));
    if (!entry || entry.disposed || entry.invalidating || entry.loaded) return;
    entry.state = persistedTurn(persisted);
    entry.hostSequence = Math.max(
      entry.hostSequence,
      entry.state.cursors.host ?? 0,
    );
    entry.loaded = true;
    this.notifyChange(entry, 'hydrate', []);
    this.drainPending(entry);
  }

  /**
   * Reduced, unacknowledged state for a transaction that cannot await.
   * Undefined while a Stop is staged: the repository admits later
   * transactions before the Stop is durable, and they already carry it in
   * their optimistic state, so only the owner attaches it (via
   * {@link stagedSnapshot}).
   */
  public snapshotNow(
    scope: ChatTurnStateHandoffScope,
  ): ChatTurnStateHandoffSnapshot | undefined {
    if (this.disposed) return undefined;
    const entry = this.entries.get(keyFor(scope));
    if (
      !entry ||
      entry.disposed ||
      entry.restartPending ||
      entry.stagedStop !== undefined ||
      !entry.loaded ||
      entry.generation <= entry.durableGeneration
    ) {
      return undefined;
    }
    return {
      key: entry.key,
      identity: entry.identity,
      generation: entry.generation,
      scope: entry.scope,
      turn: serializeChatTurnState(entry.state),
      ...this.journalPrefix(entry),
    };
  }

  public isCurrent(snapshot: ChatTurnStateHandoffSnapshot): boolean {
    const entry = this.entries.get(snapshot.key);
    return (
      !this.disposed &&
      entry !== undefined &&
      !entry.disposed &&
      !entry.restartPending &&
      entry.identity === snapshot.identity
    );
  }

  public acknowledge(
    snapshot: ChatTurnStateHandoffSnapshot,
    applied: boolean,
    timerMessages?: readonly PersistedChatMessage[],
    autoRoutedModels?: Readonly<Record<string, string>>,
  ): void {
    const entry = this.entries.get(snapshot.key);
    let published: StagedStop | undefined;
    if (snapshot.stageToken !== undefined) {
      // Only the owner's applied commit of its own staged Stop publishes it,
      // before the acknowledgement below finds the Stop in the live journal.
      // A commit that did not apply leaves the stage for its owner to
      // discard, and a dropped or superseded stage's snapshot (whose retry
      // can reuse its generation) acknowledges nothing.
      if (
        !applied ||
        entry === undefined ||
        entry.disposed ||
        entry.invalidating ||
        entry.identity !== snapshot.identity ||
        entry.stagedStop?.token !== snapshot.stageToken ||
        entry.stagedStop.generation !== snapshot.generation
      )
        return;
      published = this.adoptStage(entry);
      if (!published) return;
    }
    if (
      !applied ||
      entry === undefined ||
      entry.disposed ||
      entry.invalidating ||
      entry.identity !== snapshot.identity
    ) {
      if (
        entry &&
        !entry.disposed &&
        !entry.invalidating &&
        entry.identity === snapshot.identity
      ) {
        this.scheduleFallback(entry);
      }
      return;
    }
    const acknowledged = {
      ...snapshot,
      ...this.journalPrefix(entry, snapshot.generation),
    };
    const notify = snapshot.generation > entry.committedGeneration;
    entry.committedGeneration = Math.max(
      entry.committedGeneration,
      snapshot.generation,
    );
    entry.durableGeneration = Math.max(
      entry.durableGeneration,
      snapshot.generation,
    );
    while (
      entry.journal[0] &&
      entry.journal[0].generation <= entry.durableGeneration
    ) {
      entry.journal.shift();
    }
    if (notify)
      this.notifyCommitted(acknowledged, timerMessages, autoRoutedModels);
    if (entry.generation > entry.durableGeneration)
      this.scheduleFallback(entry);
    else this.cancelFallback(entry);
    // Receipts queued behind the Stop reduce on the published state.
    if (published) this.resumeAfterStage(entry, published);
    this.trimEntries(entry);
  }

  /** Commit this chat's unacknowledged state now rather than on its fallback. */
  public async flush(scope: ChatTurnStateHandoffScope): Promise<void> {
    if (this.disposed) return;
    const entry = this.entries.get(keyFor(scope));
    if (!entry || entry.disposed) return;
    this.cancelFallback(entry);
    await this.processPending(entry);
    await this.flushEntry(entry);
  }

  /** Flush pending durable generations before the owning repository drains. */
  public async flushAll(): Promise<void> {
    if (this.disposed) return;
    await Promise.all(
      Array.from(this.entries.values(), async (entry) => {
        await this.processPending(entry);
        await this.flushEntry(entry);
      }),
    );
  }

  public invalidate(scope: ChatTurnStateHandoffScope): void {
    if (this.disposed) return;
    const key = keyFor(scope);
    let entry = this.entries.get(key);
    if (entry?.invalidating) return;
    if (entry?.disposed) entry = undefined;
    if (!entry && this.recentResetKeys.has(key)) return;
    if (!entry) {
      entry = this.createEntry(scope, initialChatTurnState(), true);
      this.entries.set(key, entry);
      this.trimEntries(entry);
    }
    this.cancelFallback(entry);
    this.dropStage(entry);
    entry.invalidating = true;
    entry.restartPending = false;
    entry.state = initialChatTurnState();
    entry.loaded = true;
    entry.generation = Math.max(entry.generation, entry.durableGeneration) + 1;
    entry.durableGeneration = entry.generation;
    entry.pendingEvents.length = 0;
    entry.journal.length = 0;
    entry.pausedOwners.clear();
    this.notifyChange(entry, 'reset', []);
    this.rememberReset(key);
    if (this.entries.get(key) === entry) {
      entry.disposed = true;
      this.entries.delete(key);
    }
  }

  public invalidateScope(
    scope: Pick<ChatTurnStateHandoffScope, 'projectId' | 'worktreeId'>,
  ): void {
    for (const entry of Array.from(this.entries.values())) {
      if (
        entry.scope.projectId === scope.projectId &&
        entry.scope.worktreeId === scope.worktreeId
      ) {
        this.invalidate(entry.scope);
      }
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of Array.from(this.entries.values())) {
      this.cancelFallback(entry);
      this.dropStage(entry);
      entry.disposed = true;
      entry.pendingEvents.length = 0;
      entry.journal.length = 0;
      entry.pausedOwners.clear();
    }
    this.entries.clear();
    this.recentResetKeys.clear();
  }

  private getOrCreate(
    scope: ChatTurnStateHandoffScope,
    persisted?: unknown,
    seeded = false,
  ): HandoffEntry {
    const key = keyFor(scope);
    const existing = this.entries.get(key);
    if (existing && !existing.disposed && !existing.invalidating) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    this.recentResetKeys.delete(key);
    if (existing && this.entries.get(key) === existing)
      this.entries.delete(key);
    const entry = this.createEntry(
      scope,
      seeded ? persistedTurn(persisted) : initialChatTurnState(),
      seeded,
    );
    if (!seeded) entry.loading = this.loadEntry(entry);
    this.entries.set(key, entry);
    if (seeded) this.notifyChange(entry, 'hydrate', []);
    this.trimEntries(entry);
    return entry;
  }

  private createEntry(
    scope: ChatTurnStateHandoffScope,
    state: ChatTurnState,
    loaded: boolean,
  ): HandoffEntry {
    return {
      key: keyFor(scope),
      identity: this.nextIdentity++,
      scope: { ...scope },
      state,
      generation: 0,
      durableGeneration: 0,
      hostSequence: state.cursors.host ?? 0,
      pendingEvents: [],
      journal: [],
      pausedOwners: new Map(),
      loading: Promise.resolve(),
      loaded,
      restartPending: false,
      invalidating: false,
      committedGeneration: 0,
      disposed: false,
    };
  }

  private trimEntries(entry: HandoffEntry): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldestEligible = Array.from(this.entries.values()).find(
        (candidate) =>
          candidate !== entry &&
          !candidate.disposed &&
          !candidate.invalidating &&
          !candidate.restartPending &&
          candidate.stagedStop === undefined &&
          candidate.pendingEvents.length === 0 &&
          candidate.generation <= candidate.durableGeneration &&
          candidate.flushing === undefined,
      );
      if (!oldestEligible) break;
      this.evict(oldestEligible);
    }
  }

  /** Capacity eviction forgets an idle entry; it is not a user-visible reset. */
  private evict(entry: HandoffEntry): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.cancelFallback(entry);
    this.dropStage(entry);
    entry.disposed = true;
    entry.pendingEvents.length = 0;
    entry.journal.length = 0;
    entry.pausedOwners.clear();
    this.entries.delete(entry.key);
  }

  private rememberReset(key: string): void {
    this.recentResetKeys.delete(key);
    this.recentResetKeys.set(key, this.nextResetSequence++);
    while (this.recentResetKeys.size > MAX_ENTRIES) {
      const oldest = this.recentResetKeys.keys().next();
      if (oldest.done) break;
      this.recentResetKeys.delete(oldest.value);
    }
  }

  private async loadEntry(entry: HandoffEntry): Promise<void> {
    try {
      const persisted = await this.options.load(entry.scope);
      // A transaction may have seeded the entry from newer committed state.
      if (
        entry.disposed ||
        entry.loaded ||
        this.entries.get(entry.key) !== entry
      )
        return;
      entry.state = persistedTurn(persisted);
      entry.loaded = true;
      entry.hostSequence = Math.max(
        entry.hostSequence,
        entry.state.cursors.host ?? 0,
      );
      this.notifyChange(entry, 'hydrate', []);
    } catch (error) {
      this.report(error);
      // An unavailable read must not lose received events. Start from an
      // empty state and let a later repository transaction durably carry them.
      if (
        entry.disposed ||
        entry.loaded ||
        this.entries.get(entry.key) !== entry
      )
        return;
      entry.state = initialChatTurnState();
      entry.loaded = true;
      this.notifyChange(entry, 'hydrate', []);
    }
  }

  /** Reduce now when loaded, so a transaction already running sees its own events. */
  private processWhenLoaded(entry: HandoffEntry): void {
    if (entry.restartPending || entry.invalidating || entry.disposed) return;
    if (entry.loaded) this.drainPending(entry);
    else void this.processPending(entry);
  }

  /** Waits for a staged Stop to resolve, so receipts reduce in order after it. */
  private async processPending(entry: HandoffEntry): Promise<void> {
    await entry.loading;
    while (entry.stagedStop) await entry.stagedStop.settled;
    this.drainPending(entry);
  }

  private drainPending(entry: HandoffEntry): void {
    if (
      entry.disposed ||
      entry.restartPending ||
      entry.invalidating ||
      entry.stagedStop !== undefined ||
      this.entries.get(entry.key) !== entry
    )
      return;
    while (entry.pendingEvents.length > 0) {
      const queued = entry.pendingEvents.shift();
      if (!queued) continue;
      const before = entry.state;
      let after = before;
      let effects: readonly ChatTurnEffect[] = [];
      if (queued.kind === 'lifecycle') {
        const reduction = reduceChatTurn(before, queued.value);
        after = reduction.state;
        effects = reduction.effects;
      } else {
        const ownerKey = pauseOwnerKey(
          queued.value.ownerKind,
          queued.value.ownerId,
        );
        let turnId = queued.value.turnId;
        if (queued.value.type === 'PauseOpened') {
          turnId ??= before.current?.id;
          if (turnId) entry.pausedOwners.set(ownerKey, turnId);
        } else {
          turnId ??= entry.pausedOwners.get(ownerKey);
          turnId ??= before.current?.pauses.find(
            (pause) =>
              pause.ownerKind === queued.value.ownerKind &&
              pause.ownerId === queued.value.ownerId &&
              pause.endedAtMs === undefined,
          )
            ? before.current.id
            : undefined;
          entry.pausedOwners.delete(ownerKey);
        }
        if (turnId) {
          const event: ChatTurnHostPauseEvent = {
            type: queued.value.type,
            turnId,
            ownerKind: queued.value.ownerKind,
            ownerId: queued.value.ownerId,
            atMs: queued.value.atMs ?? this.now(),
            hostSequence: queued.hostSequence,
          };
          const reduction = reduceChatTurnHostEvent(before, event);
          after = reduction.state;
          effects = reduction.effects;
        }
      }
      entry.state = after;
      if (effects.length > 0 || hasDurableChanges(before, after)) {
        entry.generation += 1;
        this.journalReduction(entry, before, effects);
        this.scheduleFallback(entry);
      }
      if (queued.kind === 'lifecycle') {
        try {
          this.options.onReduced?.(entry.scope, queued.value, after, effects);
        } catch (error) {
          this.report(error);
        }
      }
      this.notifyChange(
        entry,
        queued.kind === 'lifecycle' ? 'lifecycle' : 'pause',
        effects,
      );
    }
  }

  private journalReduction(
    entry: HandoffEntry,
    before: ChatTurnState,
    effects: readonly ChatTurnEffect[],
  ): void {
    entry.journal.push(
      this.journalItem(entry.generation, before, entry.state, effects),
    );
  }

  private journalItem(
    generation: number,
    before: ChatTurnState,
    after: ChatTurnState,
    effects: readonly ChatTurnEffect[],
  ): JournalGeneration {
    const state = serializeChatTurnState(after);
    const records = [state.lastEnded, state.current].filter(
      (record): record is ChatTurnRecord => record !== undefined,
    );
    const lifecycle: TurnLifecycleOwnership[] = [];
    const recordOwnership = (
      record: ChatTurnRecord,
      transition: TurnLifecycleOwnership['transition'],
    ): void => {
      lifecycle.push({
        turnId: record.id,
        generation,
        transition,
        inputIds: [
          ...(record.inputIds ??
            (record.userMessageId ? [record.userMessageId] : [])),
        ],
      });
    };
    for (const effect of effects) {
      if (effect.type !== 'turn.ended') continue;
      const record = records.find(
        (candidate) => candidate.id === effect.turnId,
      );
      if (record) recordOwnership(record, 'end');
    }
    if (state.current && state.current.id !== before.current?.id) {
      recordOwnership(state.current, 'start');
    } else if (
      state.current &&
      JSON.stringify(state.current.inputIds) !==
        JSON.stringify(before.current?.inputIds)
    ) {
      recordOwnership(state.current, 'binding');
    }
    return {
      generation,
      effects: effects.map((effect) => ({ ...effect })),
      lifecycle,
      turnRecords: records,
    };
  }

  private journalPrefix(
    entry: HandoffEntry,
    throughGeneration = entry.generation,
    staged: readonly JournalGeneration[] = [],
  ): Pick<
    ChatTurnStateHandoffSnapshot,
    'effects' | 'lifecycle' | 'turnRecords'
  > {
    const prefix = [...entry.journal, ...staged].filter(
      (item) =>
        item.generation > entry.durableGeneration &&
        item.generation <= throughGeneration,
    );
    const records = new Map<string, ChatTurnRecord>();
    for (const item of prefix) {
      for (const record of item.turnRecords) records.set(record.id, record);
    }
    return {
      effects: prefix.flatMap((item) =>
        item.effects.map((effect) => ({ ...effect })),
      ),
      lifecycle: prefix.flatMap((item) =>
        item.lifecycle.map((owner) => ({
          ...owner,
          inputIds: [...owner.inputIds],
        })),
      ),
      turnRecords: Array.from(records.values()).map((record) => ({
        ...record,
        inputIds: record.inputIds ? [...record.inputIds] : undefined,
        pauses: record.pauses.map((pause) => ({ ...pause })),
      })),
    };
  }

  private scheduleFallback(entry: HandoffEntry, includePending = false): void {
    if (
      this.disposed ||
      entry.disposed ||
      entry.restartPending ||
      entry.invalidating ||
      entry.stagedStop !== undefined ||
      entry.timer !== undefined ||
      (entry.generation <= entry.durableGeneration &&
        !(includePending && entry.pendingEvents.length > 0))
    ) {
      return;
    }
    const identity = entry.identity;
    entry.timer = this.setTimer(() => {
      entry.timer = undefined;
      if (
        this.disposed ||
        entry.disposed ||
        entry.restartPending ||
        entry.invalidating ||
        entry.stagedStop !== undefined ||
        entry.identity !== identity ||
        this.entries.get(entry.key) !== entry
      ) {
        return;
      }
      // Returning the promise lets async fake timers and lifecycle shutdown
      // callers observe completion of the bounded fallback transaction.
      return this.flushEntry(entry);
    }, this.fallbackDelayMs);
    entry.timer.unref?.();
  }

  /** The live entry a stage token still owns, if any. */
  private stagedEntry(stage: ChatTurnStopStage): HandoffEntry | undefined {
    if (this.disposed) return undefined;
    const entry = this.entries.get(stage.key);
    if (
      !entry ||
      entry.disposed ||
      entry.invalidating ||
      entry.identity !== stage.identity ||
      entry.stagedStop?.token !== stage.token
    )
      return undefined;
    return entry;
  }

  /** Install a committed Stop as the live state; receipts stay queued. */
  private adoptStage(entry: HandoffEntry): StagedStop | undefined {
    const staged = entry.stagedStop;
    if (!staged) return undefined;
    entry.stagedStop = undefined;
    // Nothing else advances the generation while a Stop is staged.
    if (entry.generation >= staged.generation) {
      this.resumeAfterStage(entry, staged);
      return undefined;
    }
    entry.state = staged.state;
    entry.generation = staged.generation;
    entry.journal.push(staged.journal);
    this.notifyChange(entry, 'lifecycle', staged.effects);
    return staged;
  }

  /** Release waiters and reduce the receipts queued behind a resolved stage. */
  private resumeAfterStage(entry: HandoffEntry, staged: StagedStop): void {
    staged.release();
    this.drainPending(entry);
    this.scheduleFallback(entry, true);
  }

  /** Forget a stage whose entry is reset, restarted, evicted or disposed. */
  private dropStage(entry: HandoffEntry): void {
    const staged = entry.stagedStop;
    if (!staged) return;
    entry.stagedStop = undefined;
    staged.release();
  }

  private cancelFallback(entry: HandoffEntry): void {
    if (entry.timer === undefined) return;
    this.clearTimer(entry.timer);
    entry.timer = undefined;
  }

  private async flushEntry(entry: HandoffEntry): Promise<void> {
    if (entry.flushing) {
      await entry.flushing;
      if (entry.generation > entry.durableGeneration) {
        this.scheduleFallback(entry);
      }
      return;
    }
    const task = (async (): Promise<void> => {
      await this.processPending(entry);
      const snapshot = await this.prepare(entry.scope);
      if (!snapshot) return;
      try {
        if (!this.isCurrent(snapshot)) return;
        const result = await this.options.commit(snapshot);
        this.acknowledge(
          result.written ?? snapshot,
          result.applied,
          result.timerMessages,
          result.autoRoutedModels,
        );
      } catch (error) {
        this.report(error);
        this.acknowledge(snapshot, false);
      }
    })();
    entry.flushing = task;
    try {
      await task;
    } finally {
      if (entry.flushing === task) entry.flushing = undefined;
      if (!entry.disposed && entry.generation > entry.durableGeneration) {
        this.scheduleFallback(entry);
      }
    }
  }

  private notifyChange(
    entry: HandoffEntry,
    cause: ChatTurnStateChangeCause,
    effects: readonly ChatTurnEffect[],
  ): void {
    try {
      this.options.onChange?.({
        scope: { ...entry.scope },
        state: serializeChatTurnState(entry.state),
        effects: [...effects],
        generation: entry.generation,
        incarnation: entry.identity,
        cause,
      });
    } catch (error) {
      this.report(error);
    }
  }

  private notifyCommitted(
    snapshot: ChatTurnStateHandoffSnapshot,
    timerMessages?: readonly PersistedChatMessage[],
    autoRoutedModels?: Readonly<Record<string, string>>,
  ): void {
    try {
      this.options.onCommitted?.({
        scope: { ...snapshot.scope },
        state: serializedTurn(snapshot.turn),
        generation: snapshot.generation,
        incarnation: snapshot.identity,
        effects: (snapshot.effects ?? []).map((effect) => ({ ...effect })),
        lifecycle: (snapshot.lifecycle ?? []).map((owner) => ({
          ...owner,
          inputIds: [...owner.inputIds],
        })),
        ...(timerMessages
          ? { timerMessages: structuredClone(timerMessages) }
          : {}),
        ...(autoRoutedModels
          ? { autoRoutedModels: { ...autoRoutedModels } }
          : {}),
      });
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Handoff diagnostics are observational and never escape to producers.
    }
  }
}

export function isBackgroundTurnState(
  state: PersistedChatTurnState | undefined,
): state is PersistedChatTurnState & { phase: 'background' } {
  return state?.phase === 'background';
}
