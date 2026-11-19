// ---------------------------------------------------------------------------
// A cloud chat's delegates, live, over the web core (CAN-6303).
//
// The chat's transcript names each delegate on its Delegate Task card; this
// store reads their current state with `core.managedDelegation.list` and
// stops them with `core.managedDelegation.stop` / `.stopAll`, the operations
// the chat's agent uses too. It reads while a view watches the chat: again
// every few seconds while any delegate is live, and once whenever the view
// reports a change (a new card, a turn). The list returns open delegations
// only, so a card's delegate it no longer returns (stopped, or ended with its
// session) is read once with `core.managedDelegation.get` and kept as final.
// Nothing is cached past the last watcher.
// ---------------------------------------------------------------------------

import {
  CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS,
  CORE_MANAGED_DELEGATION_QUERY_DEFINITIONS,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import {
  isAgentDelegationSnapshotValue,
  type AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';
import type { CoreCoworkInvoker } from './invoker';

const LIST =
  CORE_MANAGED_DELEGATION_QUERY_DEFINITIONS['core.managedDelegation.list'];
const GET =
  CORE_MANAGED_DELEGATION_QUERY_DEFINITIONS['core.managedDelegation.get'];
const STOP =
  CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS[
    'core.managedDelegation.stop'
  ];
const STOP_ALL =
  CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS[
    'core.managedDelegation.stopAll'
  ];

/** How often a chat with a live delegate is read again. */
export const LIVE_DELEGATION_POLL_MS = 4_000;
/** The most list pages one read follows (100 delegates each). */
const MAX_LIST_PAGES = 5;
/** The most closed delegates one read looks up one by one. */
const MAX_CLOSED_READS = 10;
/**
 * Reads of one closed delegate that fail before the store stops polling
 * for it; it still keeps its last snapshot, and the next refresh (a new
 * card, a turn, a stop) retries it.
 */
const MAX_CLOSED_READ_FAILURES = 5;

/** The chat on the web core: its project, task and own id. */
export interface CloudDelegationChatScope {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

export interface CloudManagedDelegationsView {
  /** The latest snapshot of each delegate read, by id. */
  readonly snapshots: ReadonlyMap<string, AgentDelegationSnapshot>;
  /** True once a read answered for this chat. */
  readonly loaded: boolean;
  /**
   * Delegates whose state a read has settled: the list returned them, their
   * own read answered or was refused, or a read failed and they keep what
   * was last read of them. A child page waits for its delegate here rather
   * than show the state its first card recorded (CAN-6789).
   */
  readonly settled: ReadonlySet<string>;
  /**
   * Per delegate, bumps whenever its lifecycle changes: a reader of its
   * child chat reads the newest page again (the cloud has no child stream
   * revision to hint with). A sibling's change leaves it alone, and so does
   * usage: the shared child window starts over on every epoch, so a running
   * delegate's cost ticks would reset an open page every read.
   */
  readonly epochs: ReadonlyMap<string, number>;
  /**
   * The web core doesn't serve this chat's delegates (its rollout flag is
   * off, or the chat isn't the caller's): its cards keep what they say.
   */
  readonly unavailable: boolean;
}

const EMPTY_VIEW: CloudManagedDelegationsView = {
  snapshots: new Map(),
  loaded: false,
  settled: new Set(),
  epochs: new Map(),
  unavailable: false,
};

/** What a delegate's child chat reader reloads on: its lifecycle. */
function changeSignature(snapshot: AgentDelegationSnapshot): string {
  return JSON.stringify([
    snapshot.status,
    snapshot.phase ?? null,
    snapshot.runGeneration ?? 1,
    snapshot.resultIndex ?? null,
  ]);
}

/** Refusals another read of the same chat would only repeat. */
const FINAL_REFUSALS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'capability_unavailable',
  'not_found',
  'permission_denied',
  'invalid_argument',
]);

/** Whether a delegate may still change by itself. */
export function isLiveDelegationSnapshot(
  snapshot: Pick<AgentDelegationSnapshot, 'status'>,
): boolean {
  return snapshot.status === 'pending' || snapshot.status === 'running';
}

/** A refused stop, in the operation's own words. */
export class CloudDelegationStopError extends Error {
  readonly kind: CanopyErrorPayload['kind'];

  constructor(error: CanopyErrorPayload) {
    super(error.message);
    this.name = 'CloudDelegationStopError';
    this.kind = error.kind;
  }
}

interface ChatEntry {
  scope: CloudDelegationChatScope;
  invoker: CoreCoworkInvoker;
  view: CloudManagedDelegationsView;
  watchers: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumps on every read started, so only the newest one lands. */
  readSequence: number;
  reading: boolean;
  /** A change arrived while a read ran: read once more after it. */
  rereadQueued: boolean;
  /** The delegates the chat's cards name, and every one the list showed. */
  tracked: ReadonlySet<string>;
  /** Views that report the parent's turn running: read while any does. */
  active: number;
  /** Final snapshots of tracked delegates the list no longer returns. */
  closed: Map<string, AgentDelegationSnapshot>;
  /**
   * Failed reads of a closed delegate, by id; a refusal counts as spent for
   * good, other failures until the next refresh.
   */
  closedFailures: Map<string, number>;
  /** Closed delegates Core refused to read: never read again. */
  closedRefused: Set<string>;
  /** Each delegate's last change signature, for its epoch. */
  signatures: Map<string, string>;
}

function scopeKey(scope: CloudDelegationChatScope): string {
  return JSON.stringify([scope.workspaceId, scope.worktreeId, scope.chatId]);
}

function chatParams(scope: CloudDelegationChatScope): Record<string, unknown> {
  return {
    scope: { workspaceId: scope.workspaceId, worktreeId: scope.worktreeId },
    chatId: scope.chatId,
  };
}

/** A keyed instruction's params with a fresh key per attempt. */
function keyed(params: Record<string, unknown>): Record<string, unknown> {
  return { ...params, _meta: { idempotencyKey: crypto.randomUUID() } };
}

class CloudManagedDelegationStore {
  private readonly chats = new Map<string, ChatEntry>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The chat's view; a stable empty one before its first read. */
  view(scope: CloudDelegationChatScope): CloudManagedDelegationsView {
    return this.chats.get(scopeKey(scope))?.view ?? EMPTY_VIEW;
  }

  /**
   * Starts reading the chat's delegates until the returned release; several
   * views of one chat share one read loop.
   */
  watch(
    invoker: CoreCoworkInvoker,
    scope: CloudDelegationChatScope,
  ): () => void {
    const key = scopeKey(scope);
    let entry = this.chats.get(key);
    if (entry === undefined || entry.invoker !== invoker) {
      if (entry !== undefined) clearTimeout(entry.timer);
      entry = {
        scope,
        invoker,
        view: entry?.view ?? EMPTY_VIEW,
        watchers: entry?.watchers ?? 0,
        timer: undefined,
        readSequence: 0,
        reading: false,
        rereadQueued: false,
        tracked: entry?.tracked ?? new Set(),
        active: entry?.active ?? 0,
        closed: entry?.closed ?? new Map<string, AgentDelegationSnapshot>(),
        closedFailures: entry?.closedFailures ?? new Map<string, number>(),
        closedRefused: entry?.closedRefused ?? new Set(),
        signatures: entry?.signatures ?? new Map<string, string>(),
      };
      this.chats.set(key, entry);
    }
    entry.watchers += 1;
    this.refresh(scope);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.chats.get(key);
      if (current === undefined) return;
      current.watchers -= 1;
      if (current.watchers > 0) return;
      clearTimeout(current.timer);
      this.chats.delete(key);
      this.emit();
    };
  }

  /**
   * Adds delegates a view's cards name; a new one is read at once. A tracked
   * delegate the list doesn't return is read on its own.
   */
  track(
    scope: CloudDelegationChatScope,
    delegationIds: readonly string[],
  ): void {
    const entry = this.chats.get(scopeKey(scope));
    if (entry === undefined) return;
    const added = delegationIds.filter((id) => !entry.tracked.has(id));
    if (added.length === 0) return;
    // Every view of the chat adds the cards it shows; none removes another's.
    entry.tracked = new Set([...entry.tracked, ...added]);
    this.refresh(scope);
  }

  /**
   * Marks the parent's turn running until the returned release: its agent
   * may follow up on or steer a settled delegate, which starts a new run
   * the list would show only on a later read, so the chat is read while
   * any view says so.
   */
  holdActive(scope: CloudDelegationChatScope): () => void {
    const entry = this.chats.get(scopeKey(scope));
    if (entry === undefined) return () => undefined;
    entry.active += 1;
    if (entry.active === 1 && entry.timer === undefined && !entry.reading)
      this.refresh(scope);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.active = Math.max(0, entry.active - 1);
    };
  }

  /** Reads the chat again now (a new card, a turn); no-op unless watched. */
  refresh(scope: CloudDelegationChatScope): void {
    const entry = this.chats.get(scopeKey(scope));
    if (entry === undefined) return;
    // Something changed: a closed delegate whose reads failed is worth
    // another try (one Core refused is not).
    entry.closedFailures.clear();
    if (entry.reading) {
      entry.rereadQueued = true;
      return;
    }
    clearTimeout(entry.timer);
    entry.timer = undefined;
    void this.read(entry);
  }

  /** Stops one delegate and its own delegates, as the user. */
  async stop(
    invoker: CoreCoworkInvoker,
    scope: CloudDelegationChatScope,
    delegationId: string,
  ): Promise<void> {
    const reply = await invoker.request(
      'core.managedDelegation.stop',
      keyed({ ...chatParams(scope), delegationId }),
    );
    this.refresh(scope);
    if (!reply.ok) throw new CloudDelegationStopError(reply.error);
    STOP.result.parse(reply.value);
  }

  /** Stops every live delegate of the chat; new ones wait until it ends. */
  async stopAll(
    invoker: CoreCoworkInvoker,
    scope: CloudDelegationChatScope,
  ): Promise<number> {
    const reply = await invoker.request(
      'core.managedDelegation.stopAll',
      keyed(chatParams(scope)),
    );
    this.refresh(scope);
    if (!reply.ok) throw new CloudDelegationStopError(reply.error);
    return STOP_ALL.result.parse(reply.value).stopped;
  }

  private async read(entry: ChatEntry): Promise<void> {
    entry.reading = true;
    entry.rereadQueued = false;
    const sequence = ++entry.readSequence;
    const snapshots = new Map<string, AgentDelegationSnapshot>();
    let answered = false;
    let refused = false;
    let unresolved = false;
    // Delegates this read couldn't settle: they keep their last snapshot,
    // which says nothing about whether they still run.
    const stale = new Set<string>();
    // Delegates this read has an answer for, or stopped waiting on.
    const settled = new Set(entry.view.settled);
    try {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const reply = await entry.invoker.request(
          'core.managedDelegation.list',
          {
            ...chatParams(entry.scope),
            ...(cursor === null ? {} : { cursor }),
          },
        );
        if (!reply.ok) {
          refused = FINAL_REFUSALS.has(reply.error.kind);
          answered = false;
          break;
        }
        const parsed = LIST.result.safeParse(reply.value);
        if (!parsed.success) break;
        for (const snapshot of parsed.data.items)
          if (isAgentDelegationSnapshotValue(snapshot))
            snapshots.set(snapshot.delegationId, snapshot);
        // A delegate once listed is read on its own after it closes too.
        entry.tracked = new Set([...entry.tracked, ...snapshots.keys()]);
        answered = true;
        cursor = parsed.data.nextCursor;
        if (cursor === null) break;
      }
      // A card's delegate the list left out is closed: read its final state.
      if (answered) {
        const unread = Array.from(entry.tracked).filter(
          (id) => !snapshots.has(id) && !entry.closed.has(id),
        );
        const readable = (id: string): boolean =>
          !entry.closedRefused.has(id) &&
          (entry.closedFailures.get(id) ?? 0) < MAX_CLOSED_READ_FAILURES;
        // One no longer read keeps what was last read of it.
        for (const id of unread.filter((id) => !readable(id))) {
          const last = entry.view.snapshots.get(id);
          if (last !== undefined) snapshots.set(id, last);
          stale.add(id);
          settled.add(id);
        }
        const missing = unread.filter(readable);
        unresolved = missing.length > MAX_CLOSED_READS;
        for (const id of missing.slice(0, MAX_CLOSED_READS)) {
          const read = await this.readOne(entry, id);
          // Read or not, a page stops waiting for it: a failure shows what
          // was last read until a later read lands.
          settled.add(id);
          if (read.kind === 'snapshot') {
            if (isLiveDelegationSnapshot(read.snapshot))
              snapshots.set(id, read.snapshot);
            else entry.closed.set(id, read.snapshot);
            continue;
          }
          // Until it reads, the delegate keeps what was last read of it.
          const last = entry.view.snapshots.get(id);
          if (last !== undefined) snapshots.set(id, last);
          stale.add(id);
          // A refusal is final; anything else is read again later.
          if (read.kind === 'refused') entry.closedRefused.add(id);
          else {
            unresolved = true;
            entry.closedFailures.set(
              id,
              (entry.closedFailures.get(id) ?? 0) + 1,
            );
          }
        }
      }
    } catch {
      // Offline or closed: the view keeps its last answer.
    } finally {
      entry.reading = false;
    }
    const current = this.chats.get(scopeKey(entry.scope));
    if (current !== entry || sequence !== entry.readSequence) return;
    for (const id of snapshots.keys()) settled.add(id);
    if (!answered && !refused) {
      // A failed read leaves every tracked delegate as last read: a page
      // waiting on one shows that rather than wait out the outage.
      const before = entry.view.settled.size;
      for (const id of entry.tracked) settled.add(id);
      if (settled.size !== before) {
        entry.view = { ...entry.view, settled };
        this.emit();
      }
    }
    if (answered || refused) {
      if (refused) {
        entry.view = {
          snapshots: new Map(),
          loaded: true,
          settled,
          epochs: entry.view.epochs,
          unavailable: true,
        };
      } else {
        for (const id of snapshots.keys()) entry.closed.delete(id);
        const merged = new Map([...entry.closed, ...snapshots]);
        const epochs = new Map(entry.view.epochs);
        for (const [id, snapshot] of merged) {
          const signature = changeSignature(snapshot);
          if (entry.signatures.get(id) === signature) continue;
          entry.signatures.set(id, signature);
          epochs.set(id, (epochs.get(id) ?? 0) + 1);
        }
        entry.view = {
          snapshots: merged,
          loaded: true,
          settled,
          epochs,
          unavailable: false,
        };
      }
      this.emit();
    }
    if (refused) return;
    if (entry.rereadQueued) {
      void this.read(entry);
      return;
    }
    // A delegate no longer read isn't known to run: only the list says so.
    const live = Array.from(entry.view.snapshots).some(
      ([id, snapshot]) => !stale.has(id) && isLiveDelegationSnapshot(snapshot),
    );
    // Live delegates change by themselves; a failed read tries again too.
    if (live || !answered || unresolved || entry.active > 0)
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (this.chats.get(scopeKey(entry.scope)) === entry)
          void this.read(entry);
      }, LIVE_DELEGATION_POLL_MS);
  }

  /** One delegate's snapshot, or why it couldn't be read. */
  private async readOne(
    entry: ChatEntry,
    delegationId: string,
  ): Promise<
    | { readonly kind: 'snapshot'; readonly snapshot: AgentDelegationSnapshot }
    | { readonly kind: 'refused' | 'failed' }
  > {
    try {
      const reply = await entry.invoker.request('core.managedDelegation.get', {
        ...chatParams(entry.scope),
        delegationId,
      });
      if (!reply.ok)
        return {
          kind: FINAL_REFUSALS.has(reply.error.kind) ? 'refused' : 'failed',
        };
      const parsed = GET.result.safeParse(reply.value);
      return parsed.success && isAgentDelegationSnapshotValue(parsed.data)
        ? { kind: 'snapshot', snapshot: parsed.data }
        : { kind: 'failed' };
    } catch {
      return { kind: 'failed' };
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The page's one store: every view of a chat shares its reads. */
export type { CloudManagedDelegationStore };

/** A store of cloud chats' delegates; each host keeps one. */
export function createCloudManagedDelegationStore(): CloudManagedDelegationStore {
  return new CloudManagedDelegationStore();
}
