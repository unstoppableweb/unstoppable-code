// Revisioned chat-state sync engine (frontend plan, Phase 2).
//
// A pure, Electron-free controller that keeps one read-only client projection
// per project/worktree scope in lockstep with the main-owned canonical chat
// state. The host (chatStore, Portal store, or a test) supplies:
//
//   - a query port (`getState`) returning revisioned snapshots, and
//   - callbacks that install snapshots / apply committed deltas.
//
// The controller owns ONLY ordering state: which scopes are hydrating/live,
// the last applied revision per scope, buffered events, and the
// gap-recovery ("refreshing" / "refresh_error") lifecycle. It never touches
// persistence and never fabricates chat state.
//
// Ordering contract implemented here (see plan "Phase 2: Revisioned
// Hydration"):
//  1. The host registers its `onStateChanged` listener BEFORE calling
//     `hydrate()` and forwards every event to `handleEvent()`.
//  2. Events for a scope whose snapshot query is pending are buffered.
//  3. The returned snapshot becomes the canonical client projection.
//  4. Buffered events apply only when newer than the snapshot revision.
//  5. Duplicate/older revisions are ignored.
//  6. Each applied event's `baseRevision` must equal the last applied
//     revision.
//  7. On a gap: retain the last good projection, enter `refreshing`, and
//     issue exactly one fresh snapshot query.
//  8. Events for an unhydrated scope are ignored; a later query supplies
//     complete state.
//  9. Scope state is fully independent per project/worktree.

