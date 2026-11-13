import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MEMORY_SYNC_LIMITS,
  MemoryNoteFileKeySchema,
  isMemoryDocumentPath,
  isMemoryNoteOriginBlocked,
  memorySyncJsonBytes,
  type MemoryNote,
  type MemoryNoteOp,
  type MemoryNoteOpResult,
  type MemoryOriginPolicy,
  type MemorySyncOutboxFile,
  type MemorySyncStateFile,
} from '@canopy/protocol/memory-sync';
import { withMemoryWriteLock } from '../local/edit-coordination';
import { retireImportNotes } from '../local/import/ledger';
import {
  assertMemoryPathContained,
  assertMemoryScopeLockHeld,
  isMemoryMarkdownFileName,
  isNodeError,
  moveWithoutReplacing,
  writeMemoryFileDurably,
} from '../local/memory-files';
import { memoryNoteId } from '../local/note-identity';
import { LocalMemoryScopeLockLostError } from '../local/scope-lock';
import { renderPulledNote } from './note-records';
import {
  readMemorySyncOutbox,
  readMemorySyncState,
  sha256Hex,
  writeMemorySyncOutbox,
  writeMemorySyncState,
  type MemoryReplicaBinding,
} from './replica-files';

/*
 * A scope's outbox (design §10.2): note operations waiting to be pushed, in
 * the order they were made, kept in `sync-outbox.json`. Everything here runs
 * under the scope lock. An operation is queued before the note file it
 * describes is written, so a crash in between cannot leave a note that never
 * syncs: a new note comes back through the feed once pushed, and a delete
 * or edit is finished here from its `localDeletes` entry in every mode.
 *
 * Each operation has a `seq` of its own and is marked `sent` before its first
 * push. From then on the server may hold it: it is sent again until a push
 * answers for it, only that answer removes it, and a later edit or delete of
 * its note is queued after it instead of cancelling it.
 *
 * An operation that leaves without reaching the server (held back or
 * refused) may hold the only copy of its note, so its note file is written
 * and flushed first, then `sync-state.json`, and the outbox last.
 */

type OutboxEntry = MemorySyncOutboxFile['ops'][number];
type LocalDelete = NonNullable<MemorySyncOutboxFile['localDeletes']>[number];
type NoteWriteOp = Extract<MemoryNoteOp, { op: 'put' | 'replace' }>;

interface QueuedEntry extends OutboxEntry {
  seq: number;
  sent: boolean;
}

interface Outbox {
  file: MemorySyncOutboxFile;
  entries: QueuedEntry[];
  localDeletes: LocalDelete[];
  nextSeq: number;
  /** Reading gave entries the identity their file lacks. */
  upgraded: boolean;
}

/** One push: its operations, each with the `seq` its answer settles. */
export type MemoryPushBatch = ReadonlyArray<{
  readonly seq: number;
  readonly op: MemoryNoteOp;
}>;

function opNoteId(op: MemoryNoteOp): string {
  return op.op === 'tombstone' ? op.noteId : op.note.noteId;
}

/** Whether `op` tombstones `noteId` or carries a note that supersedes it. */
function retires(op: MemoryNoteOp, noteId: string): boolean {
  return op.op === 'tombstone'
    ? op.noteId === noteId
    : op.note.supersedes === noteId;
}

export class MemorySyncOutboxUnreadableError extends Error {
  constructor() {
    super('The memory sync outbox could not be read');
    this.name = 'MemorySyncOutboxUnreadableError';
  }
}

async function readOutbox(
  scopeDir: string,
  binding: MemoryReplicaBinding,
): Promise<Outbox> {
  const file = await readMemorySyncOutbox(scopeDir, binding);
  if (file === null) throw new MemorySyncOutboxUnreadableError();
  let nextSeq = Math.max(
    file.nextSeq ?? 1,
    (file.usageSent?.seq ?? 0) + 1,
    ...file.ops.map((entry) => (entry.seq ?? 0) + 1),
  );
  const seen = new Set<number>();
  let upgraded = false;
  const entries = file.ops.map((entry): QueuedEntry => {
    if (entry.seq !== undefined && !seen.has(entry.seq)) {
      seen.add(entry.seq);
      return { ...entry, seq: entry.seq, sent: entry.sent ?? false };
    }
    // An earlier build kept no record of what it sent: assume it was.
    upgraded = true;
    const seq = nextSeq;
    nextSeq += 1;
    return { ...entry, seq, sent: true };
  });
  return {
    file,
    entries,
    localDeletes: [...(file.localDeletes ?? [])],
    nextSeq,
    upgraded,
  };
}

async function writeOutbox(scopeDir: string, outbox: Outbox): Promise<void> {
  await writeMemorySyncOutbox(scopeDir, {
    ...outbox.file,
    nextSeq: outbox.nextSeq,
    ops: outbox.entries,
    localDeletes:
      outbox.localDeletes.length === 0 ? undefined : outbox.localDeletes,
  });
}

/** Notes `localDeletes` deletes; an edit's entry deletes nothing. */
function locallyDeleted(outbox: Outbox): ReadonlySet<string> {
  return new Set(
    outbox.localDeletes.flatMap((pending) =>
      pending.replacedBy === undefined ? [pending.noteId] : [],
    ),
  );
}

