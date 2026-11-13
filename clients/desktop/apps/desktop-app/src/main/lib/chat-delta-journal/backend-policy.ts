/**
 * Write-path policy the chat state backend applies to a delta-journal
 * scope: the journal forms of a transaction's transcript writes, the size
 * estimate that sends a large transaction down the version 2 path, and the
 * bounded retry of a failed promotion. Pure; the backend owns every effect.
 */
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { MAX_RECORD_PAYLOAD_BYTES } from './format';
import { upsertActiveMessages } from './transcript-overlay';
import type { ChatTranscriptWrite } from '../chat-storage-transactions';
import type { DeltaJournalWrite } from './writer';

/**
 * What the backend's write preparation knows about each write beyond its
 * version 2 shape, so the delta journal can record only what changed.
 */
export interface JournalWriteForms {
  /** Rewrites of existing history, as patches against the committed rows. */
  patches: Map<
    string,
    {
      patches: PersistedChatMessage[];
      removedMessageIds: string[];
      tail: PersistedChatMessage[];
      activeTailCount: number;
    }
  >;
  /** Active writes: the previous active rows, the new rows, the changed ids. */
  active: Map<string, ActiveWriteForm>;
}

export interface ActiveWriteForm {
  previous: readonly PersistedChatMessage[];
  next: PersistedChatMessage[];
  changed: Set<string>;
}

/**
 * Journal records above this estimate take the version 2 path instead (the
 * scope is demoted first and promoted again at its next idle point), well
 * inside the journal's per-record limit.
 */
export const LARGE_JOURNAL_RECORD_BYTES = Math.floor(
  MAX_RECORD_PAYLOAD_BYTES * 0.75,
);

/** Framing of one write in a record: its chat id, kind and field names. */
const WRITE_OVERHEAD_BYTES = 256;
/**
 * The record's fixed fields: frame header, digests, revisions, mutation ids.
 * The index delta and any unusually large field are covered by the quarter
 * of the frame limit {@link LARGE_JOURNAL_RECORD_BYTES} leaves free; a fixed
 * overhead larger than a small record would send every commit down the
 * version 2 path under a small test threshold.
 */
const RECORD_OVERHEAD_BYTES = 1024;

/** The upserts that turn `previous` into `next`, when an upsert can. */
export function activeUpserts(
  form: ActiveWriteForm,
): PersistedChatMessage[] | undefined {
  const upserts = form.next.filter((message) => form.changed.has(message.id));
  const merged = upsertActiveMessages(form.previous, upserts);
  if (
    merged.length !== form.next.length ||
    merged.some((message, index) => message.id !== form.next[index].id)
  )
    return undefined;
  return upserts;
}

/**
 * The delta-journal form of a transaction's writes: active writes that only
 * add or change rows become upserts carrying those rows, and rewrites of
 * existing history become patches. The record then holds what changed.
 */
export function journalWritesFor(
  writes: readonly ChatTranscriptWrite[],
  forms: JournalWriteForms,
): DeltaJournalWrite[] {
  return writes.map((write): DeltaJournalWrite => {
    const patch = forms.patches.get(write.chatId);
    if (patch) return { chatId: write.chatId, kind: 'patch', ...patch };
    const active = forms.active.get(write.chatId);
    if (write.kind === 'active' && active) {
      const upserts = activeUpserts(active);
      if (upserts)
        return {
          chatId: write.chatId,
          kind: 'active-upsert',
          messages: upserts,
        };
    }
    return write;
  });
}

/**
 * The UTF-8 size of the record these writes would make, as the frame limit
 * counts it: every row's serialized bytes plus framing. Counting UTF-16 code
 * units under-reports multibyte text by up to a factor of three.
 */
export function estimateJournalBytes(
  writes: readonly DeltaJournalWrite[],
): number {
  let bytes = RECORD_OVERHEAD_BYTES;
  for (const write of writes) {
    bytes += WRITE_OVERHEAD_BYTES;
    const rows =
      write.kind === 'patch'
        ? [...write.patches, ...write.tail]
        : Array.isArray(write.messages)
          ? write.messages
          : [];
    for (const row of rows)
      bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
  }
  return bytes;
}

export interface PromotionRetryOptions {
  /** Delay before the first retry; doubles per failure. Default 30 s. */
  delayMs?: number;
  /** Retries after the first failure. Default 5. */
  limit?: number;
}

const MAX_PROMOTION_RETRY_DELAY_MS = 30 * 60 * 1000;

/**
 * A failed promotion leaves the selected format authoritative. It is tried again at a
 * later idle point, only after scope activity (a commit) since the last
 * failure, once an exponential backoff has passed, and at most `limit`
 * times, so a persistent failure such as a full disk never loops.
 */
export class PromotionRetry {
  private failures = 0;
  private notBefore = 0;
  private active = false;

  public constructor(private readonly options: PromotionRetryOptions = {}) {}

  public failed(now: number = Date.now()): void {
    this.failures += 1;
    this.active = false;
    const delay = (this.options.delayMs ?? 30_000) * 2 ** (this.failures - 1);
    this.notBefore = now + Math.min(delay, MAX_PROMOTION_RETRY_DELAY_MS);
  }

  /** Promoted, or no longer wanted: forget earlier failures. */
  public reset(): void {
    this.failures = 0;
    this.active = false;
  }

  /** A commit after the last failure. */
  public activity(): void {
    if (this.failures > 0) this.active = true;
  }

  /** First attempt, or an activity-gated retry whose backoff has elapsed. */
  public canAttempt(now: number = Date.now()): boolean {
    return this.failures === 0 || this.due(now);
  }

  /** Failed attempts since the last success or reset. */
  public failureCount(): number {
    return this.failures;
  }

  /** Every retry is spent; only a reset (or a new process) tries again. */
  public exhausted(): boolean {
    return this.failures > (this.options.limit ?? 5);
  }

  public due(now: number = Date.now()): boolean {
    return (
      this.failures > 0 &&
      this.active &&
      this.failures <= (this.options.limit ?? 5) &&
      now >= this.notBefore
    );
  }
}
