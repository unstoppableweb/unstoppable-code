import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { normalizeMemoryDocumentContent } from '@canopy/memory-consolidation/document-merge';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import {
  MEMORY_SYNC_LIMITS,
  MemoryNoteSchema,
  encodeMemoryUlid,
  portableFileNameIdentity,
  type MemoryDeviceRef,
  type MemoryNote,
  type MemorySyncStateFile,
} from '@canopy/protocol/memory-sync';
import {
  ensureOwnerOnlyMemoryDir,
  readMemoryFile,
  writeNewMemoryFile,
} from '../local/memory-files';
import { freeNoteFileKey, readReplicaInboxNotes } from './first-enable';
import { splitWithinBudget } from './note-split';
import { renderPulledNote } from './note-records';
import { queueMemoryNoteOp, readQueuedMemoryNoteOps } from './outbox';
import {
  readMemorySyncState,
  writeMemorySyncState,
  type MemoryReplicaBinding,
} from './replica-files';

/*
 * Conflicts resolve themselves (design §13.2). The cloud's version stays
 * live and this device's side is kept under `.sync/conflicts/` and recorded
 * first, as the replica writer does; then the side goes to the cloud as
 * inbox notes, so the next consolidation folds it into the document. The
 * notes are a journal step of the conflict: their IDs follow from the entry
 * and are recorded on it before any is queued, a note already queued, on
 * disk or kept local-only is never queued again, and the entry is marked
 * once all are. Replaying a pass, or meeting an entry an earlier build wrote
 * without notes, finishes the step.
 */

type ConflictEntry = MemorySyncStateFile['conflicts'][number];

/**
 * The largest note body a conflict queues. Sync takes notes up to
 * `noteBodyMaxBytes`, but consolidation reads the inbox oldest first within
 * a 192 KiB prompt budget and stops at the first note over it, so a larger
 * note would hold every later note back. A body this size stays inside the
 * budget even when the prompt's JSON escaping doubles it.
 */
export const CONFLICT_NOTE_BODY_MAX_BYTES = Math.min(
  MEMORY_SYNC_LIMITS.noteBodyMaxBytes,
  48 * 1024,
);
/** A side larger than one synced note is carried as its differing lines. */
const CONFLICT_HUNK_OVER_BYTES = MEMORY_SYNC_LIMITS.noteBodyMaxBytes;
const CONTEXT_LINES = 3;
const MAX_CONFLICT_NOTES = 64;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The lines where `ours` differs from `current`, as one unified hunk with
 * a little context. Found by trimming the common head and tail, so it stays
 * linear on documents a three-way merge found too costly.
 */
export function conflictEditHunk(current: string, ours: string): string {
  const before = current.split('\n');
  const after = ours.split('\n');
  let head = 0;
  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const from = Math.max(0, head - CONTEXT_LINES);
  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  const leading = before.slice(from, head);
  const trailing = before.slice(
    before.length - tail,
    Math.min(before.length, before.length - tail + CONTEXT_LINES),
  );
  const oldCount = leading.length + removed.length + trailing.length;
  const newCount = leading.length + added.length + trailing.length;
  return [
    `@@ -${from + 1},${oldCount} +${from + 1},${newCount} @@`,
    ...leading.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...trailing.map((line) => ` ${line}`),
  ].join('\n');
}

/**
 * Room left in a split note for the redaction of each finished body to
 * grow it: a cut can start a piece where a secret pattern begins.
 */
const RESEAL_MARGIN_BYTES = 256;

/**
 * A version of a document a conflict names. `not_text` is bytes that are not
 * UTF-8 text: a lossy decode would carry its U+FFFD replacement into a note
 * and up to the cloud, so nothing carries its content at all.
 */
export type MemoryConflictSide =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'not_text' };

/**
 * The note bodies that carry this device's side of a conflict on `path`. A
 * side up to one synced note's size goes whole, and a larger one as the
 * lines that differ from the version in use; either is split into ordered
 * notes when it does not fit one. Both versions are redacted whole, as
 * every saved note is, before anything is measured, compared or split: a
 * secret over several lines, such as a private key, is found only whole,
 * and a split piece holds only redacted text. Each body is redacted once
 * more as it is finished.
 */
export function conflictNoteBodies(input: {
  path: string;
  deviceLabel: string;
  ours: MemoryConflictSide;
  current: MemoryConflictSide;
}): string[] {
  const { path, deviceLabel } = input;
  if (input.ours.kind === 'deleted') {
    return [
      redactMemoryContent(
        `Deletion of ${path} made on ${deviceLabel} that conflicted with a newer version. The newer version was kept; remove the topic if it is no longer needed.`,
      ),
    ];
  }
  if (input.ours.kind === 'not_text') {
    return [
      redactMemoryContent(
        `Edit to ${path} made on ${deviceLabel} that conflicted with a newer version. The newer version was kept. The edit is not plain text, so it stays on ${deviceLabel} only; save it as UTF-8 text to sync it.`,
      ),
    ];
  }
  const ours = redactMemoryContent(
    normalizeMemoryDocumentContent(input.ours.text),
  );
  const current =
    input.current.kind === 'text'
      ? redactMemoryContent(normalizeMemoryDocumentContent(input.current.text))
      : null;
  const lead = redactMemoryContent(
    input.current.kind === 'deleted'
      ? `Edit to ${path} made on ${deviceLabel} after another computer deleted it. The deletion was kept.`
      : `Edit to ${path} made on ${deviceLabel} that conflicted with a newer version.`,
  );
  const whole = `${lead}\n\n${ours}`;
  if (utf8Bytes(whole) <= CONFLICT_NOTE_BODY_MAX_BYTES) {
    return [redactMemoryContent(whole)];
  }
  const detail =
    current === null || utf8Bytes(ours) <= CONFLICT_HUNK_OVER_BYTES
      ? { lead, text: ours }
      : {
          lead: `${lead} It is too large for one note, so these are the lines where it differs from the version in use.`,
          text: conflictEditHunk(current, ours),
        };
  const single = `${detail.lead}\n\n${detail.text}`;
  if (utf8Bytes(single) <= CONFLICT_NOTE_BODY_MAX_BYTES) {
    return [redactMemoryContent(single)];
  }
  const label = (index: number, count: number): string =>
    `${detail.lead} Part ${index} of ${count}.\n\n`;
  const room =
    CONFLICT_NOTE_BODY_MAX_BYTES -
    utf8Bytes(label(MAX_CONFLICT_NOTES, 99)) -
    RESEAL_MARGIN_BYTES;
  const pieces = splitWithinBudget(detail.text, room).slice(
    0,
    MAX_CONFLICT_NOTES,
  );
  return pieces.map((piece, index) =>
    redactMemoryContent(`${label(index + 1, pieces.length)}${piece}`),
  );
}