/** Whether the outbox, apart from `except`, retires or deletes `noteId`. */
function isRetired(
  outbox: Outbox,
  noteId: string,
  except: QueuedEntry | undefined,
): boolean {
  return (
    locallyDeleted(outbox).has(noteId) ||
    outbox.entries.some(
      (entry) => entry !== except && retires(entry.op, noteId),
    )
  );
}

/**
 * The tombstone a replacement that never reaches the server leaves in its
 * place: the note it superseded is retired anyway, so the cloud and other
 * devices never keep the version this device replaced, and no snapshot or
 * replayed page brings it back beside its replacement.
 */
function retirementOf(
  outbox: Outbox,
  entry: QueuedEntry,
  op: MemoryNoteOp,
): QueuedEntry[] {
  if (
    op.op !== 'replace' ||
    op.note.supersedes === undefined ||
    isRetired(outbox, op.note.supersedes, entry)
  ) {
    return [];
  }
  const seq = outbox.nextSeq;
  outbox.nextSeq += 1;
  return [
    {
      seq,
      queuedAt: entry.queuedAt,
      attempts: 0,
      sent: false,
      op: {
        op: 'tombstone',
        noteId: op.note.supersedes,
        deletedAt: entry.queuedAt,
      },
    },
  ];
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'EISDIR')) {
      return null;
    }
    throw error;
  }
}

/** Names tried for a kept note before giving up. */
const MAX_KEPT_NOTE_NAMES = 100;

/** Where a kept note may already be: the inbox, or archived from it. */
const KEPT_NOTE_FOLDERS = ['inbox', 'inbox/.consolidated'];

/**
 * Leaves `note` on this device before the operation carrying it leaves the
 * outbox unsent. A note is queued before its file is written, so a save the
 * app quit during leaves the operation as the note's only copy: the note is
 * written then, under its own name or else a free one, and flushed to disk
 * before this resolves. A note already on disk is left alone, and so is
 * every other file: an edit cut short is finished by its `localDeletes`
 * entry (see {@link settleLocalChange}), which replaces a file only while it
 * holds the bytes the edit saw.
 */
