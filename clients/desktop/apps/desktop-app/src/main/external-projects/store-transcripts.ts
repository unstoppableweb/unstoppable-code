import { MAX_IMPORT_TRANSCRIPT_BYTES } from './chat-projection';
import {
  isOpenCodeSessionDetails,
  type OpenCodeMessageRow,
  type OpenCodeSessionDetails,
} from './opencode-store';
import type { StoreReadRequest } from './store-read-contract';
import type { StoreReadRunner } from './store-read-runner';
import {
  isT3ThreadDetails,
  type T3ThreadDetails,
  type T3ThreadTranscript,
} from './t3code-store';
import type { DiscoveredSession } from './types';

/**
 * Reads T3 Code thread text and OpenCode session messages for the chats one
 * import run admitted, across every budget round of the run. Every read
 * copies the whole database, so the first request for a database in a round
 * reads every admitted session planned to project from it that no earlier
 * request asked for, and later requests in the round are answered from that
 * read: each round costs at most one copy per database. A T3 thread planned
 * to import through its Codex or Claude record is not in that read unless its
 * native record already failed and {@link demote} named it before the store
 * was read; one that fails later is fetched in a read of its own. A run whose
 * chats all import natively never copies the T3 store at all. Nothing the run
 * did not admit is ever requested.
 *
 * A thread or session the store no longer holds, or one with no row of a
 * type the projection renders, reads as an empty transcript, so the import
 * reports it as having nothing to import instead of as a read failure.
 */
export class StoreTranscripts {
  private readonly admitted: DiscoveredSession[];
  /** Backed T3 threads whose native record failed, by T3 thread id. */
  private readonly demoted = new Set<string>();
  /** This round's reads, by database. Earlier rounds' rows are released. */
  private readonly t3Reads = new Map<
    string,
    Array<StoreRead<T3ThreadDetails>>
  >();
  private readonly openCodeReads = new Map<
    string,
    Array<StoreRead<OpenCodeSessionDetails>>
  >();
  /** Every id any round asked a database for, so no id is read twice. */
  private readonly requested = new Map<string, Set<string>>();

  constructor(
    private readonly runner: StoreReadRunner,
    admitted: readonly DiscoveredSession[],
  ) {
    this.admitted = [...admitted];
  }

  /**
   * Starts a budget round that admits `sessions`. The rows earlier rounds
   * read are released, since their chats are settled, and the next request
   * to each database reads only this round's planned ids.
   */
  admit(sessions: readonly DiscoveredSession[]): void {
    this.admitted.push(...sessions);
    this.t3Reads.clear();
    this.openCodeReads.clear();
  }

  /**
   * Adds backed T3 threads whose native record failed to the T3 text read,
   * so the threads one round demotes share one copy of the store. Takes
   * effect for the next read of the store.
   */
  demote(sessions: readonly DiscoveredSession[]): void {
    for (const session of sessions) {
      if (session.kind === 't3-thread')
        this.demoted.add(session.storeId ?? session.id);
    }
  }

  /** T3's text copy of a thread; throws when the store cannot be read. */
  async t3Thread(session: DiscoveredSession): Promise<T3ThreadTranscript> {
    const dbPath = session.sourcePath;
    const threadId = session.storeId ?? session.id;
    const planned = this.admitted
      .filter(
        (entry) =>
          entry.kind === 't3-thread' &&
          entry.sourcePath === dbPath &&
          (!entry.backing || this.demoted.has(entry.storeId ?? entry.id)),
      )
      .map((entry) => entry.storeId ?? entry.id);
    const details = await this.read(
      this.t3Reads,
      `t3\0${dbPath}`,
      threadId,
      planned,
      (threadIds) => ({ store: 't3code', dbPath, mode: 'threads', threadIds }),
      isT3ThreadDetails,
      'T3 Code',
    );
    return details[threadId] ?? { messages: [], items: [], attachments: [] };
  }

  /** An OpenCode session's messages; throws when the store cannot be read. */
  async openCodeSession(
    dbPath: string,
    sessionId: string,
  ): Promise<OpenCodeMessageRow[]> {
    const planned: string[] = [];
    for (const entry of this.admitted) {
      if (entry.kind === 'opencode-session' && entry.sourcePath === dbPath)
        planned.push(entry.storeId ?? entry.id);
      // A T3 thread run on OpenCode reads its native session from here too,
      // unless that session is over the per-chat cap: the thread then imports
      // its T3 text and the session is never read.
      if (
        entry.backing?.kind === 'opencode-session' &&
        entry.backing.sourcePath === dbPath &&
        entry.backing.sizeBytes <= MAX_IMPORT_TRANSCRIPT_BYTES
      )
        planned.push(entry.backing.id);
    }
    const details = await this.read(
      this.openCodeReads,
      `opencode\0${dbPath}`,
      sessionId,
      planned,
      (sessionIds) => ({
        store: 'opencode',
        dbPath,
        mode: 'sessions',
        sessionIds,
      }),
      isOpenCodeSessionDetails,
      'OpenCode',
    );
    return details[sessionId] ?? [];
  }

  /**
   * The read that answers `id`: one of this round's reads of the database
   * when it asked for `id`, else a new read of every planned id no read has
   * asked for yet when `id` is one of them, else a read of `id` alone.
   */
  private read<T>(
    cache: Map<string, Array<StoreRead<T>>>,
    key: string,
    id: string,
    planned: readonly string[],
    request: (ids: string[]) => StoreReadRequest,
    guard: (value: unknown) => value is T,
    label: string,
  ): Promise<T> {
    const reads = cache.get(key) ?? [];
    const answered = reads.find((entry) => entry.ids.has(id));
    if (answered) return answered.data;
    const requested = this.requested.get(key) ?? new Set<string>();
    const unread = Array.from(
      new Set(planned.filter((entry) => !requested.has(entry))),
    );
    const ids = unread.includes(id) ? unread : [id];
    for (const entry of ids) requested.add(entry);
    this.requested.set(key, requested);
    const data = this.runner.read(request(ids)).then((response) => {
      if (!response.ok) throw new Error(response.message);
      if (!guard(response.data)) {
        throw new Error(
          `The ${label} store returned data in an unexpected shape`,
        );
      }
      return response.data;
    });
    reads.push({ ids: new Set(ids), data });
    cache.set(key, reads);
    return data;
  }
}

interface StoreRead<T> {
  /** The ids the read asked for; an id absent from `data` has no rows. */
  ids: ReadonlySet<string>;
  data: Promise<T>;
}
