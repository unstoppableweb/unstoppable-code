import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import {
  INBOX_INPUT_BUDGET_BYTES,
  IMPORTS_INPUT_BUDGET_BYTES,
  MAX_INBOX_FILES_PER_RUN,
  TOPICS_INPUT_BUDGET_BYTES,
} from '@canopy/memory-consolidation/limits';
import {
  promptEntryCostBytes,
  promptEntryFitsBudget,
} from '@canopy/memory-consolidation/input-budget';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import type {
  ConsolidationInput,
  ConsolidationInputFile,
  ConsolidationOutput,
} from '@canopy/memory-consolidation/input';
import { memoryConsolidationInputHashParts } from '@canopy/memory-consolidation/input-hash';
import { isMemoryIndexWithinLimits } from '@canopy/memory-consolidation/memory-index';
import {
  scopeTopicInventory,
  type ScopeTopicInventory,
} from '@canopy/memory-consolidation/topic-identity';
import {
  MEMORY_INDEX_PATH,
  MEMORY_SYNC_LIMITS,
  MemoryNoteFileKeySchema,
  MemoryNoteSchema,
  encodeMemoryUlid,
  isMemoryDocumentPath,
  isMemoryNoteOriginBlocked,
  memoryDocumentIdentity,
  memoryDocumentRefusal,
  portableFileNameIdentity,
  type MemoryDeviceRef,
  type MemoryDocument,
  type MemoryDocumentChange,
  type MemoryNote,
  type MemoryNoteOp,
  type MemoryNoteRecord,
  type MemoryOriginPolicy,
} from '@canopy/protocol/memory-sync';
import {
  isMemoryMarkdownFileName,
  isNodeError,
  readMemoryFile,
} from '../local/memory-files';
import {
  memoryNoteId,
  withMemoryNoteScalarFields,
} from '../local/note-identity';
import { listPendingSources } from '../local/pending-sources';
import { inboxNoteToWire, renderPulledNote } from './note-records';
import { splitOnLinesWithinBudget } from './note-split';

/*
 * First enable of a scope that already holds memory on this device (design
 * §17). Nothing here writes: it reads this device's memory, turns it into the
 * notes the cloud is sent (inbox notes as they are, each document and staged
 * import as an import note), builds the merge consolidation's input over the
 * cloud documents, and says which documents a merge leaves. The engine sends
 * and commits; the review screen shows these results first.
 */

export interface MemoryMergeDocument {
  path: string;
  content: string;
}

interface SourceFile {
  fileKey: string;
  content: string;
  modifiedAt: string;
}

export interface MemoryFirstEnableSource {
  /** `MEMORY.md` and the topics. */
  documents: Array<MemoryMergeDocument & { modifiedAt: string }>;
  /** Pending inbox notes, oldest first. */
  notes: SourceFile[];
  /** Pending staged imports. */
  imports: SourceFile[];
  /**
   * Memory files this read carried nothing from, by file key: a document
   * with nothing in it, bytes that are not UTF-8 text, a name a directory
   * holds, a staged import no ledger entry describes. They stay on this
   * device untouched, out of the upload and the merge, and are reported as
   * skipped. The folder still holds them, so it is not an empty folder.
   */
  skipped: string[];
  /** Of {@link skipped}, those whose bytes are not UTF-8 text. */
  notText: string[];
  /** Changes whenever any of the above does. */
  fingerprint: string;
}

/**
 * A file first enable read: its text, or the marker that its bytes are not
 * UTF-8 text. A lossy decode would replace those bytes with U+FFFD, and the
 * replacement copy is what would go up and become the live replica content,
 * so the bytes themselves decide (see {@link readMemoryFile}).
 */
type ReadSourceFile =
  | { kind: 'file'; file: SourceFile }
  | { kind: 'not_text'; hash: string }
  | { kind: 'missing' };