async function keepNoteOnDevice(
  scopeDir: string,
  note: MemoryNote,
): Promise<void> {
  const path = join(scopeDir, note.fileKey);
  const occupant = await readTextOrNull(path);
  if (
    occupant !== null &&
    (note.kind === 'import' || memoryNoteId(occupant) === note.noteId)
  ) {
    return;
  }
  if (
    note.kind === 'inbox' &&
    (await findInboxNote(scopeDir, note.noteId, KEPT_NOTE_FOLDERS)) !== null
  ) {
    return;
  }
  const content = renderPulledNote(note);
  const modified = new Date(note.modifiedAt);
  const times = { atime: modified, mtime: modified };
  const stem = path.slice(0, -'.md'.length);
  const suffix = note.noteId.slice(-10).toLowerCase();
  for (let attempt = 0; attempt < MAX_KEPT_NOTE_NAMES; attempt += 1) {
    const candidate =
      attempt === 0
        ? path
        : `${stem}-${suffix}${attempt === 1 ? '' : `-${attempt}`}.md`;
    try {
      await writeMemoryFileDurably(scopeDir, candidate, content, {
        replace: false,
        times,
      });
      return;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
  }
  throw new Error('A memory note kept on this device has no free name');
}

/** A note file a queued change removes or replaces, as the change saw it. */
export interface MemoryRetiredNoteFile {
  fileKey: string;
  content: string;
  /** What an edit writes over the file. */
  replacement?: string;
}

/** What an edit's entry writes over its file; null content when lost. */
interface EditReplacement {
  noteId: string;
  content: string | null;
  localOnly: boolean;
}

/**
 * The replacement of an edit's entry, or null for a delete's. An entry an
 * earlier build wrote carries no replacement: a note still queued that
 * replaces its note supplies it then.
 */
function replacementOf(
  outbox: Outbox,
  pending: LocalDelete,
): EditReplacement | null {
  const queued = outbox.entries.flatMap(({ op }) =>
    op.op !== 'tombstone' &&
    (pending.replacedBy === undefined
      ? op.note.supersedes === pending.noteId
      : op.note.noteId === pending.replacedBy)
      ? [op.note]
      : [],
  )[0];
  const noteId = pending.replacedBy ?? queued?.noteId;
  if (noteId === undefined) return null;
  const kept = pending.replacement;
  if (kept !== undefined && sha256Hex(kept.content) === kept.contentHash) {
    return {
      noteId,
      content: kept.content,
      localOnly: kept.localOnly === true,
    };
  }
  return {
    noteId,
    content: queued === undefined ? null : renderPulledNote(queued),
    localOnly: kept?.localOnly === true || queued === undefined,
  };
}

/**
 * Settles one `localDeletes` entry's file, then the local-only marks in
 * `localOnly`; whether the entry is done. A file no longer holding the bytes
 * the change saw is left alone: without the note the change is done, and
 * other bytes of the note are a change made since, kept as a local-only
 * note. Otherwise a delete removes the file and an edit writes its
 * replacement over it, so an edit never removes its file and always leaves
 * its newest wording. An edit whose replacement is lost, or an earlier
 * build's entry without the bytes it saw, keeps its file and entry.
 */
async function settleLocalChange(
  scopeDir: string,
  pending: LocalDelete,
  replacement: EditReplacement | null,
  localOnly: Set<string>,
): Promise<boolean> {
  const path = join(scopeDir, pending.fileKey);
  const content = await readTextOrNull(path);
  const holding = content === null ? null : memoryNoteId(content);
  if (holding !== pending.noteId) {
    localOnly.delete(pending.noteId);
    if (replacement?.localOnly === true) {
      if (holding === replacement.noteId) localOnly.add(replacement.noteId);
      else localOnly.delete(replacement.noteId);
    }
    return true;
  }
  if (
    content !== null &&
    pending.contentHash !== undefined &&
    sha256Hex(content) !== pending.contentHash
  ) {
    localOnly.add(pending.noteId);
    if (replacement?.localOnly === true) localOnly.delete(replacement.noteId);
    return true;
  }
  if (replacement === null) {
    await assertMemoryPathContained(scopeDir, path);
    await assertMemoryScopeLockHeld();
    await unlink(path).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
    localOnly.delete(pending.noteId);
    return true;
  }
  if (replacement.content === null || pending.contentHash === undefined) {
    return false;
  }
  await writeMemoryFileDurably(scopeDir, path, replacement.content, {
    replace: true,
  });
  localOnly.delete(pending.noteId);
  if (replacement.localOnly) localOnly.add(replacement.noteId);
  return true;
}

interface LocalChangesSettled {
  /** Entries left the outbox. */
  changed: boolean;
  /** Edits kept with their file because their replacement is lost. */
  unsettledEdits: number;
}

/**
 * Finishes what `localDeletes` records, in order (see
 * {@link settleLocalChange}); the caller holds the scope lock, then writes
 * `sync-state.json` with `localOnly` and the outbox last, so a crash in
 * between replays the same entries. An edit a later edit of the same note
 * follows only gives way to it. An entry whose file cannot be settled yet
 * stays for the next attempt. Every mode settles through here: the start of
 * a pass, a push and its answer, and a Memory panel write.
 */
async function finishLocalDeletes(
  scopeDir: string,
  outbox: Outbox,
  localOnly: Set<string>,
): Promise<LocalChangesSettled> {
  const pending = outbox.localDeletes;
  if (pending.length === 0) return { changed: false, unsettledEdits: 0 };
  const replacements = pending.map((entry) => replacementOf(outbox, entry));
  const left: LocalDelete[] = [];
  let unsettledEdits = 0;
  for (const [index, entry] of pending.entries()) {
    const replacement = replacements[index] ?? null;
    const followed =
      replacement !== null &&
      pending.some(
        (later, laterIndex) =>
          laterIndex > index &&
          later.noteId === entry.noteId &&
          later.fileKey === entry.fileKey &&
          replacements[laterIndex] !== null,
      );
    if (followed) {
      if (replacement.localOnly) localOnly.delete(replacement.noteId);
      continue;
    }
    try {
      if (await settleLocalChange(scopeDir, entry, replacement, localOnly)) {
        continue;
      }
      unsettledEdits += 1;
    } catch (error) {
      if (error instanceof LocalMemoryScopeLockLostError) throw error;
    }
    left.push(entry);
  }
  const changed = left.length !== pending.length;
  outbox.localDeletes = left;
  return { changed, unsettledEdits };
}

/** Notes an edit not settled yet still has to write. */
function pendingReplacements(outbox: Outbox): ReadonlySet<string> {
  return new Set(
    outbox.localDeletes.flatMap((pending) =>
      pending.replacedBy === undefined ? [] : [pending.replacedBy],
    ),
  );
}

function sameNoteIds(
  next: ReadonlySet<string>,
  previous: readonly string[],
): boolean {
  return next.size === previous.length && previous.every((id) => next.has(id));
}

/** The scope's error while an edit keeps its file for a lost replacement. */
export const MEMORY_LOCAL_EDIT_UNSETTLED_CODE = 'memory_local_edit_unsettled';

/**
 * Finishes the scope's pending local deletes and edits (see
 * {@link finishLocalDeletes}); the caller holds the scope lock. An edit kept
 * for a lost replacement is recorded as the scope's error. Resolves the
 * number of such edits.
 */
export async function settleMemoryLocalChanges(
  scopeDir: string,
  now: Date,
): Promise<number> {
  const state = await readMemorySyncState(scopeDir);
  if (state === undefined || state === null) return 0;
  const outbox = await readOutbox(scopeDir, state.binding).catch(
    (error: unknown) => {
      if (error instanceof MemorySyncOutboxUnreadableError) return null;
      throw error;
    },
  );
  if (outbox === null) return 0;
  const localOnly = new Set(state.localOnlyNoteIds);
  const { changed, unsettledEdits } = await finishLocalDeletes(
    scopeDir,
    outbox,
    localOnly,
  );
  const flagged =
    unsettledEdits > 0 &&
    state.lastError?.code !== MEMORY_LOCAL_EDIT_UNSETTLED_CODE;
  if (flagged || !sameNoteIds(localOnly, state.localOnlyNoteIds)) {
    await writeMemorySyncState(scopeDir, {
      ...state,
      localOnlyNoteIds: [...localOnly],
      ...(flagged
        ? {
            lastError: {
              code: MEMORY_LOCAL_EDIT_UNSETTLED_CODE,
              at: now.toISOString(),
            },
          }
        : {}),
    });
  }
  if (changed) await writeOutbox(scopeDir, outbox);
  return unsettledEdits;
}

/**
 * Finishes the scope's pending local deletes and edits under its lock, at
 * the start of every pass and before it can return early, so a change cut
 * short is settled in a replica that does not push too (paused, device-only,
 * deleted in the cloud, a failed request or another process holding the
 * engine lock). Resolves the number of edits kept for a lost replacement.
 */
export function finishMemoryLocalDeletes(
  scopeDir: string,
  now: Date,
): Promise<number> {
  return withMemoryWriteLock(scopeDir, () =>
    settleMemoryLocalChanges(scopeDir, now),
  );
}

/**
 * What an edit or delete leaves to send when it takes the place of its
 * note's unsent operation. The server never hears of a note it was never
 * sent, but a replacement passes on the note it superseded, so that note is
 * still retired however many unsent edits followed it.
 */
function inPlaceOf(
  unsent: NoteWriteOp,
  next: Exclude<MemoryNoteOp, { op: 'put' }>,
): MemoryNoteOp | null {
  const retired = unsent.op === 'replace' ? unsent.note.supersedes : undefined;
  if (next.op === 'tombstone') {
    return retired === undefined
      ? null
      : { op: 'tombstone', noteId: retired, deletedAt: next.deletedAt };
  }
  return retired === undefined
    ? { op: 'put', note: next.note }
    : { op: 'replace', note: { ...next.note, supersedes: retired } };
}

/**
 * The `localDeletes` entry a delete or an edit leaves: the note and file it
 * removes or replaces, with the bytes it read, and for an edit the note and
 * bytes it writes there (`replacedBy`, `replacement`), so it is never taken
 * for a delete. `cancelled` is the unsent operation it took the place of.
 */
function localDeleteOf(
  op: Exclude<MemoryNoteOp, { op: 'put' }>,
  cancelled: NoteWriteOp | null,
  retired: MemoryRetiredNoteFile | null,
): LocalDelete[] {
  const fileKey = retired?.fileKey ?? cancelled?.note.fileKey;
  const read = retired === null ? null : memoryNoteId(retired.content);
  const noteId =
    op.op === 'tombstone'
      ? (cancelled?.note.noteId ?? op.noteId)
      : (read ?? cancelled?.note.noteId ?? op.note.supersedes);
  if (noteId === undefined || fileKey === undefined) return [];
  const replacement = retired?.replacement;
  return [
    {
      noteId,
      fileKey,
      ...(retired === null ? {} : { contentHash: sha256Hex(retired.content) }),
      ...(op.op === 'tombstone'
        ? {}
        : {
            replacedBy: op.note.noteId,
            ...(replacement === undefined
              ? {}
              : {
                  replacement: {
                    contentHash: sha256Hex(replacement),
                    content: replacement,
                  },
                }),
          }),
    },
  ];
}

/**
 * Queues an operation; the caller holds the scope's write lock. `retired` is
 * the file an edit replaces or a delete removes, as the change read it.
 * Editing or deleting a note whose own operation was never sent takes that
 * operation's place (see {@link inPlaceOf}); one already sent stays queued
 * before it.
 *
 * Every delete and every edit records its file in `localDeletes` in the
 * same write as its operation, so the file and the local-only marks are
 * settled in every mode (see {@link finishLocalDeletes}) even when removing
 * or replacing the file then fails or the app quits first: a delete removes
 * the file, and an edit writes the replacement it records over it. Nothing
 * pulled settles them otherwise: the server never hears of a cancelled note,
 * holds no copy of a local-only one, and a scope that does not push never
 * gets an edit back.
 */
export async function queueMemoryNoteOp(
  scopeDir: string,
  binding: MemoryReplicaBinding,
  op: MemoryNoteOp,
  now: Date,
  retired: MemoryRetiredNoteFile | null,
): Promise<void> {
  const outbox = await readOutbox(scopeDir, binding);
  let queued: MemoryNoteOp | null = op;
  if (op.op !== 'put') {
    const replacedId = op.op === 'tombstone' ? op.noteId : op.note.supersedes;
    const index = outbox.entries.findIndex(
      (entry) =>
        !entry.sent &&
        entry.op.op !== 'tombstone' &&
        entry.op.note.noteId === replacedId,
    );
    const unsent = outbox.entries[index];
    let cancelled: NoteWriteOp | null = null;
    if (unsent !== undefined && unsent.op.op !== 'tombstone') {
      outbox.entries.splice(index, 1);
      queued = inPlaceOf(unsent.op, op);
      cancelled = unsent.op;
    }
    outbox.localDeletes.push(...localDeleteOf(op, cancelled, retired));
  }
  if (queued !== null) {
    outbox.entries.push({
      seq: outbox.nextSeq,
      queuedAt: now.toISOString(),
      attempts: 0,
      sent: false,
      op: queued,
    });
    outbox.nextSeq += 1;
  }
  await writeOutbox(scopeDir, outbox);
}

/** Drops a queued, unsent operation whose note write was abandoned. */
export async function dropQueuedMemoryNoteOp(
  scopeDir: string,
  binding: MemoryReplicaBinding,
  noteId: string,
): Promise<void> {
  const outbox = await readOutbox(scopeDir, binding);
  const kept = outbox.entries.filter(
    (entry) => entry.sent || opNoteId(entry.op) !== noteId,
  );
  if (kept.length === outbox.entries.length) return;
  await writeOutbox(scopeDir, { ...outbox, entries: kept });
}

/** Records notes that stay on this device; the caller holds the lock. */
export async function markMemoryNotesLocalOnly(
  scopeDir: string,
  noteIds: readonly string[],
): Promise<void> {
  const state = await readMemorySyncState(scopeDir);
  if (state === undefined || state === null) return;
  const added = noteIds.filter((id) => !state.localOnlyNoteIds.includes(id));
  if (added.length === 0) return;
  await writeMemorySyncState(scopeDir, {
    ...state,
    localOnlyNoteIds: [...state.localOnlyNoteIds, ...added],
  });
}

/**
 * Records an edit that stays on this device, before its replacement is
 * written over the note at `fileKey`; the caller holds the lock. The outbox
 * records the edit and its replacement first, then the replacement is marked
 * local-only. Settling it (see {@link settleLocalChange}) writes the
 * replacement when the edit was cut short, then moves the mark from the
 * note it replaced to the replacement.
 */
export async function keepMemoryNoteEditLocal(
  scopeDir: string,
  binding: MemoryReplicaBinding,
  edit: {
    noteId: string;
    fileKey: string;
    previousContent: string;
    replacementId: string;
    content: string;
  },
): Promise<void> {
  const outbox = await readOutbox(scopeDir, binding);
  outbox.localDeletes.push({
    noteId: edit.noteId,
    fileKey: edit.fileKey,
    contentHash: sha256Hex(edit.previousContent),
    replacedBy: edit.replacementId,
    replacement: {
      contentHash: sha256Hex(edit.content),
      content: edit.content,
      localOnly: true,
    },
  });
  await writeOutbox(scopeDir, outbox);
  await markMemoryNotesLocalOnly(scopeDir, [edit.replacementId]);
}

/** Bytes of `{"ops":[]}` and slack for the envelope. */
const PUSH_ENVELOPE_BYTES = 1024;

/**
 * Queued operations in order, at most `pushOpsMax` and within the push
 * request's byte limit, each note once, up to a note in `unwritten` (an
 * edit's replacement not on disk yet). The first operation goes otherwise,
 * since one note always fits a request on its own.
 */
function nextBatch(
  entries: readonly QueuedEntry[],
  unwritten: ReadonlySet<string>,
): QueuedEntry[] {
  const batch: QueuedEntry[] = [];
  const ids = new Set<string>();
  let bytes = PUSH_ENVELOPE_BYTES;
  for (const entry of entries) {
    if (batch.length >= MEMORY_SYNC_LIMITS.pushOpsMax) break;
    const id = opNoteId(entry.op);
    if (ids.has(id) || unwritten.has(id)) break;
    const opBytes = memorySyncJsonBytes(entry.op) + 1;
    if (
      batch.length > 0 &&
      bytes + opBytes > MEMORY_SYNC_LIMITS.pushRequestMaxBytes
    ) {
      break;
    }
    batch.push(entry);
    ids.add(id);
    bytes += opBytes;
  }
  return batch;
}

function isHeldBack(op: MemoryNoteOp, origins: MemoryOriginPolicy): boolean {
  return (
    op.op !== 'tombstone' &&
    isMemoryNoteOriginBlocked(origins, op.note.origin.organizationId)
  );
}

/**
 * The scope's next push, taken under the scope lock from the outbox as it is
 * now, however recently a note was queued. User-scope notes an organization
 * keeps off the cloud (design §10.4) first move out of the outbox into
 * `localOnlyNoteIds`, unless a later delete or edit retires them; each keeps
 * its file, written now when the app quit before writing it (see
 * {@link keepNoteOnDevice}), and a held replacement
 * leaves a tombstone of the note it superseded (see {@link retirementOf}).
 * Pending local deletes and edits are finished first (see
 * {@link finishLocalDeletes}), so a held note an edit cut short is written
 * in its note's place, and before `sync-state.json` is written. An edit's
 * replacement still unwritten then is not sent. The batch is marked sent
 * before the caller sends it; `maySend`, asked under the lock first, keeps
 * every operation queued and unsent when it answers false.
 */
export function takeMemoryPushBatch(
  scopeDir: string,
  blockedOrganizationIds: ReadonlySet<string>,
  maySend?: () => Promise<boolean>,
): Promise<MemoryPushBatch> {
  return withMemoryWriteLock(scopeDir, async () => {
    const state = await readMemorySyncState(scopeDir);
    if (state === undefined || state === null) return [];
    const outbox = await readOutbox(scopeDir, state.binding);
    const localOnly = new Set(state.localOnlyNoteIds);
    const deletedHere = locallyDeleted(outbox);
    const { changed: finished } = await finishLocalDeletes(
      scopeDir,
      outbox,
      localOnly,
    );
    const unwritten = pendingReplacements(outbox);
    const origins: MemoryOriginPolicy = {
      scopeKind: state.binding.kind,
      blockedOriginOrganizationIds: blockedOrganizationIds,
    };
    const held = outbox.entries.filter((entry) =>
      isHeldBack(entry.op, origins),
    );
    for (const entry of held) {
      const { op } = entry;
      if (
        op.op !== 'tombstone' &&
        !isRetired(outbox, op.note.noteId, entry) &&
        !deletedHere.has(op.note.noteId)
      ) {
        if (!unwritten.has(op.note.noteId)) {
          await keepNoteOnDevice(scopeDir, op.note);
        }
        localOnly.add(op.note.noteId);
      }
    }
    if (!sameNoteIds(localOnly, state.localOnlyNoteIds)) {
      await writeMemorySyncState(scopeDir, {
        ...state,
        localOnlyNoteIds: [...localOnly],
      });
    }
    if (held.length > 0) {
      outbox.entries = outbox.entries.flatMap((entry) =>
        held.includes(entry) ? retirementOf(outbox, entry, entry.op) : [entry],
      );
    }
    const next = nextBatch(outbox.entries, unwritten);
    const batch =
      next.length === 0 || maySend === undefined || (await maySend())
        ? next
        : [];
    const unsent = batch.filter((entry) => !entry.sent);
    for (const entry of unsent) entry.sent = true;
    if (held.length > 0 || unsent.length > 0 || outbox.upgraded || finished) {
      await writeOutbox(scopeDir, outbox);
    }
    return batch.map(({ seq, op }) => ({ seq, op }));
  });
}

/** The file key of the file in `folders` that holds `noteId`. */
async function findInboxNote(
  scopeDir: string,
  noteId: string,
  folders: readonly string[] = ['inbox'],
): Promise<string | null> {
  for (const folder of folders) {
    let names: string[];
    try {
      names = await readdir(join(scopeDir, folder));
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
        continue;
      }
      throw error;
    }
    for (const name of names.filter(isMemoryMarkdownFileName)) {
      const content = await readFile(
        join(scopeDir, folder, name),
        'utf8',
      ).catch(() => null);
      if (content !== null && memoryNoteId(content) === noteId) {
        return `${folder}/${name}`;
      }
    }
  }
  return null;
}

