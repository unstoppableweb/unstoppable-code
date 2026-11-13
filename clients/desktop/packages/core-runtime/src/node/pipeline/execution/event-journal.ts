import {
  WORKER_PIPELINE_NOTIFICATION_BODY_MAX_LENGTH,
  WORKER_PIPELINE_NOTIFICATION_TITLE_MAX_LENGTH,
  WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH,
  type CanopyErrorPayload,
  type CanopyStreamCursor,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionEventsItem,
  type WorkerPipelineExecutionStartParams,
} from '@canopy/protocol/canopy-core';

import {
  createEventJournal,
  type EventJournal,
  type JournalEntry,
} from '../../../kernel/event-journal';
import {
  isTerminalPipelineExecution,
  pipelineSnapshotRequiredError,
  type PipelineExecutionNotification,
  type PipelineExecutionWorker,
} from './worker-pipelines';

/*
 * The event journal a cloud runner keeps for each run (CAN-6161, cloud
 * pipelines CP-03): every execution, output and notification item, numbered
 * per run under the runner incarnation's epoch, so the web core can resume
 * `worker.pipeline.execution.events` after a relay outage. It is bounded and
 * in memory: the web core is the run's only durable writer, and a new
 * incarnation starts a new epoch. Desktop and the daemon keep none.
 */

/** The most items one run's journal keeps; older ones need a snapshot. */
export const PIPELINE_EVENT_JOURNAL_MAX_ENTRIES = 2_048;
/** How long a paused or finished run's journal is kept for a resume. */
export const PIPELINE_EVENT_JOURNAL_RETAIN_MS = 10 * 60_000;
/** The most notifications one run keeps for a stream that has not opened yet (CAN-5868). */
const UNDELIVERED_NOTIFICATIONS_MAX = 32;

/** Arms `expire` to run after `ms` and returns its cancel. */
export type PipelineEventJournalExpiry = (
  expire: () => void,
  ms: number,
) => () => void;

