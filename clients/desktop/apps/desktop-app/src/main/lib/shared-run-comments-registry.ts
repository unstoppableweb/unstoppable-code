// ---------------------------------------------------------------------------
// Main-owned registry of shared runs whose comments are polled (CAN-397).
//
// Two jobs:
//   1. Bound the poller. Instead of walking every workspace's chat file on each
//      tick (those files carry whole transcripts), the poller iterates only the
//      sessions registered here at share time, using the `externalId` persisted
//      alongside each entry. Liveness is confirmed by the fetch itself: a
//      404/410 means the grant is gone and the entry is dropped.
//   2. Persist the last-seen `commentRevision` per run, so an unread badge
//      survives a restart. Comment bodies are NEVER stored locally — comments
//      stay server-authoritative.
//
// Lives in the data dir (never inside a git worktree checkout), separate from
// the renderer-owned chat-tabs file so a background poll cannot race a chat
// save.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getSharedRunCommentsFilePath } from './paths';
import { isRecord } from './type-guards';

/** One watched shared run, keyed by its session identity. */
export interface SharedRunCommentEntry {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** `SharedRun.externalId` as of the last successful share. */
  externalId: string;
  /** Highest `commentRevision` the user has seen for this run. */
  lastSeenCommentRevision: number;
  /** Highest `commentRevision` observed from the server. */
  lastPolledCommentRevision: number;
  /** Comments added since `lastSeenCommentRevision`, for the unread badge. */
  unreadCommentCount: number;
}

export interface SharedRunCommentsFile {
  version: 1;
  entries: SharedRunCommentEntry[];
  /**
   * Rotating start offset for the poller's per-tick window. Persisted (not
   * in-memory) so a restart cannot re-pin the window to the first N entries.
   */
  pollCursor: number;
}

/** In-memory view of the whole file, so a partial write can never drop state. */
interface RegistryState {
  entries: SharedRunCommentEntry[];
  pollCursor: number;
}

/**
 * Reported when the registry file exists but cannot be parsed. Corruption
 * degrades to an empty registry (every badge and the whole poll go quiet), so
 * it must not be silent. Injected rather than imported to keep this module free
 * of the observability service — see `setSharedRunCommentsCorruptionReporter`.
 */
type CorruptionReporter = (details: { error: string }) => void;

let reportCorruption: CorruptionReporter = () => {};

/** Wire the real observability reporter at startup (no-op by default). */
export function setSharedRunCommentsCorruptionReporter(
  reporter: CorruptionReporter,
): void {
  reportCorruption = reporter;
}

/**
 * Serializes every read-modify-write so a poll tick and a renderer-driven
 * `markSeen` cannot interleave and clobber one another. Without this, the
 * poller re-writes `lastSeenCommentRevision` from its own stale snapshot and
 * the unread badge reappears immediately after the user reads a thread.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  // Keep the chain alive regardless of individual outcomes.
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function sharedRunCommentKey(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

// Fixed namespace UUID for Canopy shared-run idempotency keys (CAN-395).
const SHARED_RUN_NAMESPACE_UUID = '6f8d3a1e-2b7c-4c9a-9f1e-5a2b3c4d5e6f';

/**
 * Deterministic RFC 4122 UUIDv5 for a shared run, derived from the session
 * identity `(projectId, worktreeId, chatId)`. Re-sharing the same session (or
 * retrying after a timeout) reproduces the same key so the server-side
 * `(createdByUserId, clientLocalRunId)` idempotency upsert refreshes the
 * existing grant instead of creating duplicates. It is also the run's
 * `publicationId` in `core.publication.comment.*`.
 */