export interface MemoryPushSettlement {
  acknowledged: number;
  /** Notes the server refused that stay on this device only. */
  keptLocal: number;
  /** The last refusal's code, for the scope's status. */
  rejectedCode: string | null;
  /** Notes a snapshot kept whose operation came back replayed. */
  snapshotKeptReplayed: number;
}

/**
 * The snapshot's kept notes (see `snapshotKept` in `sync-state.json`) after
 * a push's answers: a note whose put or replacement came back replayed or
 * renamed records the body it carried and the push's cursor, since the
 * server may have held it before the snapshot; any other answer means the
 * server has the note now, never had it, or this device keeps it, and its
 * entry goes. A tombstone's answer changes nothing here.
 */
function snapshotKeptAfterPush(
  kept: MemorySyncStateFile['snapshotKept'],
  sent: MemoryPushBatch,
  results: readonly MemoryNoteOpResult[],
  cursor: string | null,
): { kept: MemorySyncStateFile['snapshotKept']; replayed: number } {
  if (kept === undefined) return { kept, replayed: 0 };
  let replayed = 0;
  const notes = kept.notes.flatMap((entry) => {
    const op = sent.find(
      (candidate) =>
        candidate.op.op !== 'tombstone' &&
        candidate.op.note.noteId === entry.noteId,
    )?.op;
    const result = results.find(
      (candidate) => candidate.noteId === entry.noteId,
    );
    if (op === undefined || op.op === 'tombstone' || result === undefined) {
      return [entry];
    }
    if (result.outcome !== 'replayed' && result.outcome !== 'renamed') {
      return [];
    }
    replayed += 1;
    return [
      {
        ...entry,
        replayed: { contentHash: op.note.contentHash, cursor },
      },
    ];
  });
  return {
    kept: notes.length === 0 ? undefined : { ...kept, notes },
    replayed,
  };
}

