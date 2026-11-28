import type {
  ChatCommandRequest,
  ChatCommandResult,
  ChatStateChangedEvent,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import type {
  ChatTurnStateCommit,
  ChatTurnStateScope,
} from './chat-turn-state-handoff';

/** Archive attempts for one completed turn before the archiver gives up. */
export const AUTO_ARCHIVE_MAX_ATTEMPTS = 3;

/**
 * Immediate re-reads after revision conflicts in one evaluation. Any commit in
 * the scope can cause one, so they don't spend the attempt budget.
 */
export const AUTO_ARCHIVE_MAX_CONFLICTS = 8;

/** What the archiver reads and dispatches; Electron main's by default, tests inject one. */
export interface ChatAutoArchiveHost {
  onTurnStateCommitted(
    listener: (commit: ChatTurnStateCommit) => void,
  ): () => void;
  /** A committed change that can let a completed turn archive. */
  onUnblocked(listener: (target: ChatTurnStateScope) => void): () => void;
  /** Committed state without host recovery: tabs, runtimes and queues. */
  readSnapshot(scope: {
    projectId: string;
    worktreeId: string;
  }): Promise<ChatStateSnapshot>;
  /** Live delegates or provider background work keep a chat open. */
  closeBlocked(target: ChatTurnStateScope): boolean;
  /** A Split PR holds the chat's worktree. */
  locked(target: ChatTurnStateScope): boolean;
  /** A send to the chat is still being dispatched. */
  dispatchInFlight(target: ChatTurnStateScope): boolean;
  /**
   * An active watcher notifies this chat. Archiving it would drop that
   * notification, which needs the chat open.
   */
  awaitsWatcher(target: ChatTurnStateScope): Promise<boolean>;
  /** Sends a chat command through `core.chat.archive`. */
  dispatch(request: ChatCommandRequest): Promise<ChatCommandResult>;
  warn(message: string, details: Record<string, unknown>): void;
}

interface Attempts {
  turnId: string;
  count: number;
}

function keyOf(target: ChatTurnStateScope): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

/**
 * Calls `listener` for each committed change that can let a chat's completed
 * turn archive: a dismissed async question, a reduced root terminal, or a
 * marker given its owning turn.
 */
export function onCommittedArchiveUnblocks(
  subscribe: (listener: (event: ChatStateChangedEvent) => void) => () => void,
  listener: (target: ChatTurnStateScope) => void,
): () => void {
  return subscribe((event) => {
    const scope = { projectId: event.projectId, worktreeId: event.worktreeId };
    for (const change of event.changes)
      if (
        change.type === 'pending_question.upserted' &&
        change.question.dismissedAt !== undefined
      )
        listener({ ...scope, chatId: change.question.chatId });
      else if (
        change.type === 'tab.metadata_patched' &&
        (change.patch.reducedRootTerminalTurnIds !== undefined ||
          typeof change.patch.autoArchiveTurnId === 'string')
      )
        listener({ ...scope, chatId: change.tabId });
  });
}

function applied(result: ChatCommandResult): boolean {
  return result.outcome === 'applied' || result.outcome === 'already_applied';
}

/**
 * Archives a chat marked `autoArchive` once the marker's own turn completes
 * (CAN-6014). Main is the only archiver: it acts on committed state, so it
 * needs no window. The chat service gives the marker one owning turn and
 * clears it when that turn ends without completing or a newer turn starts.
 * The owner's completion archives through `core.chat.archive`, unread with
 * the session kept, once its root terminal is reduced (so an empty completion
 * is classified first), the chat is idle with a completed runtime, and
 * nothing holds it: queued input, a pending question or plan exit, a send in
 * flight, a Split PR lock, close-blocking work or an active watcher that
 * notifies the chat. Otherwise the next committed idle, a dismissed question
 * or the terminal's reduction re-evaluates it. A watcher's notification
 * starts a newer turn, which drops the marker, so a held chat stays open. A
 * refused archive keeps the marker and retries at the next committed idle, up
 * to {@link AUTO_ARCHIVE_MAX_ATTEMPTS} times for that turn.
 */
export class ChatAutoArchiver {
  private readonly attempts = new Map<string, Attempts>();
  private readonly chains = new Map<string, Promise<void>>();
  private unsubscribe: Array<() => void> | null = null;

  public constructor(private readonly host: ChatAutoArchiveHost) {}

  public start(): void {
    this.unsubscribe ??= [
      this.host.onTurnStateCommitted((commit) => {
        this.observe(commit);
      }),
      this.host.onUnblocked((target) => {
        const scope = { ...target };
        this.enqueue(scope, () => this.recheck(scope));
      }),
    ];
  }

  public stop(): void {
    for (const unsubscribe of this.unsubscribe ?? []) unsubscribe();
    this.unsubscribe = null;
  }

  /** Resolves once every queued evaluation has settled; for tests. */
  public async settled(): Promise<void> {
    while (this.chains.size > 0)
      await Promise.all(Array.from(this.chains.values()));
  }

  private observe(commit: ChatTurnStateCommit): void {
    const target = { ...commit.scope };
    const lastEnded = commit.state.lastEnded;
    if (
      commit.state.phase === 'idle' &&
      (commit.effects ?? []).some((effect) => effect.type === 'chat.idle') &&
      lastEnded?.outcome === 'completed'
    )
      this.enqueue(target, () => this.archiveIfEligible(target, lastEnded.id));
  }

  /** Something that held the marker's turn may have cleared. */
  private async recheck(target: ChatTurnStateScope): Promise<void> {
    const owner = (await this.markedTab(target))?.tab.autoArchiveTurnId;
    if (owner !== undefined) await this.archiveIfEligible(target, owner);
  }

  private enqueue(target: ChatTurnStateScope, run: () => Promise<void>): void {
    const key = keyOf(target);
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(run)
      .catch((error: unknown) => {
        this.host.warn('Auto-archive could not evaluate a chat', {
          ...target,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  private async markedTab(target: ChatTurnStateScope): Promise<
    | {
        snapshot: ChatStateSnapshot;
        tab: ChatStateSnapshot['tabsFile']['tabs'][number];
      }
    | undefined
  > {
    const snapshot = await this.host.readSnapshot(target);
    const tab = snapshot.tabsFile.tabs.find(
      (candidate) => candidate.id === target.chatId,
    );
    if (!tab || tab.kind === 'file' || tab.autoArchive !== true)
      return undefined;
    return { snapshot, tab };
  }

  private blocked(
    target: ChatTurnStateScope,
    snapshot: ChatStateSnapshot,
    tab: ChatStateSnapshot['tabsFile']['tabs'][number],
  ): boolean {
    const runtime = snapshot.runtimeByChatId[target.chatId];
    const queue = snapshot.queue.find(
      (entry) => entry.chatId === target.chatId,
    );
    return (
      (runtime?.queuedMessageIds?.length ?? 0) > 0 ||
      (queue?.queue.length ?? 0) > 0 ||
      (snapshot.tabsFile.pendingQuestions ?? []).some(
        (question) =>
          question.chatId === target.chatId &&
          question.answeredAt === undefined &&
          question.dismissedAt === undefined,
      ) ||
      Boolean(tab.pendingPlanExit) ||
      this.host.locked(target) ||
      this.host.dispatchInFlight(target) ||
      this.host.closeBlocked(target)
    );
  }

  private async archiveIfEligible(
    target: ChatTurnStateScope,
    turnId: string,
  ): Promise<void> {
    const key = keyOf(target);
    const previous = this.attempts.get(key);
    const attempts =
      previous?.turnId === turnId ? previous : { turnId, count: 0 };
    if (attempts.count >= AUTO_ARCHIVE_MAX_ATTEMPTS) return;
    let result: ChatCommandResult | undefined;
    let failure: string | undefined;
    for (let conflicts = 0; ; conflicts += 1) {
      const marked = await this.markedTab(target);
      if (!marked || this.blocked(target, marked.snapshot, marked.tab)) return;
      // Only the marker's own turn archives it, and only while it is the
      // chat's last turn. An empty completion ends `completed` but fails the
      // chat's runtime once its root terminal is reduced, so that reduction
      // must be committed and the runtime agree.
      const runtime = marked.snapshot.runtimeByChatId[target.chatId];
      if (
        marked.tab.autoArchiveTurnId !== turnId ||
        runtime?.turn?.lastEnded?.id !== turnId ||
        marked.tab.reducedRootTerminalTurnIds?.includes(turnId) !== true ||
        runtime?.status !== 'completed' ||
        runtime.turn?.phase !== 'idle' ||
        runtime.turn.current !== undefined
      )
        return;
      // Read last: it lists watchers, so only a chat that would archive pays.
      if (await this.host.awaitsWatcher(target)) return;
      result = undefined;
      failure = undefined;
      try {
        result = await this.host.dispatch({
          schemaVersion: 1,
          commandId: `auto-archive:${target.chatId}:${turnId}:${String(attempts.count + 1)}.${String(conflicts)}`,
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          expectedRevision: marked.snapshot.revision,
          command: {
            type: 'chat.archive_tab',
            tabId: target.chatId,
            unread: true,
            keepSession: true,
          },
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (result && applied(result)) {
        this.attempts.delete(key);
        return;
      }
      // Another commit in the scope landed after the read: check again now,
      // since a completed chat has no later idle to retry on.
      if (
        result?.outcome !== 'conflict' ||
        conflicts + 1 >= AUTO_ARCHIVE_MAX_CONFLICTS
      )
        break;
    }
    const conflicted = result?.outcome === 'conflict';
    if (!conflicted) {
      attempts.count += 1;
      this.attempts.set(key, attempts);
    }
    const exhausted = attempts.count >= AUTO_ARCHIVE_MAX_ATTEMPTS;
    this.host.warn(
      exhausted
        ? 'Auto-archive gave up on a chat; its marker stays set'
        : conflicted
          ? 'Auto-archive kept losing to concurrent commits; it retries at the chat’s next idle'
          : 'Auto-archive failed; it retries at the chat’s next idle',
      {
        ...target,
        turnId,
        attempt: attempts.count,
        ...(result ? { outcome: result.outcome } : {}),
        ...(result?.reason ? { reason: result.reason } : {}),
        ...(failure ? { error: failure } : {}),
      },
    );
  }
}

let installed: ChatAutoArchiver | null = null;

/** Starts main's auto-archiver over the given host; replaces an earlier one. */
export function installChatAutoArchiver(
  host: ChatAutoArchiveHost,
): ChatAutoArchiver {
  installed?.stop();
  installed = new ChatAutoArchiver(host);
  installed.start();
  return installed;
}