import type {
  ChatGetStateRequest,
  ChatStateChangedEvent,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';

export type ChatScopeSyncPhase =
  | 'hydrating'
  | 'live'
  | 'refreshing'
  | 'refresh_error';

export interface ChatScopeSyncStatus {
  phase: ChatScopeSyncPhase;
  /** Last committed revision applied to the client projection, if any. */
  revision: number | null;
  /** Why the scope's first read failed, for the page that has no chats to show. */
  reason?: string;
}

export type ChatScopeHydrateResult = 'installed' | 'already' | 'failed';

export interface RevisionedChatSyncPort {
  getState(request: ChatGetStateRequest): Promise<ChatStateSnapshot>;
}

export interface RevisionedChatSyncHost {
  /**
   * Install a full snapshot as the canonical client projection for its scope.
   * `reason` distinguishes first hydration from gap-recovery refresh so the
   * host can preserve renderer-only presentation state on refresh.
   */
  installSnapshot(
    snapshot: ChatStateSnapshot,
    context: { reason: 'hydrate' | 'refresh' },
  ): void;
  /** Apply one committed, contiguous event to the client projection. */
  applyCommittedEvent(event: ChatStateChangedEvent): void;
  /**
   * Observe scope lifecycle transitions (drives the refresh toast, disabled
   * send/destructive controls, and the inline refresh-error treatment).
   * `null` means the scope was released.
   */
  onStatusChanged?(
    projectId: string,
    worktreeId: string,
    status: ChatScopeSyncStatus | null,
  ): void;
  /**
   * The set of tracked scopes changed: every scope this controller applies
   * events for, in any phase. Called synchronously, before a hydration's
   * snapshot query and after a release, so a host that forwards it to main
   * (`chat.setStateScopes`) is subscribed before the snapshot is read.
   * Events for any other scope are ignored (rule 8), so main may stop
   * sending them.
   */
  onTrackedScopesChanged?(scopes: ChatGetStateRequest[]): void;
}

/** Upper bound on buffered events per scope while a snapshot query runs. */
const MAX_BUFFERED_EVENTS = 1000;
/** Upper bound on transport ids retained solely for duplicate suppression. */
const MAX_SEEN_EVENT_IDS = 1000;

interface ScopeState {
  projectId: string;
  worktreeId: string;
  phase: ChatScopeSyncPhase;
  /** Last applied revision; null until the first snapshot installs. */
  revision: number | null;
  buffered: ChatStateChangedEvent[];
  seenEventIds: Set<string>;
  /**
   * Monotonic hydration epoch. Async completions from a released or
   * re-hydrated scope must never install into the current epoch.
   */
  epoch: number;
  /** True while a snapshot query (hydrate or refresh) is in flight. */
  queryInFlight: boolean;
}

function rememberEventId(scope: ScopeState, eventId: string): void {
  scope.seenEventIds.delete(eventId);
  scope.seenEventIds.add(eventId);
  while (scope.seenEventIds.size > MAX_SEEN_EVENT_IDS) {
    const oldest = scope.seenEventIds.values().next().value;
    if (oldest === undefined) break;
    scope.seenEventIds.delete(oldest);
  }
}

export function chatScopeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

export class RevisionedChatSync {
  private readonly scopes = new Map<string, ScopeState>();
  private epochCounter = 0;

  constructor(
    private readonly port: RevisionedChatSyncPort,
    private readonly host: RevisionedChatSyncHost,
  ) {}

  getStatus(projectId: string, worktreeId: string): ChatScopeSyncStatus | null {
    const scope = this.scopes.get(chatScopeKey(projectId, worktreeId));
    return scope ? { phase: scope.phase, revision: scope.revision } : null;
  }

  /** True when the scope has an installed projection kept live by deltas. */
  isTracking(projectId: string, worktreeId: string): boolean {
    return this.scopes.has(chatScopeKey(projectId, worktreeId));
  }

  /**
   * Route one committed event. The host must call this for every event its
   * `onStateChanged` transport listener delivers, regardless of scope.
   */
  handleEvent(event: ChatStateChangedEvent): void {
    const scope = this.scopes.get(
      chatScopeKey(event.projectId, event.worktreeId),
    );
    if (!scope) {
      // Rule 8: intentionally unhydrated scope. A later hydrate() query
      // returns complete current state, so dropping the event is safe.
      return;
    }
    if (scope.seenEventIds.has(event.eventId)) {
      return; // Duplicate delivery of the same committed event.
    }

    switch (scope.phase) {
      case 'hydrating':
      case 'refreshing':
        this.buffer(scope, event);
        return;
      case 'refresh_error':
        // The pending manual retry issues a fresh snapshot query that
        // supersedes anything received meanwhile.
        return;
      case 'live':
        this.applyLive(scope, event);
        return;
    }
  }

  /**
   * Hydrate one scope. Registers the scope for buffering BEFORE the snapshot
   * query is issued; the caller must already be forwarding transport events
   * into `handleEvent`. Safe to call repeatedly; concurrent/duplicate calls
   * resolve to 'already'.
   */
  async hydrate(
    projectId: string,
    worktreeId: string,
  ): Promise<ChatScopeHydrateResult> {
    const key = chatScopeKey(projectId, worktreeId);
    const existing = this.scopes.get(key);
    if (existing) {
      return 'already';
    }

    const scope: ScopeState = {
      projectId,
      worktreeId,
      phase: 'hydrating',
      revision: null,
      buffered: [],
      seenEventIds: new Set(),
      epoch: ++this.epochCounter,
      queryInFlight: true,
    };
    this.scopes.set(key, scope);
    this.notifyTrackedScopes();
    this.notify(scope);

    const epoch = scope.epoch;
    try {
      const snapshot = await this.port.getState({ projectId, worktreeId });
      const current = this.scopes.get(key);
      if (!current || current.epoch !== epoch) {
        return 'failed'; // Released (or re-hydrated) while the query ran.
      }
      current.queryInFlight = false;
      this.install(current, snapshot, 'hydrate');
      return 'installed';
    } catch (error) {
      const current = this.scopes.get(key);
      if (current && current.epoch === epoch) {
        // Initial hydration failed: leave the decision (legacy fallback vs.
        // load-error treatment) to the host by fully releasing the scope.
        this.scopes.delete(key);
        this.notifyTrackedScopes();
        this.host.onStatusChanged?.(projectId, worktreeId, null);
      }
      throw error;
    }
  }

  /**
   * Adopt an externally fetched snapshot as this scope's projection (used
   * when the host performs the initial `getState` itself as part of a wider
   * hydration flow). Registers the scope as live at the snapshot revision.
   */
  adoptSnapshot(snapshot: ChatStateSnapshot): void {
    const key = chatScopeKey(snapshot.projectId, snapshot.worktreeId);
    const scope: ScopeState = {
      projectId: snapshot.projectId,
      worktreeId: snapshot.worktreeId,
      phase: 'live',
      revision: snapshot.revision,
      buffered: [],
      seenEventIds: new Set(),
      epoch: ++this.epochCounter,
      queryInFlight: false,
    };
    this.scopes.set(key, scope);
    this.notifyTrackedScopes();
    this.notify(scope);
  }

  /**
   * Force a one-shot snapshot refresh of a live scope (used after a stale
   * destructive command conflict: the view refreshes, the command is never
   * auto-retried). No-op unless the scope is live.
   */
  forceRefresh(projectId: string, worktreeId: string): void {
    const scope = this.scopes.get(chatScopeKey(projectId, worktreeId));
    if (!scope || scope.phase !== 'live' || scope.queryInFlight) return;
    scope.phase = 'refreshing';
    this.notify(scope);
    this.refresh(scope);
  }

  /** Manual retry from the inline refresh-error treatment. */
  retry(projectId: string, worktreeId: string): void {
    const scope = this.scopes.get(chatScopeKey(projectId, worktreeId));
    if (!scope || scope.phase !== 'refresh_error' || scope.queryInFlight) {
      return;
    }
    scope.phase = 'refreshing';
    this.notify(scope);
    this.refresh(scope);
  }

  /** Stop tracking a scope (idle unload / worktree removal). */
  release(projectId: string, worktreeId: string): void {
    const key = chatScopeKey(projectId, worktreeId);
    const scope = this.scopes.get(key);
    if (!scope) return;
    this.scopes.delete(key);
    this.notifyTrackedScopes();
    this.host.onStatusChanged?.(projectId, worktreeId, null);
  }

  releaseAll(): void {
    const released = Array.from(this.scopes.values());
    if (released.length === 0) return;
    this.scopes.clear();
    this.notifyTrackedScopes();
    for (const scope of released) {
      this.host.onStatusChanged?.(scope.projectId, scope.worktreeId, null);
    }
  }

  /** Every tracked scope, in the order tracking started. */
  private trackedScopes(): ChatGetStateRequest[] {
    return Array.from(this.scopes.values(), (scope) => ({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    }));
  }

  // -------------------------------------------------------------------------

  private buffer(scope: ScopeState, event: ChatStateChangedEvent): void {
    rememberEventId(scope, event.eventId);
    scope.buffered.push(event);
    if (scope.buffered.length > MAX_BUFFERED_EVENTS) {
      // Pathological backlog: the snapshot that resolves this phase already
      // supersedes older buffered events, and any residual gap re-enters the
      // single-refresh path, so dropping the oldest entry stays convergent.
      scope.buffered.shift();
    }
  }

  private applyLive(scope: ScopeState, event: ChatStateChangedEvent): void {
    const applied = scope.revision ?? -1;
    if (event.revision <= applied) {
      return; // Rule 5: duplicate or older commit.
    }
    if (event.baseRevision === applied) {
      rememberEventId(scope, event.eventId);
      this.host.applyCommittedEvent(event);
      scope.revision = event.revision;
      this.notify(scope);
      return;
    }
    // Rule 7: gap. Keep the last good projection visible, buffer the event
    // (the refreshed snapshot may still precede it), and issue exactly one
    // fresh snapshot query.
    this.buffer(scope, event);
    scope.phase = 'refreshing';
    this.notify(scope);
    this.refresh(scope);
  }

  private refresh(scope: ScopeState): void {
    if (scope.queryInFlight) return;
    scope.queryInFlight = true;
    const epoch = scope.epoch;
    const key = chatScopeKey(scope.projectId, scope.worktreeId);
    void this.port
      .getState({ projectId: scope.projectId, worktreeId: scope.worktreeId })
      .then((snapshot) => {
        const current = this.scopes.get(key);
        if (!current || current.epoch !== epoch) return;
        current.queryInFlight = false;
        this.install(current, snapshot, 'refresh');
      })
      .catch(() => {
        const current = this.scopes.get(key);
        if (!current || current.epoch !== epoch) return;
        current.queryInFlight = false;
        // Keep the last good projection; the user retries explicitly.
        current.phase = 'refresh_error';
        current.buffered = [];
        this.notify(current);
      });
  }

  private install(
    scope: ScopeState,
    snapshot: ChatStateSnapshot,
    reason: 'hydrate' | 'refresh',
  ): void {
    const held = scope.revision ?? -1;
    this.host.installSnapshot(snapshot, { reason });
    scope.revision = snapshot.revision;
    scope.phase = 'live';

    // Rules 4-7 for events buffered while the query ran.
    const buffered = scope.buffered
      .slice()
      .sort((a, b) => a.revision - b.revision);
    scope.buffered = [];
    // The installed snapshot supersedes all prior deliveries. Retain only a
    // bounded set of post-snapshot buffered ids; revisions reject older
    // duplicates even after their ids age out.
    scope.seenEventIds.clear();
    // Except for card states: a snapshot carries no transcript rows, so the
    // card state a covered event carried would never reach a loaded card.
    // Each is complete, so they apply after it, in revision order. A late
    // delivery the held revision already covered is stale and stays dropped.
    const covered = buffered.filter(
      (event) => event.revision > held && event.revision <= snapshot.revision,
    );
    const lastCovered = covered[covered.length - 1];
    const coveredCards = covered.flatMap((event) =>
      event.changes.filter(
        (change) => change.type === 'delegation.card_state_updated',
      ),
    );
    if (lastCovered && coveredCards.length > 0)
      this.host.applyCommittedEvent({ ...lastCovered, changes: coveredCards });
    let gapped = false;
    for (const event of buffered) {
      rememberEventId(scope, event.eventId);
      const applied = scope.revision ?? -1;
      if (event.revision <= applied) continue;
      if (event.baseRevision === applied) {
        this.host.applyCommittedEvent(event);
        scope.revision = event.revision;
        continue;
      }
      gapped = true;
      break;
    }
    if (gapped) {
      scope.phase = 'refreshing';
      this.notify(scope);
      this.refresh(scope);
      return;
    }
    this.notify(scope);
  }

  private notifyTrackedScopes(): void {
    this.host.onTrackedScopesChanged?.(this.trackedScopes());
  }

  private notify(scope: ScopeState): void {
    this.host.onStatusChanged?.(scope.projectId, scope.worktreeId, {
      phase: scope.phase,
      revision: scope.revision,
    });
  }
}