/**
 * Applies a push's per-operation results (design §10.2): each answered
 * operation leaves the outbox, by its `seq`, so an operation queued for the
 * same note while the push was in flight stays. A renamed note takes the
 * server's file key, a de-duplicated import loses its local copy, and a
 * refused note no later delete or edit retires stays as a local-only note,
 * its file written first when the app quit before writing it, and a refused
 * replacement leaves a tombstone
 * of the note it superseded. Pending local deletes and edits are finished
 * first, before a file is renamed or any answered tombstone leaves, whatever
 * the answer was: a delete of a note the server never held brings nothing
 * back through the feed, and an edit cut short is finished in its note's
 * place. Files are written first, `sync-state.json` before the outbox, so a
 * crash between them sends the answered operations again rather than losing
 * a refused note's local-only mark. Sent operations without a result stay
 * queued. A note a snapshot kept whose operation came back replayed is
 * recorded with `cursor`, the push's, in the same `sync-state.json` write,
 * for the pull that settles it (see {@link snapshotKeptAfterPush}).
 */
export function settleMemoryPush(
  scopeDir: string,
  sent: MemoryPushBatch,
  results: readonly MemoryNoteOpResult[],
  now: Date,
  cursor: string | null = null,
): Promise<MemoryPushSettlement> {
  return withMemoryWriteLock(scopeDir, async () => {
    const state = await readMemorySyncState(scopeDir);
    if (state === undefined || state === null) {
      return {
        acknowledged: 0,
        keptLocal: 0,
        rejectedCode: null,
        snapshotKeptReplayed: 0,
      };
    }
    const outbox = await readOutbox(scopeDir, state.binding);
    const seqByNote = new Map(sent.map(({ seq, op }) => [opNoteId(op), seq]));
    const sentSeqs = new Set(sent.map(({ seq }) => seq));
    const settled = new Set<number>();
    const localOnly = new Set(state.localOnlyNoteIds);
    const deletedHere = locallyDeleted(outbox);
    await finishLocalDeletes(scopeDir, outbox, localOnly);
    const unwritten = pendingReplacements(outbox);
    const refused: Array<{ seq: number; op: NoteWriteOp }> = [];
    let rejectedCode: string | null = null;
    let keptLocal = 0;
    for (const result of results) {
      const seq = seqByNote.get(result.noteId);
      if (seq === undefined || settled.has(seq)) continue;
      settled.add(seq);
      if (result.outcome === 'renamed') {
        await renameNote(scopeDir, result.noteId, result.fileKey);
      } else if (result.outcome === 'deduplicated') {
        await removeDeduplicatedImport(scopeDir, sent, result.noteId, now);
      } else if (result.outcome === 'rejected') {
        rejectedCode = result.code;
        keptLocal += 1;
        const op = sent.find((candidate) => candidate.seq === seq)?.op;
        if (op !== undefined && op.op !== 'tombstone') {
          refused.push({ seq, op });
        }
      }
    }
    const retirements: QueuedEntry[] = [];
    for (const { seq, op } of refused) {
      const entry = outbox.entries.find((candidate) => candidate.seq === seq);
      if (
        !isRetired(outbox, op.note.noteId, entry) &&
        !deletedHere.has(op.note.noteId)
      ) {
        if (!unwritten.has(op.note.noteId)) {
          await keepNoteOnDevice(scopeDir, op.note);
        }
        localOnly.add(op.note.noteId);
      }
      if (entry !== undefined) {
        retirements.push(...retirementOf(outbox, entry, op));
      }
    }
    const snapshotKept = snapshotKeptAfterPush(
      state.snapshotKept,
      sent,
      results,
      cursor,
    );
    const next: MemorySyncStateFile = {
      ...state,
      snapshotKept: snapshotKept.kept,
      localOnlyNoteIds: [...localOnly],
      lastPushedAt: now.toISOString(),
      lastError:
        rejectedCode === null
          ? state.lastError
          : { code: rejectedCode, at: now.toISOString() },
    };
    await writeMemorySyncState(scopeDir, next);
    await writeOutbox(scopeDir, {
      ...outbox,
      entries: [
        ...outbox.entries.flatMap((entry) => {
          if (settled.has(entry.seq)) return [];
          return sentSeqs.has(entry.seq)
            ? [{ ...entry, attempts: entry.attempts + 1 }]
            : [entry];
        }),
        ...retirements,
      ],
    });
    return {
      acknowledged: settled.size - keptLocal,
      keptLocal,
      rejectedCode,
      snapshotKeptReplayed: snapshotKept.replayed,
    };
  });
}