export function sharedRunIdempotencyKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  const name = `${projectId}\n${worktreeId}\n${chatId}`;
  const namespaceBytes = Buffer.from(
    SHARED_RUN_NAMESPACE_UUID.replace(/-/g, ''),
    'hex',
  );
  const digest = createHash('sha1')
    .update(namespaceBytes)
    .update(name, 'utf8')
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizeEntry(value: unknown): SharedRunCommentEntry | null {
  if (!isRecord(value)) return null;
  const { projectId, worktreeId, chatId, externalId } = value;
  if (
    typeof projectId !== 'string' ||
    typeof worktreeId !== 'string' ||
    typeof chatId !== 'string' ||
    typeof externalId !== 'string' ||
    externalId.length === 0
  ) {
    return null;
  }
  return {
    projectId,
    worktreeId,
    chatId,
    externalId,
    lastSeenCommentRevision: normalizeCount(value.lastSeenCommentRevision),
    lastPolledCommentRevision: normalizeCount(value.lastPolledCommentRevision),
    unreadCommentCount: normalizeCount(value.unreadCommentCount),
  };
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * Read the whole registry, degrading to empty on a missing or corrupt file. A
 * missing file is the normal cold-start case and stays silent; a corrupt one is
 * reported, because degrading to empty silently disables every badge and the
 * entire poll.
 */
async function readState(): Promise<RegistryState> {
  try {
    const raw = await readFile(getSharedRunCommentsFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
      reportCorruption({ error: 'registry file has an unexpected shape' });
      return { entries: [], pollCursor: 0 };
    }
    const entries: SharedRunCommentEntry[] = [];
    for (const candidate of parsed.entries) {
      const entry = normalizeEntry(candidate);
      if (entry) {
        entries.push(entry);
      }
    }
    return { entries, pollCursor: normalizeCount(parsed.pollCursor) };
  } catch (error) {
    if (!isMissingFileError(error)) {
      reportCorruption({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { entries: [], pollCursor: 0 };
  }
}

/** Read the registry, degrading to empty on a missing or corrupt file. */
export async function readSharedRunCommentEntries(): Promise<
  SharedRunCommentEntry[]
> {
  const { entries } = await readState();
  return entries;
}

/**
 * Write via temp-file + rename so an interrupted write cannot leave a
 * half-written (and therefore unparseable) registry behind. `rename` is atomic
 * within a filesystem, and the temp file is always cleaned up on failure.
 */
async function writeState(state: RegistryState): Promise<void> {
  const filePath = getSharedRunCommentsFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const file: SharedRunCommentsFile = {
    version: 1,
    entries: state.entries,
    pollCursor: state.pollCursor,
  };
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Claim the next window of entries to poll and advance the persisted cursor.
 *
 * The poller can only afford a bounded number of runs per tick, so it takes a
 * window rather than the whole registry. Taking a FIXED window (the first N)
 * starved everything past it: entries are stably ordered, new shares append to
 * the end, and a quiet run never reorders itself — so with more than N
 * registrations the most recently shared runs were never polled at all.
 *
 * A rotating cursor guarantees every entry is reached within
 * `ceil(entries.length / limit)` ticks regardless of comment activity. The
 * cursor is persisted so a restart cannot re-pin the window to the head, and it
 * wraps so the window stays full when it crosses the end of the list.
 */
export async function claimSharedRunCommentPollWindow(
  limit: number,
): Promise<SharedRunCommentEntry[]> {
  return enqueueMutation(async () => {
    const state = await readState();
    const total = state.entries.length;
    if (total === 0 || limit <= 0) {
      return [];
    }
    if (total <= limit) {
      // Everything fits in one tick; keep the cursor pinned at the start so the
      // ordering stays stable and predictable.
      if (state.pollCursor !== 0) {
        await writeState({ ...state, pollCursor: 0 });
      }
      return [...state.entries];
    }
    const start = state.pollCursor % total;
    const window: SharedRunCommentEntry[] = [];
    for (let offset = 0; offset < limit; offset += 1) {
      const entry = state.entries[(start + offset) % total];
      if (entry) {
        window.push(entry);
      }
    }
    await writeState({ ...state, pollCursor: (start + limit) % total });
    return window;
  });
}

export async function readSharedRunCommentEntry(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<SharedRunCommentEntry | null> {
  const key = sharedRunCommentKey(target);
  const entries = await readSharedRunCommentEntries();
  return entries.find((entry) => sharedRunCommentKey(entry) === key) ?? null;
}

/**
 * Register (or refresh) a shared session so the poller watches it. Called after
 * a successful share; a re-share keeps the existing seen/unread state because
 * the grant — and therefore its comment threads — survives in place.
 */
export async function registerSharedRunForComments(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  externalId: string;
}): Promise<void> {
  await enqueueMutation(async () => {
    const key = sharedRunCommentKey(target);
    const state = await readState();
    const existing = state.entries.find(
      (entry) => sharedRunCommentKey(entry) === key,
    );
    if (existing && existing.externalId === target.externalId) {
      return;
    }
    const next: SharedRunCommentEntry = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      externalId: target.externalId,
      // A brand-new grant (different externalId) starts with a clean slate: its
      // comment threads cascaded away with the old row.
      lastSeenCommentRevision: 0,
      lastPolledCommentRevision: 0,
      unreadCommentCount: 0,
    };
    await writeState({
      ...state,
      entries: [
        ...state.entries.filter((entry) => sharedRunCommentKey(entry) !== key),
        next,
      ],
    });
  });
}

/** Stop watching a session (unshared, or the grant is gone server-side). */
export async function unregisterSharedRunForComments(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<void> {
  await enqueueMutation(async () => {
    const key = sharedRunCommentKey(target);
    const state = await readState();
    const remaining = state.entries.filter(
      (entry) => sharedRunCommentKey(entry) !== key,
    );
    if (remaining.length === state.entries.length) {
      return;
    }
    await writeState({ ...state, entries: remaining });
  });
}

/**
 * Record the revision observed on a poll. Returns the updated entry so the
 * caller can decide whether to emit an unread event.
 *
 * The caller computed `unreadCount` from a snapshot taken BEFORE its network
 * round trip, so by the time we get here the user may have read the thread
 * (a `markSharedRunCommentsSeen` that landed mid-flight). Writing the caller's
 * count unconditionally would clobber the just-cleared `0` and re-light the
 * badge for comments the user is reading right now. So the count is reconciled
 * against the FRESH row read inside this mutation, and the returned entry is
 * what the caller must base its emit decision on — not its own stale snapshot.
 */
export async function recordPolledCommentRevision(
  target: { projectId: string; worktreeId: string; chatId: string },
  update: { externalId: string; commentRevision: number; unreadCount: number },
): Promise<SharedRunCommentEntry> {
  return enqueueMutation(async () => {
    const key = sharedRunCommentKey(target);
    const state = await readState();
    const index = state.entries.findIndex(
      (entry) => sharedRunCommentKey(entry) === key,
    );
    const existing = index === -1 ? undefined : state.entries[index];
    const lastSeenCommentRevision = existing?.lastSeenCommentRevision ?? 0;
    const next: SharedRunCommentEntry = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      externalId: update.externalId,
      lastSeenCommentRevision,
      // Never move the polled marker backwards: a concurrent `markSeen` may
      // already have raised it past the revision this tick observed.
      lastPolledCommentRevision: Math.max(
        existing?.lastPolledCommentRevision ?? 0,
        update.commentRevision,
      ),
      // Clamp to the revisions the user has NOT seen. Zero when the poll is
      // fully overlapped; otherwise bounded by the actual gap, since the
      // caller's count was derived against its own (older) seen marker and
      // would otherwise carry an inflated value forward for a partial overlap
      // — e.g. a markSeen(4) landing while this tick observed revision 5.
      unreadCommentCount: Math.min(
        update.unreadCount,
        Math.max(0, update.commentRevision - lastSeenCommentRevision),
      ),
    };
    // Replace IN PLACE rather than filter-and-append. Appending would reorder
    // the array on every poll that observed a change, which — combined with the
    // poller's windowing — made rotation depend on comment activity.
    const entries =
      index === -1
        ? [...state.entries, next]
        : state.entries.map((entry, position) =>
            position === index ? next : entry,
          );
    await writeState({ ...state, entries });
    return next;
  });
}

/**
 * Mark a run's comments seen up to `commentRevision`. Never moves the seen
 * marker backwards. Clears the unread count only when the seen marker covers
 * the latest poll; otherwise the count stays, since a false unread is safer
 * than a hidden one.
 */
export async function markSharedRunCommentsSeen(
  publicationId: string,
  commentRevision: number,
  signal?: AbortSignal,
  onStart?: () => void,
): Promise<SharedRunCommentEntry | null> {
  // Resolved inside the queue, so a pending registration or poll lands first.
  return enqueueMutation(async () => {
    // A call cancelled while it waited writes nothing.
    signal?.throwIfAborted();
    onStart?.();
    const state = await readState();
    const index = state.entries.findIndex(
      (entry) =>
        sharedRunIdempotencyKey(
          entry.projectId,
          entry.worktreeId,
          entry.chatId,
        ) === publicationId,
    );
    const existing = index === -1 ? undefined : state.entries[index];
    if (!existing) {
      return null;
    }
    const seen = Math.max(
      existing.lastSeenCommentRevision,
      normalizeCount(commentRevision),
    );
    const next: SharedRunCommentEntry = {
      ...existing,
      lastSeenCommentRevision: seen,
      lastPolledCommentRevision: Math.max(
        existing.lastPolledCommentRevision,
        seen,
      ),
      // Only a mark that covers the latest poll clears the badge; a late one
      // keeps the count, since a false unread is safer than a hidden one.
      unreadCommentCount:
        seen >= existing.lastPolledCommentRevision
          ? 0
          : existing.unreadCommentCount,
    };
    await writeState({
      ...state,
      entries: state.entries.map((entry, position) =>
        position === index ? next : entry,
      ),
    });
    return next;
  });
}
