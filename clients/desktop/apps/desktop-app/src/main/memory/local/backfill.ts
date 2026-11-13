import type { Stats } from 'node:fs';
import { lstat, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isMemoryNoteFileKey,
  memoryUlidTime,
} from '@canopy/protocol/memory-sync';
import { inspectImportState, writeImportState } from './import/ledger';
import {
  assertMemoryPathContained,
  assertMemoryScopeLockHeld,
  isMemoryMarkdownFileName,
  isMemoryPathContained,
  isNodeError,
  MemoryPathNotContainedError,
  moveWithoutReplacing,
  writeMemoryFileAtomically,
  type MemoryFileTimes,
} from './memory-files';
import {
  memoryNoteCreatedMs,
  memoryNoteFileName,
  memoryNoteId,
  memoryNoteIdAt,
  withMemoryNoteId,
} from './note-identity';

/*
 * Gives a scope written before notes had identities its version 2 shape:
 * every inbox note (pending or archived) gets an `id` whose time part is its
 * `created`, pending notes whose names a replica could not carry are renamed,
 * and staged imports get a `noteId` in the import ledger. Callers hold the
 * scope lock. Each step is atomic and skips work already done, so running it
 * again, or after a crash part way, finishes the same job without minting a
 * second ID for any note or leaving a note under two names: notes to rename
 * go first, so a move a crash cut short is finished before its destination
 * is looked at as a note of its own. A note folder that is a link, or under
 * one, is not part of the scope: it is skipped, never followed, and nothing
 * is read or written through it.
 */

const NOTE_FOLDERS = [
  { path: 'inbox', key: 'inbox', renames: true },
  {
    path: join('inbox', '.consolidated'),
    key: 'inbox/.consolidated',
    renames: false,
  },
] as const;
const MAX_RENAME_ATTEMPTS = 100;

export interface MemoryScopeBackfillResult {
  /** False when a note or the import ledger has to be tried again. */
  complete: boolean;
  notesIdentified: number;
  notesRenamed: number;
  importsIdentified: number;
}

async function listNoteFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
}

type TakenName =
  /** The note itself, or the bytes of its own earlier move: drop the source. */
  | 'source-moved'
  /** A copy of the note cut short or older than the source: replace it. */
  | 'replace-with-source'
  | 'another-note';

/**
 * What a destination name that is taken holds, against the note `noteId`
 * being moved there from `source`. Its own earlier move left the same file
 * or the same bytes when only the source's removal was cut short, and a
 * leading part of the bytes when a copy was. A file under the note's ID with
 * other bytes is a copy that diverged after such a crash: the more recently
 * modified one is kept.
 */
async function classifyTakenName(
  source: string,
  target: string,
  noteId: string,
): Promise<TakenName> {
  const [sourceInfo, targetInfo] = await Promise.all([
    lstat(source, { bigint: true }),
    lstat(target, { bigint: true }),
  ]);
  if (!sourceInfo.isFile() || !targetInfo.isFile()) return 'another-note';
  if (sourceInfo.dev === targetInfo.dev && sourceInfo.ino === targetInfo.ino) {
    return 'source-moved';
  }
  const [sourceBytes, targetBytes] = await Promise.all([
    readFile(source),
    readFile(target),
  ]);
  if (targetBytes.equals(sourceBytes)) return 'source-moved';
  if (
    targetBytes.length < sourceBytes.length &&
    sourceBytes.subarray(0, targetBytes.length).equals(targetBytes)
  ) {
    return 'replace-with-source';
  }
  if (memoryNoteId(targetBytes.toString('utf8')) !== noteId) {
    return 'another-note';
  }
  return sourceInfo.mtimeNs >= targetInfo.mtimeNs
    ? 'replace-with-source'
    : 'source-moved';
}

/**
 * Moves a note to `name` (or `name` with `-2`, `-3`… when a different note
 * holds it). A destination already holding this note, as a crash part way
 * through an earlier move leaves it, is repaired and the old name dropped,
 * so the note ends up in exactly one file.
 */