async function renameNote(
  scopeDir: string,
  noteId: string,
  fileKey: string,
): Promise<void> {
  const current = await findInboxNote(scopeDir, noteId);
  if (current === null || current === fileKey) return;
  await moveWithoutReplacing(
    scopeDir,
    join(scopeDir, current),
    join(scopeDir, fileKey),
  ).catch((error: unknown) => {
    if (!isNodeError(error, 'EEXIST')) throw error;
  });
}

/**
 * Removes the local copy of an import the cloud already holds, then retires
 * it. The file goes only while it still holds that import: the cloud holds
 * those bytes, not whatever was staged under the name since.
 */
async function removeDeduplicatedImport(
  scopeDir: string,
  sent: MemoryPushBatch,
  noteId: string,
  now: Date,
): Promise<void> {
  const op = sent.find(
    (candidate) =>
      candidate.op.op !== 'tombstone' && candidate.op.note.noteId === noteId,
  )?.op;
  if (op === undefined || op.op === 'tombstone' || op.note.kind !== 'import') {
    return;
  }
  const path = join(scopeDir, op.note.fileKey);
  if ((await readTextOrNull(path)) === op.note.body) {
    await assertMemoryPathContained(scopeDir, path);
    await assertMemoryScopeLockHeld();
    await unlink(path).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
  }
  await retireImportNotes(scopeDir, new Set([noteId]), now.toISOString());
}