function expireOnTimer(expire: () => void, ms: number): () => void {
  const timer = setTimeout(expire, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export type PipelineEventJournalEntry =
  JournalEntry<WorkerPipelineExecutionEventsItem>;

/** What a stream follows: the entries, then how the run's observation ended. */
export interface PipelineEventJournalListener {
  entry(entry: PipelineEventJournalEntry): void;
  /** The worker stopped following the run: `null` when it finished, or the error it ended with. */
  end(error: CanopyErrorPayload | null): void;
}

export type PipelineEventJournalOpen =
  | {
      readonly kind: 'opened';
      /** How the worker stopped following a run that already finished or was lost; the caller ends the stream after what it sends first. */
      readonly ended: { readonly error: CanopyErrorPayload | null } | null;
      readonly unsubscribe: () => void;
    }
  /** The cursor is another epoch's, ahead of the run, or older than its journal keeps. */
  | { readonly kind: 'snapshot_required' }
  /** The journal keeps nothing for this run. */
  | { readonly kind: 'untracked' };

interface Tracked {
  readonly journal: EventJournal<WorkerPipelineExecutionEventsItem>;
  /** Stops observing the run; null while not observing. */
  stop: (() => void) | null;
  /** The run as the journal last saw it: a stream's snapshot. */
  latest: WorkerPipelineExecution;
  /** Notification entries no stream has sent yet, by cursor key (CAN-5868). */
  readonly undelivered: Map<string, PipelineEventJournalEntry>;
  /** Where each notification carried over from a retired journal is now, by its old cursor key. */
  readonly carried: Map<string, string>;
  /** A notification a stream sent while it was being appended. */
  sentWhileAppending: number | null;
  /** Set once the worker stopped following the run for good. */
  ended: { readonly error: CanopyErrorPayload | null } | null;
  readonly listeners: Set<PipelineEventJournalListener>;
  /** Cancels the armed expiry. */
  expiry?: () => void;
}

export interface PipelineEventJournalOptions {
  /** The runner incarnation; a cursor from another one needs a snapshot. Default a fresh UUID. */
  readonly epoch?: string;
  readonly maxEntries?: number;
  readonly retainMs?: number;
  /** Arms each journal's expiry. Default an unreferenced timer. */
  readonly expireAfter?: PipelineEventJournalExpiry;
}

/** One cursor, as a key: the epoch and the sequence. */
function cursorKey(cursor: CanopyStreamCursor): string {
  return `${cursor.daemonEpoch}:${cursor.sequence}`;
}

/** A notification no stream sent from a retired journal, with the cursors it had. */
interface Orphan {
  readonly notification: PipelineExecutionNotification;
  readonly origins: readonly string[];
}

function itemOf(
  item: WorkerPipelineExecutionEventsItem,
): WorkerPipelineExecutionEventsItem {
  if (item.kind === 'output') {
    const truncated =
      item.truncated ||
      item.text.length > WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH;
    return {
      ...item,
      text: item.text.slice(0, WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH),
      truncated,
    };
  }
  if (item.kind === 'notification')
    return {
      ...item,
      title: item.title.slice(0, WORKER_PIPELINE_NOTIFICATION_TITLE_MAX_LENGTH),
      body: item.body.slice(0, WORKER_PIPELINE_NOTIFICATION_BODY_MAX_LENGTH),
    };
  return item;
}

/**
 * One journal per run the worker started, kept while it runs and for a
 * while after. Each journal numbers its run's items under its own epoch,
 * minted from the runner incarnation's, so a run journaled again after its
 * journal expired never reuses an earlier cursor.
 */
export class PipelineEventJournal {
  /** The runner incarnation; every journal's epoch starts with it. */
  public readonly epoch: string;

  private generation = 0;

  /** The most items one run's journal keeps; a replay is at most this long. */
  public readonly maxEntries: number;

  private readonly retainMs: number;

  private readonly expireAfter: PipelineEventJournalExpiry;

  private readonly runs = new Map<string, Tracked>();

  /** Notifications no stream sent from journals that were retired, for the unjournaled stream. */
  private readonly orphaned = new Map<string, Orphan[]>();

  public constructor(options: PipelineEventJournalOptions = {}) {
    this.epoch = options.epoch ?? crypto.randomUUID();
    this.maxEntries = options.maxEntries ?? PIPELINE_EVENT_JOURNAL_MAX_ENTRIES;
    this.retainMs = options.retainMs ?? PIPELINE_EVENT_JOURNAL_RETAIN_MS;
    this.expireAfter = options.expireAfter ?? expireOnTimer;
  }

  /**
   * Starts journaling a run the worker started or resumed, as `execution`
   * reports it. A run still observed keeps its journal, and what the
   * observer saw stands over `execution`. A run no longer observed (it
   * finished, or paused where it could not be followed) gets a new journal
   * and epoch, so no earlier attempt's items reach the new one's streams.
   */
  public track(
    worker: PipelineExecutionWorker,
    executionId: string,
    execution: WorkerPipelineExecution,
  ): void {
    const known = this.runs.get(executionId);
    if (known?.stop) return;
    if (known) this.retire(executionId, known);
    const tracked: Tracked = {
      journal: createEventJournal<WorkerPipelineExecutionEventsItem>({
        epoch: `${this.epoch}.${(this.generation += 1)}`,
        maxEntries: this.maxEntries,
      }),
      stop: null,
      latest: execution,
      undelivered: new Map(),
      carried: new Map(),
      sentWhileAppending: null,
      ended: null,
      listeners: new Set(),
    };
    this.runs.set(executionId, tracked);
    const append = (
      item: WorkerPipelineExecutionEventsItem,
    ): PipelineEventJournalEntry => {
      const entry = tracked.journal.append(itemOf(item));
      if (item.kind !== 'notification') return entry;
      // A stream may have sent it already, as it was appended.
      const sent = tracked.sentWhileAppending === entry.cursor.sequence;
      tracked.sentWhileAppending = null;
      if (sent) return entry;
      tracked.undelivered.set(cursorKey(entry.cursor), entry);
      const oldest = tracked.undelivered.keys().next();
      if (
        tracked.undelivered.size > UNDELIVERED_NOTIFICATIONS_MAX &&
        !oldest.done
      )
        tracked.undelivered.delete(oldest.value);
      return entry;
    };
    let observed = false;
    tracked.stop = worker.observe(executionId, {
      onExecution: (event, next) => {
        observed = true;
        tracked.latest = next;
        append({ kind: 'execution', event, execution: next });
        // A paused run stays observed, so a cancel or resume still reaches it.
        if (next.status === 'paused') this.expireLater(executionId, tracked);
        else if (isTerminalPipelineExecution(next))
          this.end(executionId, tracked, null);
        else this.keep(tracked);
      },
      onOutput: (output) =>
        append({ kind: 'output', ...output, truncated: false }),
      // The journal keeps it for every stream, so the worker never holds it too.
      onNotification: (notification) => {
        append({ kind: 'notification', ...notification });
        return true;
      },
      onEnd: (error) => this.end(executionId, tracked, error),
    });
    // What an earlier attempt sent that no stream did carries over; a late
    // acknowledgement under its old cursor still finds it.
    for (const { notification, origins } of this.orphaned.get(executionId) ??
      []) {
      const key = cursorKey(
        append({ kind: 'notification', ...notification }).cursor,
      );
      for (const origin of origins) tracked.carried.set(origin, key);
    }
    this.orphaned.delete(executionId);
    // What the run sent before the journal followed it (CAN-5868).
    for (const notification of worker.takeNotifications?.(executionId) ?? [])
      append({ kind: 'notification', ...notification });
    // What the start or resume reported may already be stale: the run may
    // have changed, or settled, before the journal followed it.
    void this.reconcile(worker, executionId, tracked, () => observed);
  }

  /**
   * Journals the run as the worker reads it now, unless the journal saw a
   * newer event meanwhile, and ends its streams when an unobservable run
   * finished.
   */
  private async reconcile(
    worker: PipelineExecutionWorker,
    executionId: string,
    tracked: Tracked,
    sawEvent: () => boolean,
  ): Promise<void> {
    let current: WorkerPipelineExecution | null = null;
    try {
      current = await worker.get(executionId);
    } catch {
      current = null;
    }
    if (this.runs.get(executionId) !== tracked || sawEvent()) return;
    const observing = tracked.stop !== null;
    if (current && JSON.stringify(current) !== JSON.stringify(tracked.latest)) {
      tracked.latest = current;
      tracked.journal.append({
        kind: 'execution',
        event: 'snapshot',
        execution: current,
      });
    }
    if (isTerminalPipelineExecution(tracked.latest)) {
      this.end(executionId, tracked, null);
      return;
    }
    // Unfinished, but nothing will tell the journal how it goes on: its
    // streams need a snapshot, and new ones read the worker directly.
    if (!observing) {
      this.retire(executionId, tracked);
      return;
    }
    if (tracked.latest.status === 'paused')
      this.expireLater(executionId, tracked);
  }

  /**
   * Follows a run from just after `cursor`. Without one, the stream starts
   * with a snapshot of the run as the journal last saw it, journaled with a
   * cursor of its own in the same turn, so nothing the run journals later
   * can precede or contradict it. Replayed entries reach `listener` before
   * this returns.
   */
  public open(
    executionId: string,
    cursor: CanopyStreamCursor | null,
    listener: PipelineEventJournalListener,
  ): PipelineEventJournalOpen {
    const tracked = this.runs.get(executionId);
    if (!tracked)
      return cursor === null
        ? { kind: 'untracked' }
        : { kind: 'snapshot_required' };
    let from = cursor;
    if (from === null) {
      const snapshot = tracked.journal.append({
        kind: 'execution',
        event: 'snapshot',
        execution: tracked.latest,
      });
      from = { ...snapshot.cursor, sequence: snapshot.cursor.sequence - 1 };
    }
    const subscribed = tracked.journal.subscribe(from, (entry) =>
      listener.entry(entry),
    );
    if (subscribed.kind === 'snapshot_required')
      return { kind: 'snapshot_required' };
    tracked.listeners.add(listener);
    return {
      kind: 'opened',
      ended: tracked.ended,
      unsubscribe: () => {
        tracked.listeners.delete(listener);
        subscribed.unsubscribe();
      },
    };
  }

  /**
   * Notifications the run sent that no stream has sent on yet, oldest
   * first, each at its own cursor (CAN-5868). They stay pending until a
   * stream reports one sent, so a stream that closes first loses none.
   */
  public undelivered(executionId: string): PipelineEventJournalEntry[] {
    const tracked = this.runs.get(executionId);
    if (!tracked) return [];
    return [...tracked.undelivered.values()].sort(
      (a, b) => a.cursor.sequence - b.cursor.sequence,
    );
  }

  /**
   * A stream sent the notification at `cursor` to its consumer. A stream
   * still sending from a retired journal acknowledges under that journal's
   * cursor, which reaches the notification wherever it was carried.
   */
  public delivered(executionId: string, cursor: CanopyStreamCursor): void {
    const key = cursorKey(cursor);
    const orphans = this.orphaned.get(executionId);
    if (orphans) {
      const remaining = orphans.filter(({ origins }) => !origins.includes(key));
      if (remaining.length > 0) this.orphaned.set(executionId, remaining);
      else this.orphaned.delete(executionId);
    }
    const tracked = this.runs.get(executionId);
    if (!tracked) return;
    if (tracked.undelivered.delete(tracked.carried.get(key) ?? key)) return;
    // Sent as it was being appended: the append must not keep it pending.
    const head = tracked.journal.head();
    if (
      head?.daemonEpoch === cursor.daemonEpoch &&
      head.sequence === cursor.sequence
    )
      tracked.sentWhileAppending = cursor.sequence;
  }

  /**
   * Notifications no stream sent from the run's retired journals (CAN-5868),
   * for a stream that reads the worker directly; taking them clears them.
   */
  public takeOrphaned(executionId: string): PipelineExecutionNotification[] {
    const kept = this.orphaned.get(executionId) ?? [];
    this.orphaned.delete(executionId);
    return kept.map(({ notification }) => notification);
  }

  /** Stops observing every run and drops every journal. */
  public close(): void {
    for (const tracked of this.runs.values()) {
      tracked.stop?.();
      tracked.expiry?.();
    }
    this.runs.clear();
    this.orphaned.clear();
  }

  /** The run runs again: its journal no longer expires. */
  private keep(tracked: Tracked): void {
    tracked.expiry?.();
    tracked.expiry = undefined;
  }

  /**
   * The run finished (`error` null) or the worker can no longer follow it:
   * streams end after what they have, and the journal is kept for a while.
   */
  private end(
    executionId: string,
    tracked: Tracked,
    error: CanopyErrorPayload | null,
  ): void {
    const stop = tracked.stop;
    tracked.stop = null;
    stop?.();
    if (!tracked.ended) {
      tracked.ended = { error };
      for (const listener of [...tracked.listeners]) listener.end(error);
    }
    this.expireLater(executionId, tracked);
  }

  /**
   * Drops the run's journal after the retention window, unless it runs
   * again first. A stream still open on it, on a paused run, then needs a
   * snapshot.
   */
  private expireLater(executionId: string, tracked: Tracked): void {
    this.keep(tracked);
    tracked.expiry = this.expireAfter(
      () => this.retire(executionId, tracked),
      this.retainMs,
    );
  }

  /** Drops the run's journal; a stream still open on it needs a snapshot. */
  private retire(executionId: string, tracked: Tracked): void {
    this.keep(tracked);
    if (this.runs.get(executionId) === tracked) this.runs.delete(executionId);
    // What no stream sent stays for the next stream, journaled or not.
    // Its own cursor, and any it had in journals it was carried from.
    const originsOf = new Map<string, string[]>();
    for (const [origin, key] of tracked.carried)
      originsOf.set(key, [...(originsOf.get(key) ?? []), origin]);
    const unsent: Orphan[] = [];
    for (const [key, { event }] of tracked.undelivered)
      if (event.kind === 'notification')
        unsent.push({
          notification: {
            stepId: event.stepId,
            title: event.title,
            body: event.body,
          },
          origins: [key, ...(originsOf.get(key) ?? [])],
        });
    tracked.undelivered.clear();
    if (unsent.length > 0)
      this.orphaned.set(
        executionId,
        [...(this.orphaned.get(executionId) ?? []), ...unsent].slice(
          -UNDELIVERED_NOTIFICATIONS_MAX,
        ),
      );
    const stop = tracked.stop;
    tracked.stop = null;
    stop?.();
    const required = pipelineSnapshotRequiredError().payload;
    for (const listener of [...tracked.listeners]) listener.end(required);
    tracked.listeners.clear();
  }
}

/**
 * The worker with a journal (CAN-6161): every run it starts or resumes is
 * journaled from its start, so a stream can resume after a relay outage.
 */
export function withPipelineEventJournal(
  worker: PipelineExecutionWorker,
  journal: PipelineEventJournal,
): PipelineExecutionWorker {
  return {
    get portableLaunches(): boolean | undefined {
      return worker.portableLaunches;
    },
    // What a run the journal does not follow kept (CAN-5868).
    takeNotifications: (executionId) => [
      ...journal.takeOrphaned(executionId),
      ...(worker.takeNotifications?.(executionId) ?? []),
    ],
    // A start it joins is already journaled.
    admitStart: (params, execution) =>
      worker.admitStart?.(params, execution) ?? Promise.resolve(null),
    // An adopted run starts nothing; the resume that continues it is journaled.
    ...(worker.adoptStart && {
      adoptStart: async (
        params: WorkerPipelineExecutionStartParams,
        stored: WorkerPipelineExecution,
      ): Promise<WorkerPipelineExecution> =>
        (await worker.adoptStart?.(params, stored)) ?? stored,
    }),
    async start(params, signal, secrets, execution) {
      const started = await worker.start(params, signal, secrets, execution);
      if (!isTerminalPipelineExecution(started))
        journal.track(worker, started.executionId, started);
      return started;
    },
    async control(request, signal, secrets) {
      const result = await worker.control(request, signal, secrets);
      if (
        result.outcome === 'started' &&
        !isTerminalPipelineExecution(result.execution)
      )
        journal.track(worker, result.execution.executionId, result.execution);
      return result;
    },
    sweep: (params) => worker.sweep(params),
    checkpoint: (params) => worker.checkpoint(params),
    get: (executionId) => worker.get(executionId),
    inspect: (executionId) => worker.inspect(executionId),
    list: (query) => worker.list(query),
    cancel: (executionId, mode) => worker.cancel(executionId, mode),
    observe: (executionId, observer) => worker.observe(executionId, observer),
  };
}