async function readSourceFile(
  dir: string,
  fileKey: string,
): Promise<ReadSourceFile> {
  const path = join(dir, fileKey);
  const content = await readMemoryFile(path);
  if (content === null) return { kind: 'missing' };
  if (content.text === null) {
    return {
      kind: 'not_text',
      hash: createHash('sha256').update(content.bytes).digest('hex'),
    };
  }
  const info = await stat(path);
  return {
    kind: 'file',
    file: {
      fileKey,
      content: content.text,
      modifiedAt: info.mtime.toISOString(),
    },
  };
}

/** Topic markdown names in `dir`, and those a file does not hold. */
async function topicNames(
  dir: string,
): Promise<{ files: string[]; others: string[] }> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(dir, 'topics'), { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return { files: [], others: [] };
    }
    throw error;
  }
  const markdown = entries
    .filter((entry) => isMemoryMarkdownFileName(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    files: markdown.filter((entry) => entry.isFile()).map((e) => e.name),
    others: markdown.filter((entry) => !entry.isFile()).map((e) => e.name),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalized(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '');
}

/** This device's memory in `dir`, as first enable reads it. */
export async function readFirstEnableSource(
  dir: string,
): Promise<MemoryFirstEnableSource> {
  const documents: MemoryFirstEnableSource['documents'] = [];
  const notText: Array<[string, string]> = [];
  const skipped: string[] = [];
  const read = async (fileKey: string): Promise<SourceFile | null> => {
    const result = await readSourceFile(dir, fileKey);
    if (result.kind === 'not_text') {
      notText.push([fileKey, result.hash]);
      skipped.push(fileKey);
    }
    return result.kind === 'file' ? result.file : null;
  };
  const topics = await topicNames(dir);
  for (const name of topics.others) skipped.push(`topics/${name}`);
  const paths = [
    MEMORY_INDEX_PATH,
    ...topics.files.map((name) => `topics/${name}`),
  ];
  for (const path of paths) {
    const file = await read(path);
    if (file === null) continue;
    if (isMemoryDocumentPath(path) && file.content.trim().length > 0) {
      documents.push({
        path,
        content: normalized(file.content),
        modifiedAt: file.modifiedAt,
      });
    } else {
      skipped.push(path);
    }
  }
  const pending = await listPendingSources(dir);
  for (const name of pending.unusableImports) skipped.push(`imported/${name}`);
  const notes: SourceFile[] = [];
  for (const name of pending.inboxFiles) {
    const file = await read(`inbox/${name}`);
    if (file !== null) notes.push(file);
  }
  const imports: SourceFile[] = [];
  for (const entry of pending.imports) {
    const file = await read(entry.fileKey);
    if (file !== null) imports.push(file);
  }
  const fingerprint = sha256(
    JSON.stringify([
      documents.map((document) => [document.path, sha256(document.content)]),
      [...notes, ...imports].map((file) => [
        file.fileKey,
        sha256(file.content),
      ]),
      notText,
      [...skipped].sort(),
    ]),
  );
  return {
    documents,
    notes,
    imports,
    skipped,
    notText: notText.map(([fileKey]) => fileKey),
    fingerprint,
  };
}

/**
 * Whether the documents can go up as they are: a case-sensitive file system
 * can hold two spellings of one topic, which a commit cannot carry.
 */
export function hasDistinctDocumentIdentities(
  documents: readonly MemoryMergeDocument[],
): boolean {
  return (
    new Set(documents.map(({ path }) => memoryDocumentIdentity(path))).size ===
    documents.length
  );
}

/**
 * Whether the folder holds any memory, carried or not: the one notion of
 * "this folder is not empty" that both the folder-presence check and the
 * first-enable review read (see {@link scopeFolderHasMemory}). A folder
 * holding only skipped files still gets its review, which keeps the cloud as
 * it is and reports them; counting it empty in one place and not the other
 * refused that review on every attempt, so the folder could never register
 * or pull the cloud's memory.
 */
export function hasFirstEnableSource(source: MemoryFirstEnableSource): boolean {
  return (
    source.documents.length > 0 ||
    source.notes.length > 0 ||
    source.imports.length > 0 ||
    source.skipped.length > 0
  );
}

/** Whether a scope folder holds any memory, as a first enable reads it. */
export async function scopeFolderHasMemory(dir: string): Promise<boolean> {
  try {
    return hasFirstEnableSource(await readFirstEnableSource(dir));
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

/** A note ID that is the same for the same device, path and content. */
function stableNoteId(seed: string, atMs: number): string {
  const randomness = createHash('sha256')
    .update(seed, 'utf8')
    .digest()
    .subarray(0, 10);
  return encodeMemoryUlid(Math.max(0, Math.floor(atMs)), randomness);
}

function importFileKey(
  path: string,
  noteId: string,
  part: number | null,
): string {
  const stem = path
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const order = part === null ? '' : `-part-${String(part).padStart(2, '0')}`;
  return `imported/device-${stem || 'memory'}${order}-${noteId.slice(-6).toLowerCase()}.md`;
}

function importNote(
  device: MemoryDeviceRef,
  path: string,
  body: string,
  modifiedAt: string,
  part: number | null,
): MemoryNote | null {
  const contentHash = sha256(body);
  // The same document sent again (a retried first enable) is the same note.
  const noteId = stableNoteId(`${device.deviceId}\0${path}\0${contentHash}`, 0);
  const parsed = MemoryNoteSchema.safeParse({
    noteId,
    kind: 'import',
    fileKey: importFileKey(path, noteId, part),
    body,
    contentHash,
    createdAt: modifiedAt,
    modifiedAt,
    device,
    source: null,
    origin: { projectId: null, organizationId: null },
    importSource: {
      tool: 'canopy-device',
      originKey: sha256(
        `canopy-device\0${device.deviceId}\0${path}\0${contentHash}`,
      ),
      sourceFilename: basename(path).slice(0, 255),
      modifiedAt,
    },
  });
  return parsed.success ? parsed.data : null;
}

/**
 * What a queued import note will cost the consolidation input that reads
 * it, as the budget is measured: the serialized prompt entry. The first
 * enable's own merge reads the note as a plain entry under a file name it
 * may have lengthened to free it, and a later consolidation reads it again
 * as a staged import, whose entry also carries the import metadata, so the
 * larger of the two shapes is what has to fit.
 */
function importEntryCostBytes(body: string): number {
  const longest = 'n'.repeat(MEMORY_SYNC_LIMITS.fileNameMaxBytes);
  return promptEntryCostBytes({
    filename: longest,
    content: body,
    importMetadata: {
      sourceTool: 'claude-code',
      originalPath: longest,
      sourceFilename: longest,
      repo: longest,
      modified: new Date(0).toISOString(),
    },
  });
}

/** Ordered import notes one document is carried as, at the very most. */
const MAX_IMPORT_NOTES = 64;

/**
 * Room each part of a split document has for its own text: the budget less
 * the lead that names the part and the margin redacting a finished body
 * needs, since a cut can start a piece where a secret pattern begins.
 */
const SPLIT_RESEAL_MARGIN_BYTES = 256;

/**
 * The bodies that carry `content` as import notes: one, or ordered parts
 * each inside the consolidation input budget. Null when a part would still
 * not fit, which only one very long line can cause.
 *
 * A note the budget cannot hold could never be consumed: every input built
 * over it would leave it out, while first enable reported it as sent, and a
 * later consolidation reading it back as a staged import would hold every
 * later import behind it. Splitting it is what keeps that from happening,
 * and the content is redacted before it is split, as a conflict's side is:
 * a secret over several lines is found only whole.
 */
function importNoteBodies(path: string, content: string): string[] | null {
  const body = normalized(content);
  if (body.trim().length === 0) return null;
  if (importEntryCostBytes(body) <= IMPORTS_INPUT_BUDGET_BYTES) return [body];
  const text = redactMemoryContent(body);
  const lead = (index: number, count: number): string =>
    `Part ${index} of ${count} of ${path}.\n\n`;
  const overhead =
    importEntryCostBytes(lead(MAX_IMPORT_NOTES, MAX_IMPORT_NOTES)) +
    SPLIT_RESEAL_MARGIN_BYTES;
  // The prompt serializes each piece, and how much JSON escaping grows one
  // is the text's own: the room a piece gets is halved until every
  // finished body fits what it is measured against.
  for (
    let room = IMPORTS_INPUT_BUDGET_BYTES - overhead;
    room > 0;
    room = Math.floor(room / 2)
  ) {
    const pieces = splitOnLinesWithinBudget(text, room);
    if (pieces === null || pieces.length > MAX_IMPORT_NOTES) return null;
    const bodies = pieces.map((piece, index) =>
      redactMemoryContent(`${lead(index + 1, pieces.length)}${piece}`),
    );
    if (
      bodies.every(
        (part) => importEntryCostBytes(part) <= IMPORTS_INPUT_BUDGET_BYTES,
      )
    ) {
      return bodies;
    }
  }
  return null;
}

/**
 * Every import note `content` goes up as, and whether anything was left
 * behind: a document or staged import the budget cannot carry, even split,
 * stays on this device and is counted as skipped.
 */
function importNotes(
  device: MemoryDeviceRef,
  path: string,
  content: string,
  modifiedAt: string,
): { notes: MemoryNote[]; skipped: number } {
  const bodies = importNoteBodies(path, content);
  if (bodies === null) return { notes: [], skipped: 1 };
  const notes: MemoryNote[] = [];
  let skipped = 0;
  for (const [index, body] of bodies.entries()) {
    const note = importNote(
      device,
      path,
      body,
      modifiedAt,
      bodies.length === 1 ? null : index + 1,
    );
    if (note === null) skipped += 1;
    else notes.push(note);
  }
  return { notes, skipped };
}

type NotePut = Extract<MemoryNoteOp, { op: 'put' }>;

/** An inbox note of this device as it goes into the replica and the cloud. */
export interface MemoryFirstEnableInboxNote {
  /** The note file, with an ID minted from its content if it had none. */
  readonly content: string;
  readonly op: NotePut;
}

function inboxNote(
  device: MemoryDeviceRef,
  file: SourceFile,
): MemoryFirstEnableInboxNote | null {
  const content =
    memoryNoteId(file.content) === null
      ? withMemoryNoteScalarFields(file.content, {
          id: stableNoteId(
            `${device.deviceId}\0${file.fileKey}\0${sha256(file.content)}`,
            Date.parse(file.modifiedAt),
          ),
        })
      : file.content;
  const note = inboxNoteToWire({
    fileKey: file.fileKey,
    content,
    modifiedMs: Date.parse(file.modifiedAt),
    thisDevice: device,
  });
  return note === null ? null : { content, op: { op: 'put', note } };
}

export interface MemoryFirstEnableNotes {
  /** This device's inbox notes, written into the replica and queued. */
  inbox: MemoryFirstEnableInboxNote[];
  /** Every document and staged import, as an import note. */
  imports: NotePut[];
  /** Memory this device cannot send (too large, unreadable front matter). */
  skipped: number;
  /** Memory whose bytes are not UTF-8 text, part of {@link skipped}. */
  notText: number;
}

/**
 * The notes first enable sends: inbox notes as they are, and every document
 * and staged import as an import note.
 */
export function firstEnableNotes(
  source: MemoryFirstEnableSource,
  device: MemoryDeviceRef,
): MemoryFirstEnableNotes {
  const inbox: MemoryFirstEnableInboxNote[] = [];
  const imports: NotePut[] = [];
  let skipped = source.skipped.length;
  for (const file of source.notes) {
    const note = inboxNote(device, file);
    if (note === null) skipped += 1;
    else inbox.push(note);
  }
  for (const file of [
    ...source.documents.map((document) => ({
      fileKey: document.path,
      content: document.content,
      modifiedAt: document.modifiedAt,
    })),
    ...source.imports,
  ]) {
    const carried = importNotes(
      device,
      file.fileKey,
      file.content,
      file.modifiedAt,
    );
    skipped += carried.skipped;
    for (const note of carried.notes) imports.push({ op: 'put', note });
  }
  return { inbox, imports, skipped, notText: source.notText.length };
}

export interface MemoryFirstEnableUpload {
  /** The documents the commit carries, as they are. */
  documents: MemoryMergeDocument[];
  /** Ordered import notes for the documents it cannot carry. */
  notes: NotePut[];
  /** Documents too large for a commit, carried as {@link notes}. */
  asNotes: number;
  /** Documents no budget could carry at all, left on this device. */
  skipped: number;
}

/**
 * This device's memory as an upload to an empty cloud scope carries it: the
 * documents a commit can hold, and import notes for those it cannot.
 *
 * A document the contract refuses -- one past `documentMaxBytes`, or with
 * content or a name no document has -- would make the whole commit refused,
 * and it cannot be left where it is either: once the replica is bound, the
 * folder the review read stops being this computer's memory, so a document
 * left out of the upload would be stranded there. Its content goes up as
 * ordered import notes instead, as a merge carries every document of this
 * computer (design §17), and the next consolidation folds it in. Only a
 * document no budget can carry even split stays behind, and the review
 * reports it.
 */
export function firstEnableUpload(
  source: MemoryFirstEnableSource,
  device: MemoryDeviceRef,
): MemoryFirstEnableUpload {
  const upload: MemoryFirstEnableUpload = {
    documents: [],
    notes: [],
    asNotes: 0,
    skipped: 0,
  };
  for (const { path, content, modifiedAt } of source.documents) {
    if (memoryDocumentRefusal(path, content) === null) {
      upload.documents.push({ path, content });
      continue;
    }
    const carried = importNotes(device, path, content, modifiedAt);
    upload.skipped += carried.skipped;
    if (carried.notes.length > 0) upload.asNotes += 1;
    for (const note of carried.notes) upload.notes.push({ op: 'put', note });
  }
  return upload;
}

/**
 * What a first enable's review showed, by name and content hash, so what
 * was saved after it can be told apart even after a restart: the reviewed
 * documents and staged imports by path and hash, and the inbox notes by ID.
 */
export const MemoryFirstEnableReviewSchema = z.object({
  documents: z.array(z.tuple([z.string().max(512), z.string().length(64)])),
  noteIds: z.array(z.string().max(64)),
  imports: z.array(z.tuple([z.string().max(512), z.string().length(64)])),
});
export type MemoryFirstEnableReview = z.output<
  typeof MemoryFirstEnableReviewSchema
>;

export function firstEnableReview(
  source: MemoryFirstEnableSource,
  device: MemoryDeviceRef,
): MemoryFirstEnableReview {
  return {
    documents: source.documents.map(({ path, content }) => [
      path,
      sha256(content),
    ]),
    noteIds: firstEnableNotes(source, device).inbox.map(
      ({ op }) => op.note.noteId,
    ),
    imports: source.imports.map(({ fileKey, content }) => [
      fileKey,
      sha256(content),
    ]),
  };
}

/**
 * Memory saved where a first enable reads after its review, as the notes
 * that carry it into the replica: a new inbox note as itself, a new or
 * changed document as an import note and, unless the review uploaded this
 * device's memory as it is, a newly staged import as one. Edits of reviewed
 * notes and deletions are not carried.
 */
export function lateFirstEnableNotes(
  reviewed: MemoryFirstEnableReview,
  current: MemoryFirstEnableSource,
  device: MemoryDeviceRef,
  kind: 'upload' | 'merge' | 'keep',
): Pick<MemoryFirstEnableNotes, 'inbox' | 'imports'> {
  const known = new Set(reviewed.noteIds);
  const same = (path: string, hash: string): string => `${path}\0${hash}`;
  const reviewedDocuments = new Set(
    reviewed.documents.map(([path, hash]) => same(path, hash)),
  );
  const reviewedImports = new Set(
    reviewed.imports.map(([fileKey, hash]) => same(fileKey, hash)),
  );
  const late = firstEnableNotes(
    {
      documents: current.documents.filter(
        ({ path, content }) =>
          !reviewedDocuments.has(same(path, sha256(content))),
      ),
      notes: current.notes,
      imports:
        kind === 'upload'
          ? []
          : current.imports.filter(
              ({ fileKey, content }) =>
                !reviewedImports.has(same(fileKey, sha256(content))),
            ),
      // Carried memory only: the count this discards is the review's.
      skipped: [],
      notText: [],
      fingerprint: current.fingerprint,
    },
    device,
  );
  return {
    inbox: late.inbox.filter(({ op }) => !known.has(op.note.noteId)),
    imports: late.imports,
  };
}

/**
 * Whether an organization keeps a note off the cloud (design §10.4): such a
 * note stays on this device and out of a first-enable merge.
 */
export function isFirstEnableNoteHeldBack(
  op: MemoryNoteOp,
  origins: MemoryOriginPolicy,
): boolean {
  return (
    op.op !== 'tombstone' &&
    isMemoryNoteOriginBlocked(origins, op.note.origin.organizationId)
  );
}

function inputFile(
  fileKey: string,
  content: string,
  modifiedAt: string,
): ConsolidationInputFile {
  return {
    fileKey,
    filename: basename(fileKey),
    content,
    modifiedAt,
    usage: { usageCount: 0, lastUsedAt: null, createdAt: modifiedAt },
  };
}

/**
 * Files oldest first, as many as fit `budgetBytes` and `maxFiles`. Stopping
 * at the first file that does not fit the room left keeps the order, since
 * that file leads the next run. A file no empty budget could hold leads
 * nothing: it is passed over, so the ones behind it are still read (see
 * {@link promptEntryFitsBudget}).
 */
function withinBudget(
  files: readonly ConsolidationInputFile[],
  budgetBytes: number,
  maxFiles = Number.POSITIVE_INFINITY,
): ConsolidationInputFile[] {
  const selected: ConsolidationInputFile[] = [];
  let used = 0;
  for (const file of files) {
    if (selected.length >= maxFiles) break;
    const cost = promptEntryCostBytes(file);
    if (!promptEntryFitsBudget(file, budgetBytes)) continue;
    if (used + cost > budgetBytes) break;
    selected.push(file);
    used += cost;
  }
  return selected;
}

/**
 * Another name for a note whose file key another note holds: the stem with
 * the end of the note's ID, then a counter. Stays a valid file key.
 */
export function noteFileKeyVariant(
  fileKey: string,
  noteId: string,
  attempt: number,
): string {
  const folder = fileKey.slice(0, fileKey.indexOf('/') + 1);
  const stem = fileKey.slice(folder.length, -'.md'.length);
  const suffix = `-${noteId.slice(-10).toLowerCase()}${attempt > 0 ? `-${attempt + 1}` : ''}`;
  const room = MEMORY_SYNC_LIMITS.fileNameMaxBytes - suffix.length - 3;
  const candidate = `${folder}${stem.slice(0, room)}${suffix}.md`;
  return MemoryNoteFileKeySchema.safeParse(candidate).success
    ? candidate
    : `${folder}note${suffix}.md`;
}

/** The first of `fileKey` and its variants whose name `taken` lacks. */
export function freeNoteFileKey(
  fileKey: string,
  noteId: string,
  taken: ReadonlySet<string>,
): string {
  let candidate = fileKey;
  for (
    let attempt = 0;
    taken.has(portableFileNameIdentity(candidate));
    attempt += 1
  ) {
    candidate = noteFileKeyVariant(fileKey, noteId, attempt);
  }
  return candidate;
}

async function noteIdsIn(
  folder: string,
  onName?: (name: string) => void,
): Promise<Set<string>> {
  const noteIds = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return noteIds;
    }
    throw error;
  }
  for (const name of entries) {
    onName?.(name);
    if (!isMemoryMarkdownFileName(name)) continue;
    const content = await readMemoryFile(join(folder, name));
    // Bytes that are not UTF-8 hold no note: a lossy decode could read an
    // ID out of a file sync can never carry.
    const noteId =
      content === null || content.text === null
        ? null
        : memoryNoteId(content.text);
    if (noteId !== null) noteIds.add(noteId);
  }
  return noteIds;
}

/** The inbox notes in a replica: who holds which name, by note ID. */
export async function readReplicaInboxNotes(dir: string): Promise<{
  /** Every inbox file name's identity, note or not. */
  names: Set<string>;
  /** Pending notes and those a consolidation consumed (`.consolidated/`). */
  noteIds: Set<string>;
  /** Notes a consolidation consumed. */
  consumedNoteIds: Set<string>;
}> {
  const names = new Set<string>();
  const pending = await noteIdsIn(join(dir, 'inbox'), (name) =>
    names.add(portableFileNameIdentity(`inbox/${name}`)),
  );
  const consumedNoteIds = await noteIdsIn(join(dir, 'inbox', '.consolidated'));
  return {
    names,
    noteIds: new Set([...pending, ...consumedNoteIds]),
    consumedNoteIds,
  };
}

function noteFile(
  note: MemoryNote | MemoryNoteRecord,
  fileKey: string,
): ConsolidationInputFile {
  return inputFile(fileKey, renderPulledNote(note), note.modifiedAt);
}

export interface MemoryMergeInput {
  input: ConsolidationInput;
  /**
   * Every topic the cloud scope holds, which the input's own topics are only
   * the part of that fit the prompt. The merge's write policy and its index
   * links read this, so a topic the budget left out is never replaced and
   * never unlinked.
   */
  scopeTopics: ScopeTopicInventory;
  /** Note ID of every inbox and import file in the input, by its key there. */
  noteIds: ReadonlyMap<string, string>;
  /**
   * Every note in the input with the organization it came from: a merge may
   * carry any of them into a document, consumed or not.
   */
  inputs: ReadonlyArray<{ noteId: string; organizationId: string | null }>;
}

/**
 * The merge consolidation's input (design §17): the cloud's index and topics,
 * and as pending sources the cloud's pending notes plus everything this
 * device sends, within today's budgets. Usage is unknown, so nothing prunes.
 * A note whose organization keeps it off the cloud is left out, wherever it
 * comes from: the cloud still lists one the sweep has not withheld yet.
 */
export function firstEnableMergeInput(
  cloud: {
    documents: readonly MemoryDocument[];
    pendingNotes: readonly MemoryNoteRecord[];
  },
  ops: readonly MemoryNoteOp[],
  now: string,
  origins: MemoryOriginPolicy,
): MemoryMergeInput {
  // One entry per note, the cloud's copy first; a note this device sent
  // before is the same note. Two notes with one name each keep their own.
  const byId = new Map<string, MemoryNote | MemoryNoteRecord>();
  for (const note of cloud.pendingNotes) {
    if (!isMemoryNoteOriginBlocked(origins, note.origin.organizationId)) {
      byId.set(note.noteId, note);
    }
  }
  for (const op of ops) {
    if (
      op.op !== 'tombstone' &&
      !byId.has(op.note.noteId) &&
      !isFirstEnableNoteHeldBack(op, origins)
    ) {
      byId.set(op.note.noteId, op.note);
    }
  }
  const noteIds = new Map<string, string>();
  const originOf = new Map<string, string | null>();
  const taken = new Set<string>();
  const inbox: ConsolidationInputFile[] = [];
  const imports: ConsolidationInputFile[] = [];
  for (const note of [...byId.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    const key = freeNoteFileKey(note.fileKey, note.noteId, taken);
    taken.add(portableFileNameIdentity(key));
    noteIds.set(key, note.noteId);
    originOf.set(note.noteId, note.origin.organizationId);
    (note.kind === 'import' ? imports : inbox).push(noteFile(note, key));
  }
  const index = cloud.documents.find(
    (document) => document.path === MEMORY_INDEX_PATH,
  );
  const memoryMd = index?.content ?? '';
  const topics = cloud.documents
    .filter((document) => document.path !== MEMORY_INDEX_PATH)
    .map((document) => inputFile(document.path, document.content, now));
  const topicFiles = withinBudget(topics, TOPICS_INPUT_BUDGET_BYTES);
  const inboxFiles = withinBudget(
    inbox,
    INBOX_INPUT_BUDGET_BYTES,
    MAX_INBOX_FILES_PER_RUN,
  );
  const importFiles = withinBudget(imports, IMPORTS_INPUT_BUDGET_BYTES);
  const selected = new Set(
    [...inboxFiles, ...importFiles].map((file) => file.fileKey),
  );
  for (const fileKey of [...noteIds.keys()]) {
    if (!selected.has(fileKey)) noteIds.delete(fileKey);
  }
  const inputHash = createHash('sha256')
    .update(
      memoryConsolidationInputHashParts({
        memoryMd,
        files: [...topicFiles, ...inboxFiles, ...importFiles],
        imports: [],
      }).join(''),
      'utf8',
    )
    .digest('hex');
  const selectedTopics = new Set(topicFiles.map((file) => file.fileKey));
  const omittedTopics = topics.filter(
    (file) => !selectedTopics.has(file.fileKey),
  );
  return {
    input: {
      memoryMd,
      topicFiles,
      inboxFiles,
      importFiles,
      omittedTopicFiles: {
        fileCount: omittedTopics.length,
        totalBytes: omittedTopics.reduce(
          (total, file) => total + promptEntryCostBytes(file),
          0,
        ),
      },
      inputHash,
      indexWithinLimits: isMemoryIndexWithinLimits(memoryMd),
      usageTrackingSince: null,
    },
    scopeTopics: scopeTopicInventory(
      topics.map((file) => basename(file.fileKey)),
    ),
    noteIds,
    inputs: [...noteIds.values()].map((noteId) => ({
      noteId,
      organizationId: originOf.get(noteId) ?? null,
    })),
  };
}

/** The documents a merge leaves: the cloud's, with the output's replacing. */
export function mergedDocuments(
  cloud: readonly MemoryMergeDocument[],
  output: ConsolidationOutput,
): MemoryMergeDocument[] {
  const byIdentity = new Map<string, MemoryMergeDocument>();
  for (const document of cloud) {
    byIdentity.set(memoryDocumentIdentity(document.path), document);
  }
  byIdentity.set(MEMORY_INDEX_PATH, {
    path: MEMORY_INDEX_PATH,
    content: output.memoryMd,
  });
  for (const topic of output.topicFiles ?? []) {
    const path = `topics/${topic.filename}`;
    if (!isMemoryDocumentPath(path)) continue;
    byIdentity.set(memoryDocumentIdentity(path), {
      path,
      content: topic.content,
    });
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.path === MEMORY_INDEX_PATH
      ? -1
      : right.path === MEMORY_INDEX_PATH
        ? 1
        : left.path.localeCompare(right.path),
  );
}

/** The commit that turns `before` into `after`. */
export function documentChanges(
  before: readonly MemoryMergeDocument[],
  after: readonly MemoryMergeDocument[],
): MemoryDocumentChange[] {
  const prior = new Map(
    before.map((document) => [memoryDocumentIdentity(document.path), document]),
  );
  const changes: MemoryDocumentChange[] = [];
  const kept = new Set<string>();
  for (const document of after) {
    const identity = memoryDocumentIdentity(document.path);
    kept.add(identity);
    const previous = prior.get(identity);
    if (
      previous?.content !== document.content ||
      previous.path !== document.path
    ) {
      changes.push({
        op: 'put',
        path: document.path,
        content: document.content,
        contentHash: sha256(document.content),
      });
    }
  }
  for (const [identity, document] of prior) {
    if (!kept.has(identity))
      changes.push({ op: 'delete', path: document.path });
  }
  return changes;
}