/** Queued operations, for status and for the next push. */
export async function readQueuedMemoryNoteOps(
  scopeDir: string,
  binding: MemoryReplicaBinding,
): Promise<readonly OutboxEntry[]> {
  return (await readOutbox(scopeDir, binding)).entries;
}

/**
 * Adds uses to the scope's usage deltas (design §15), kept until the cloud
 * acknowledges them. Pushes are at-least-once: a retried delta can only
 * over-count, which makes pruning less likely.
 */
export function recordMemoryUsageDeltas(
  scopeDir: string,
  binding: MemoryReplicaBinding,
  counts: ReadonlyMap<string, number>,
  usedAt: string,
): Promise<void> {
  return withMemoryWriteLock(scopeDir, async () => {
    const outbox = await readOutbox(scopeDir, binding);
    const { usage } = outbox.file;
    for (const [fileKey, uses] of counts) {
      if (!isUsageFileKey(fileKey) || uses < 1) continue;
      const known = usage[fileKey];
      usage[fileKey] = {
        ...known,
        uses: (known?.uses ?? 0) + uses,
        lastUsedAt:
          known !== undefined && known.lastUsedAt > usedAt
            ? known.lastUsedAt
            : usedAt,
      };
    }
    await writeOutbox(scopeDir, outbox);
  });
}