async function renameNote(
  scopeDir: string,
  directory: string,
  from: string,
  name: string,
  noteId: string,
  times: MemoryFileTimes,
): Promise<void> {
  const source = join(directory, from);
  const stem = name.slice(0, -'.md'.length);
  for (let attempt = 1; attempt <= MAX_RENAME_ATTEMPTS; attempt += 1) {
    const target = join(
      directory,
      attempt === 1 ? name : `${stem}-${attempt}.md`,
    );
    try {
      await moveWithoutReplacing(scopeDir, source, target, { times });
      return;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    const taken = await classifyTakenName(source, target, noteId);
    if (taken === 'another-note') continue;
    if (taken === 'replace-with-source') {
      await writeMemoryFileAtomically(
        scopeDir,
        target,
        await readFile(source),
        times,
      );
    }
    await assertMemoryPathContained(scopeDir, source);
    await assertMemoryScopeLockHeld();
    await unlink(source);
    return;
  }
  throw new Error(`No free name for memory note ${from}`);
}

/** Whether a pending note's name is one a replica could not carry. */
function needsRename(name: string, renames: boolean): boolean {
  return renames && !isMemoryNoteFileKey(`inbox/${name}`, 'inbox');
}

interface NoteOutcome {
  identified: boolean;
  renamed: boolean;
}

const UNCHANGED: NoteOutcome = { identified: false, renamed: false };

/** The note's text, or null when it is not a file or not UTF-8 throughout. */
async function readNote(
  path: string,
): Promise<{ content: string; info: Stats } | null> {
  const info = await lstat(path);
  if (!info.isFile()) return null;
  const bytes = await readFile(path);
  const content = bytes.toString('utf8');
  // Rewriting text that did not decode would replace the bytes it lost.
  return Buffer.from(content, 'utf8').equals(bytes) ? { content, info } : null;
}

async function backfillNote(
  scopeDir: string,
  directory: string,
  name: string,
  renames: boolean,
): Promise<NoteOutcome> {
  const path = join(directory, name);
  await assertMemoryPathContained(scopeDir, directory);
  const note = await readNote(path);
  if (note === null) return UNCHANGED;
  const { content, info } = note;
  const times = { atime: info.atime, mtime: info.mtime };
  let noteId = memoryNoteId(content);
  // An ID's time part is the note's `created`: it names the note the same
  // way however its modification time changes before a retry.
  const createdMs =
    memoryNoteCreatedMs(content) ??
    (noteId === null ? null : memoryUlidTime(noteId)) ??
    info.mtimeMs;
  const identified = noteId === null;
  if (noteId === null) {
    noteId = memoryNoteIdAt(createdMs);
    await writeMemoryFileAtomically(
      scopeDir,
      path,
      withMemoryNoteId(content, noteId),
      times,
    );
  }
  const renamed = needsRename(name, renames);
  if (renamed) {
    await renameNote(
      scopeDir,
      directory,
      name,
      memoryNoteFileName(createdMs, name.slice(0, -'.md'.length), noteId),
      noteId,
      times,
    );
  }
  return { identified, renamed };
}

async function backfillImportLedger(scopeDir: string): Promise<number> {
  const inspection = await inspectImportState(scopeDir);
  // An invalid ledger is left for its own recovery paths to handle.
  if (inspection.kind !== 'present') return 0;
  const { state } = inspection;
  let identified = 0;
  for (const [sourcePath, entry] of Object.entries(state.sources)) {
    if (!('stagedAs' in entry) || entry.noteId !== undefined) continue;
    state.sources[sourcePath] = {
      ...entry,
      noteId: memoryNoteIdAt(Date.parse(entry.importedAt)),
    };
    identified += 1;
  }
  if (identified > 0) await writeImportState(scopeDir, state);
  return identified;
}

async function backfillFolder(
  scopeDir: string,
  directory: string,
  renames: boolean,
  result: MemoryScopeBackfillResult,
): Promise<void> {
  const names = await listNoteFiles(directory);
  const ordered = [
    ...names.filter((name) => needsRename(name, renames)),
    ...names.filter((name) => !needsRename(name, renames)),
  ];
  for (const name of ordered) {
    try {
      const outcome = await backfillNote(scopeDir, directory, name, renames);
      if (outcome.identified) result.notesIdentified += 1;
      if (outcome.renamed) result.notesRenamed += 1;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) continue;
      result.complete = false;
      if (error instanceof MemoryPathNotContainedError) {
        warnLinkSkipped(error);
      } else {
        warnBackfillFailure(name, error);
      }
    }
  }
}