/** The ID of note `index` of `entry`: the same on every replay. */
export function conflictNoteId(entry: ConflictEntry, index: number): string {
  const seed = createHash('sha256')
    .update(`${entry.path}\0${entry.oursFile}\0${index}`, 'utf8')
    .digest()
    .subarray(0, 10);
  return encodeMemoryUlid(Math.max(0, Date.parse(entry.detectedAt)), seed);
}

/** The file at `path` as a conflict side, by its bytes. */
export async function readMemoryConflictSide(
  path: string,
): Promise<MemoryConflictSide> {
  const content = await readMemoryFile(path);
  if (content === null) return { kind: 'deleted' };
  if (content.text === null) return { kind: 'not_text' };
  return { kind: 'text', text: content.text };
}

function noteFileKey(
  entry: ConflictEntry,
  index: number,
  count: number,
): string {
  const stamp = entry.detectedAt.slice(0, 19).replace(/:/g, '-');
  const stem = entry.path
    .replace(/^topics\//, '')
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const part = count > 1 ? `-part-${index + 1}` : '';
  return `inbox/${stamp}-merged-${stem || 'memory'}${part}.md`;
}

/**
 * Queues the notes of every conflict whose notes are not all queued yet; the
 * caller holds the scope's write lock. Resolves how many notes it queued. An
 * entry whose kept copy is gone is left as it is.
 */
export async function queueConflictNotes(
  scopeDir: string,
  binding: MemoryReplicaBinding,
  device: MemoryDeviceRef,
  now: Date,
): Promise<number> {
  const state = await readMemorySyncState(scopeDir);
  if (
    state === undefined ||
    state === null ||
    state.binding.scopeId !== binding.scopeId ||
    !state.conflicts.some((entry) => entry.autoNotesQueued !== true)
  ) {
    return 0;
  }
  let queued = 0;
  for (let index = 0; index < state.conflicts.length; index += 1) {
    const entry = state.conflicts[index];
    if (entry === undefined || entry.autoNotesQueued === true) continue;
    const ours: MemoryConflictSide =
      entry.oursDeleted === true
        ? { kind: 'deleted' }
        : await readMemoryConflictSide(join(scopeDir, entry.oursFile));
    // The kept copy is gone: the entry is left as it is.
    if (entry.oursDeleted !== true && ours.kind === 'deleted') continue;
    const bodies = conflictNoteBodies({
      path: entry.path,
      deviceLabel: device.label,
      ours,
      current: await readMemoryConflictSide(join(scopeDir, entry.path)),
    });
    const ids = bodies.map(
      (_body, part) => entry.autoNoteIds?.[part] ?? conflictNoteId(entry, part),
    );
    const recorded = { ...entry, autoNoteIds: ids };
    state.conflicts[index] = recorded;
    await writeMemorySyncState(scopeDir, state);
    const outbox = new Set(
      (await readQueuedMemoryNoteOps(scopeDir, binding)).map(({ op }) =>
        op.op === 'tombstone' ? op.noteId : op.note.noteId,
      ),
    );
    const disk = await readReplicaInboxNotes(scopeDir);
    const settled = new Set([
      ...outbox,
      ...disk.noteIds,
      ...state.localOnlyNoteIds,
    ]);
    for (const [part, body] of bodies.entries()) {
      const noteId = ids[part];
      if (noteId === undefined || settled.has(noteId)) continue;
      const fileKey = freeNoteFileKey(
        noteFileKey(entry, part, bodies.length),
        noteId,
        disk.names,
      );
      const parsed = MemoryNoteSchema.safeParse({
        noteId,
        kind: 'inbox',
        fileKey,
        body,
        contentHash: sha256(body),
        createdAt: entry.detectedAt,
        modifiedAt: entry.detectedAt,
        device,
        source: null,
        origin: { projectId: null, organizationId: null },
      });
      if (!parsed.success) continue;
      const note: MemoryNote = parsed.data;
      await queueMemoryNoteOp(
        scopeDir,
        binding,
        { op: 'put', note },
        now,
        null,
      );
      await ensureOwnerOnlyMemoryDir(scopeDir, join(scopeDir, 'inbox'));
      await writeNewMemoryFile(
        scopeDir,
        join(scopeDir, fileKey),
        renderPulledNote(note),
      );
      disk.names.add(portableFileNameIdentity(fileKey));
      settled.add(noteId);
      queued += 1;
    }
    state.conflicts[index] = { ...recorded, autoNotesQueued: true };
    await writeMemorySyncState(scopeDir, state);
  }
  return queued;
}