function isUsageFileKey(fileKey: string): boolean {
  return (
    isMemoryDocumentPath(fileKey) ||
    MemoryNoteFileKeySchema.safeParse(fileKey).success
  );
}

export interface MemoryUsageDelta {
  fileKey: string;
  uses: number;
  lastUsedAt: string;
}

function withoutUsageSent(file: MemorySyncOutboxFile): MemorySyncOutboxFile {
  const next = { ...file };
  delete next.usageSent;
  return next;
}

/** One usage push, with the `seq` its answer settles. */
export interface MemoryUsagePush {
  readonly seq: number;
  readonly deltas: readonly MemoryUsageDelta[];
}

/**
 * The scope's next usage push, taken under the scope lock. One already sent
 * and not yet answered goes again as it was; otherwise up to
 * `usageDeltasMax` deltas move out of the counts into it, marked sent before
 * the caller sends them, and uses counted from then on wait for the next.
 * `maySend`, asked under the lock first, leaves every count unsent when it
 * answers false.
 */
export function takeMemoryUsagePush(
  scopeDir: string,
  binding: MemoryReplicaBinding,
  maySend?: () => Promise<boolean>,
): Promise<MemoryUsagePush | null> {
  return withMemoryWriteLock(scopeDir, async () => {
    const outbox = await readOutbox(scopeDir, binding);
    const inFlight = outbox.file.usageSent;
    if (inFlight !== undefined) {
      const deltas = inFlight.deltas.filter(({ fileKey }) =>
        isUsageFileKey(fileKey),
      );
      if (deltas.length > 0) {
        if (maySend !== undefined && !(await maySend())) return null;
        return { seq: inFlight.seq, deltas };
      }
    }
    const { usage } = outbox.file;
    const deltas: MemoryUsageDelta[] = [];
    for (const [fileKey, delta] of Object.entries(usage)) {
      if (!isUsageFileKey(fileKey)) {
        delete usage[fileKey];
        continue;
      }
      if (deltas.length >= MEMORY_SYNC_LIMITS.usageDeltasMax) break;
      const uses = Math.min(delta.uses, MEMORY_SYNC_LIMITS.usageDeltaUsesMax);
      deltas.push({ fileKey, uses, lastUsedAt: delta.lastUsedAt });
      if (delta.uses > uses)
        usage[fileKey] = { ...delta, uses: delta.uses - uses };
      else delete usage[fileKey];
    }
    const push = deltas.length > 0 ? { seq: outbox.nextSeq, deltas } : null;
    if (push !== null && maySend !== undefined && !(await maySend())) {
      return null;
    }
    if (push !== null) outbox.nextSeq += 1;
    if (push !== null || inFlight !== undefined) {
      const file = withoutUsageSent(outbox.file);
      await writeOutbox(scopeDir, {
        ...outbox,
        file: push === null ? file : { ...file, usageSent: push },
      });
    }
    return push;
  });
}

/**
 * Settles an answered usage push by its `seq`; uses counted while it was in
 * flight stay for the next one.
 */
export function settleMemoryUsagePush(
  scopeDir: string,
  binding: MemoryReplicaBinding,
  seq: number,
): Promise<void> {
  return withMemoryWriteLock(scopeDir, async () => {
    const outbox = await readOutbox(scopeDir, binding);
    if (outbox.file.usageSent?.seq !== seq) return;
    await writeOutbox(scopeDir, {
      ...outbox,
      file: withoutUsageSent(outbox.file),
    });
  });
}