const warnedLinks = new Set<string>();

function warnLinkSkipped(error: MemoryPathNotContainedError): void {
  if (warnedLinks.has(error.linkedPath)) return;
  warnedLinks.add(error.linkedPath);
  process.emitWarning(
    `Skipped memory notes behind ${error.linkedPath}: links are not followed`,
    { code: 'LOCAL_MEMORY_LINK_SKIPPED' },
  );
}

/** Whether a note folder is in the scope; a linked one is skipped. */
async function folderIsContained(
  scopeDir: string,
  directory: string,
): Promise<boolean> {
  try {
    await assertMemoryPathContained(scopeDir, directory);
    return true;
  } catch (error) {
    if (!(error instanceof MemoryPathNotContainedError)) throw error;
    warnLinkSkipped(error);
    return false;
  }
}

function warnBackfillFailure(subject: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.emitWarning(
    `Could not give ${subject} a memory note ID yet: ${reason}`,
    { code: 'LOCAL_MEMORY_BACKFILL_INCOMPLETE' },
  );
}

/**
 * A note or ledger that cannot be read or written now is skipped with a
 * warning rather than blocking every write to the scope; the result says
 * the backfill is incomplete, so the next write tries it again.
 */
export async function backfillMemoryScope(
  scopeDir: string,
): Promise<MemoryScopeBackfillResult> {
  const result: MemoryScopeBackfillResult = {
    complete: true,
    notesIdentified: 0,
    notesRenamed: 0,
    importsIdentified: 0,
  };
  for (const folder of NOTE_FOLDERS) {
    const directory = join(scopeDir, folder.path);
    try {
      if (!(await folderIsContained(scopeDir, directory))) continue;
      await backfillFolder(scopeDir, directory, folder.renames, result);
    } catch (error) {
      result.complete = false;
      warnBackfillFailure(folder.path, error);
    }
  }
  try {
    result.importsIdentified = await backfillImportLedger(scopeDir);
  } catch (error) {
    result.complete = false;
    warnBackfillFailure('staged imports', error);
  }
  if (result.complete) await warnDuplicateNoteIds(scopeDir);
  return result;
}

interface DuplicateMemoryNoteId {
  id: string;
  /** Scope-relative keys of the files, or staged imports, carrying it. */
  fileKeys: string[];
}

/**
 * Note IDs more than one file in the scope carries, where each note should
 * be in exactly one: pending and archived inbox notes, and staged imports
 * through their ledger entries. Linked folders and files are not followed.
 */
export async function findDuplicateMemoryNoteIds(
  scopeDir: string,
): Promise<DuplicateMemoryNoteId[]> {
  const owners = new Map<string, string[]>();
  const own = (id: string, fileKey: string): void => {
    owners.set(id, [...(owners.get(id) ?? []), fileKey]);
  };
  for (const folder of NOTE_FOLDERS) {
    const directory = join(scopeDir, folder.path);
    if (!(await isMemoryPathContained(scopeDir, directory))) continue;
    for (const name of await listNoteFiles(directory)) {
      const content = await readFile(join(directory, name), 'utf8').catch(
        () => '',
      );
      const id = memoryNoteId(content);
      if (id !== null) own(id, `${folder.key}/${name}`);
    }
  }
  const ledger = await inspectImportState(scopeDir);
  if (ledger.kind === 'present') {
    for (const entry of Object.values(ledger.state.sources)) {
      if ('stagedAs' in entry && entry.noteId !== undefined) {
        own(entry.noteId, entry.stagedAs);
      }
    }
  }
  return Array.from(owners)
    .filter(([, fileKeys]) => fileKeys.length > 1)
    .map(([id, fileKeys]) => ({ id, fileKeys }));
}

async function warnDuplicateNoteIds(scopeDir: string): Promise<void> {
  try {
    const duplicates = await findDuplicateMemoryNoteIds(scopeDir);
    if (duplicates.length === 0) return;
    process.emitWarning(
      `${duplicates.length} memory note IDs are each in more than one file`,
      { code: 'LOCAL_MEMORY_NOTE_ID_DUPLICATED' },
    );
  } catch {
    // A diagnostic only: the backfill itself is done.
  }
}
