import { lstat, readFile, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  MEMORY_INDEX_PATH,
  compareMemoryChangeCursors,
  isMemoryNoteOriginBlocked,
  memoryDocumentIdentity,
  type MemoryChange,
  type MemoryConflictReason,
  type MemoryDocument,
  type MemoryDocumentChange,
  type MemoryNoteRecord,
  type MemoryOriginPolicy,
  type MemoryRevisionRecord,
  type MemorySyncStateFile,
} from '@canopy/protocol/memory-sync';
import {
  recordMemoryEdit,
  withMemoryWriteLock,
} from '../local/edit-coordination';
import {
  isLiveImportEntry,
  readImportState,
  retireImportNotes,
  stampImportNotesConsolidated,
  writeImportState,
} from '../local/import/ledger';
import {
  assertMemoryPathContained,
  assertMemoryScopeLockHeld,
  ensureOwnerOnlyMemoryDir,
  isMemoryMarkdownFileName,
  isNodeError,
  moveWithoutReplacing,
  readMemoryFile,
  replaceMemoryFileIfUnchanged,
  sameMemoryFileContent,
  writeMemoryFileAtomically,
  writeMemoryFileDurably,
  type MemoryFileContent,
} from '../local/memory-files';
import {
  memoryNoteId,
  readMemoryNoteFrontMatter,
} from '../local/note-identity';
import { createLocalMemorySnapshot } from '../local/snapshots';
import {
  normalizeMemoryDocumentContent,
  type MemoryDocumentMerge,
} from '@canopy/memory-consolidation/document-merge';
import { queueConflictNotes } from './conflict-notes';
import { mergeMemoryDocumentOffMain } from './merge-runner';
import { inboxNoteBody, renderPulledNote } from './note-records';
import {
  readMemorySyncOutbox,
  readMemorySyncState,
  recordMemorySyncConflict,
  sha256Hex,
  writeMemorySyncState,
} from './replica-files';
import { memorySyncPrivateDir } from './replica-layout';

/*
 * The replica writer (design §16.5): applies a snapshot or a page of changes
 * to a replica under its scope lock, files first and `sync-state.json` last.
 * A crash between them replays the page, so every step is idempotent: a note
 * already on disk is left alone, a document already holding the incoming
 * bytes is not rewritten, and a revision at or below the base is skipped.
 *
 * A document edited here and not yet committed is never lost: a pulled
 * change that meets it is merged three ways against `.sync/base/` (design
 * §13.2). A clean merge or a kept local edit stays live and is committed at
 * the head; overlapping changes leave theirs live and keep ours under
 * `.sync/conflicts/`. Files a snapshot does not list are moved to
 * `.sync/displaced/`, never deleted, and only when their content is
 * preserved elsewhere (see `preservedElsewhere`): what only this device has
 * stays where it is.
 */

/** The replica's state does not continue from what was pulled: take a snapshot. */
export class MemoryReplicaGapError extends Error {
  constructor(readonly reason: 'revision_gap' | 'cursor_mismatch' | 'state') {
    super(`The memory replica needs a snapshot (${reason})`);
    this.name = 'MemoryReplicaGapError';
  }
}

export interface MemoryReplicaWriteOptions {
  /** This device, whose own withheld notes stay as local-only. */
  deviceId: string;
  /** This device's name, which the notes carrying its side of a conflict name. */
  deviceLabel: string;
  /**
   * Organizations the account policy keeps off the cloud (design §10.4):
   * this device's user-scope notes saved under them are withheld, so a
   * snapshot keeps them as local-only.
   */
  blockedOriginOrganizationIds: ReadonlySet<string>;
  now: () => Date;
}

export interface MemoryReplicaSnapshot {
  revision: number;
  cursor: string;
  documents: readonly MemoryDocument[];
  pendingNotes: readonly MemoryNoteRecord[];
}

export interface MemoryReplicaApplyResult {
  /** Documents written or deleted. */
  documentsChanged: number;
  notesWritten: number;
  notesRemoved: number;
  conflicts: number;
  /** How each pulled change that met a local edit was resolved. */
  merges: Record<MemoryDocumentMerge['kind'], number>;
  /**
   * For each note from another device written now, how long after the cloud
   * received it (design §20 `sync.delay`).
   */
  delaysMs: number[];
}

interface LocalNote {
  fileKey: string;
  path: string;
  archived: boolean;
  /**
   * Saved on this device: its front matter names this device or none, or it
   * is an import staged here rather than pulled.
   */
  own: boolean;
  /**
   * An import its ledger has not stamped consolidated: it claims its staged
   * path even while its file is gone (an archive cut short after the move).
   */
  pendingImport: boolean;
  /** The organization an inbox note was saved under (design §10.4). */
  originOrganizationId: string | null;
}

interface OutboxNotes {
  readable: boolean;
  held: Set<string>;
  retired: Set<string>;
  /** Notes a delete or edit made here has not settled yet (`localDeletes`). */
  unsettled: Set<string>;
}

/** A replica file a pull or a snapshot would move aside, remove or replace. */
type ReplicaFile =
  | { kind: 'document'; path: string; live: MemoryFileContent | null }
  | { kind: 'note'; noteId: string; local: LocalNote };

type SnapshotKept = NonNullable<MemorySyncStateFile['snapshotKept']>;

const IMPORT_SYNC_SOURCE_PREFIX = 'sync:';

/** Where a conflict's copy of a local edit is, relative to the replica. */
const CONFLICTS_PREFIX = '.sync/conflicts/';

/** Names tried for a pulled note before giving up. */
const MAX_PULLED_NOTE_NAMES = 100;

/** Names tried for a displaced or conflict file before giving up. */
const MAX_FREE_NAMES = 100;

/**
 * Times a live document another editor keeps saving is read and decided
 * again before its save is left as it is, as a local edit. Every retry in
 * the writer is bounded by this: out of attempts the live file is left
 * exactly as it is, under the spelling it was found under, and the pass goes
 * on. The document still differs from the base, so the next commit reports
 * it (`document_not_text` when its bytes are not text at all) rather than
 * the writer spinning under the scope lock.
 */
const MAX_LIVE_WRITE_ATTEMPTS = 5;

/** The spelling a pulled put was decided on, as read, and whether it stays. */
interface MergedSpelling {
  spelling: string;
  live: MemoryFileContent | null;
  kept: boolean;
}

/** A live note holds its file key; a pending import even while its file is gone. */
function claimsFileKey(local: LocalNote): boolean {
  return !local.archived || local.pendingImport;
}

function emptyResult(): MemoryReplicaApplyResult {
  return {
    documentsChanged: 0,
    notesWritten: 0,
    notesRemoved: 0,
    conflicts: 0,
    merges: { theirs: 0, ours: 0, same: 0, merged: 0, conflict: 0 },
    delaysMs: [],
  };
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return null;
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function markdownNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return [];
    }
    throw error;
  }
}

/**
 * Removes a replica file; with `unchanged`, only while it still holds right
 * before the removal (see {@link replaceMemoryFileIfUnchanged}).
 */
export async function removeMemoryFile(
  scopeDir: string,
  path: string,
  unchanged?: () => Promise<boolean>,
): Promise<boolean> {
  await assertMemoryPathContained(scopeDir, dirname(path));
  await assertMemoryScopeLockHeld();
  if (unchanged !== undefined && !(await unchanged())) return false;
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  return true;
}

/**
 * Whether `path` still holds the file `expected` was read from, null for no
 * file. Compared by its bytes: the text of a file that is not UTF-8 is a
 * lossy decode, which no two reads can tell apart (see `readMemoryFile`).
 */
function holds(
  path: string,
  expected: MemoryFileContent | null,
): () => Promise<boolean> {
  return async () =>
    sameMemoryFileContent(await readMemoryFile(path), expected);
}

/** Whether a conflict copy at `path` holds exactly `live`. */
async function copyHolds(path: string, live: Buffer): Promise<boolean> {
  return (await readMemoryFile(path))?.bytes.equals(live) === true;
}

/**
 * The other spellings of a topic's file under `root`: topic identity is
 * case-folded, so `topics/Travel.md` and `topics/travel.md` are one
 * document. On a case-insensitive file system both name one file.
 */
async function otherSpellings(root: string, path: string): Promise<string[]> {
  if (path === MEMORY_INDEX_PATH) return [];
  const identity = memoryDocumentIdentity(path);
  return (await markdownNames(join(root, dirname(path))))
    .map((name) => `${dirname(path)}/${name}`)
    .filter(
      (other) => other !== path && memoryDocumentIdentity(other) === identity,
    );
}

async function isSameFile(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      lstat(left, { bigint: true }),
      lstat(right, { bigint: true }),
    ]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

/**
 * Gives `source` the spelling `target` (see {@link moveWithoutReplacing}).
 * On a case-insensitive file system both name one file, which a rename
 * respells. Otherwise the move never replaces a file: one another editor
 * saved under `target` meanwhile makes it reject with EEXIST, and a save
 * over `source` after it was linked, or bytes other than `expectedBytes`
 * there, with ECHANGED; either changes nothing, so the caller decides again.
 */
export async function respellMemoryFile(
  scopeDir: string,
  source: string,
  target: string,
  expectedBytes?: Buffer,
): Promise<void> {
  await moveWithoutReplacing(
    scopeDir,
    source,
    target,
    expectedBytes === undefined ? {} : { expectedBytes },
  );
}

async function indexInboxNotes(
  scopeDir: string,
  deviceId: string,
  notes: Map<string, LocalNote>,
): Promise<void> {
  const folders = [
    { folder: 'inbox', archived: false },
    { folder: join('inbox', '.consolidated'), archived: true },
  ];
  for (const { folder, archived } of folders) {
    for (const name of await markdownNames(join(scopeDir, folder))) {
      const path = join(scopeDir, folder, name);
      const content = await readTextOrNull(path);
      const id = content === null ? null : memoryNoteId(content);
      if (content === null || id === null) continue;
      if (notes.get(id)?.archived === false) continue;
      const fields = readMemoryNoteFrontMatter(content)?.fields;
      const device = fields?.device;
      const origin = fields?.origin;
      notes.set(id, {
        fileKey: `inbox/${name}`,
        path,
        archived,
        own: typeof device !== 'string' || device === deviceId,
        pendingImport: false,
        originOrganizationId:
          typeof origin === 'object' ? (origin.organizationId ?? null) : null,
      });
    }
  }
}

/**
 * Imports by note ID. Only a pending import claims its staged path: a
 * retired one is left out, and a consolidated one lives in `.consolidated/`,
 * so a later import staged under the same name is never taken for either.
 * A pending import whose file is gone still claims its path, so no later
 * import is written there for it to take.
 */
async function indexImports(
  scopeDir: string,
  notes: Map<string, LocalNote>,
): Promise<void> {
  const imports = await readImportState(scopeDir);
  for (const [source, entry] of Object.entries(imports.sources)) {
    if (!isLiveImportEntry(entry) || entry.noteId === undefined) continue;
    const path = join(scopeDir, entry.stagedAs);
    const pendingImport = entry.consolidatedAt === undefined;
    const archived = !pendingImport || !(await exists(path));
    notes.set(entry.noteId, {
      fileKey: entry.stagedAs,
      path: archived
        ? join(scopeDir, 'imported', '.consolidated', basename(entry.stagedAs))
        : path,
      archived,
      own: !source.startsWith(IMPORT_SYNC_SOURCE_PREFIX),
      pendingImport,
      originOrganizationId: null,
    });
  }
}

/** Every note in the replica by ID: inbox notes, archived ones and imports. */
async function indexLocalNotes(
  scopeDir: string,
  deviceId: string,
): Promise<Map<string, LocalNote>> {
  const notes = new Map<string, LocalNote>();
  await indexInboxNotes(scopeDir, deviceId, notes);
  await indexImports(scopeDir, notes);
  return notes;
}

function isImportFileKey(fileKey: string): boolean {
  return fileKey.startsWith('imported/');
}

function timestampSlug(at: Date): string {
  return at.toISOString().replace(/[-:.]/g, '');
}

/** Moves a file to a free name in `directory`, keeping its own name first. */
async function moveToFreeName(
  scopeDir: string,
  source: string,
  directory: string,
): Promise<string> {
  await ensureOwnerOnlyMemoryDir(scopeDir, directory);
  const name = basename(source);
  const stem = name.endsWith('.md') ? name.slice(0, -3) : name;
  for (let attempt = 1; attempt <= MAX_FREE_NAMES; attempt += 1) {
    const destination = join(
      directory,
      attempt === 1 ? name : `${stem}-${attempt}.md`,
    );
    try {
      await moveWithoutReplacing(scopeDir, source, destination);
      return destination;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
  }
  throw new Error(`No free name for ${name} in ${directory}`);
}

class ReplicaApply {
  private notes: Map<string, LocalNote> | null = null;
  private outboxNotes: OutboxNotes | null = null;
  private snapshotTaken = false;
  private editRecorded = false;
  private displacedDir: string | null = null;
  /** What this replica last applied per document, as the changes go. */
  private readonly base: MemorySyncStateFile['baseDocuments'];
  /**
   * Applying this replica's own manual edit: the live documents already
   * hold what was committed, or a newer edit made since, so only the base
   * moves.
   */
  keepLiveDocuments = false;
  readonly result = emptyResult();

  constructor(
    private readonly scopeDir: string,
    private readonly state: MemorySyncStateFile,
    private readonly options: MemoryReplicaWriteOptions,
  ) {
    this.base = { ...state.baseDocuments };
  }

  async noteIndex(): Promise<Map<string, LocalNote>> {
    this.notes ??= await indexLocalNotes(this.scopeDir, this.options.deviceId);
    return this.notes;
  }

  /** Before the first document write: a `sync` snapshot and a new revision. */
  private async beforeDocumentWrite(): Promise<void> {
    if (!this.snapshotTaken) {
      this.snapshotTaken = true;
      await createLocalMemorySnapshot(
        this.scopeDir,
        'sync',
        this.options.now(),
      );
    }
    if (!this.editRecorded) {
      this.editRecorded = true;
      await recordMemoryEdit(this.scopeDir);
    }
  }

  private keepLocalOnly(noteId: string): void {
    if (!this.state.localOnlyNoteIds.includes(noteId)) {
      this.state.localOnlyNoteIds.push(noteId);
    }
  }

  /**
   * Records a conflict (design §13.2): theirs stays live, so every device
   * injects the same memory, and ours is kept under `.sync/conflicts/`,
   * named after the spelling it was found under, for the conflict view. The
   * copy is flushed to disk, then the conflict is recorded in
   * `sync-state.json`, flushed too, before the document is replaced or
   * removed, since the copy is then the edit's only place and the record the
   * only way to find it. A deleted ours is kept as an empty file. A replayed
   * pull keeps neither twice: an edit a recorded copy holds is kept already,
   * and a copy cut short before its record is recorded rather than written
   * again. A conflict file is never replaced. `reason` tells the conflict
   * view why the two were not merged. The copy holds the live bytes as they
   * were, so a file memory sync cannot carry is kept as the editor saved it.
   */
  private async recordConflict(
    path: string,
    ours: MemoryFileContent | null,
    theirsRevision: number,
    reason: MemoryConflictReason,
    spelling = path,
  ): Promise<void> {
    const kept = ours?.bytes ?? Buffer.alloc(0);
    if (await this.recordedCopyHolds(path, kept)) return;
    const at = this.options.now();
    const stem = spelling.slice(0, -'.md'.length);
    const oursFile =
      (await this.unrecordedCopyOf(stem, kept)) ??
      (await this.writeConflictCopy(`${stem}.${timestampSlug(at)}`, kept));
    const conflict = {
      path,
      detectedAt: at.toISOString(),
      theirsRevision,
      oursFile: `${CONFLICTS_PREFIX}${oursFile}`,
      reason,
      ...(ours === null ? { oursDeleted: true } : {}),
    };
    await recordMemorySyncConflict(this.scopeDir, conflict);
    this.state.conflicts.push(conflict);
    this.result.conflicts += 1;
  }

  private async recordedCopyHolds(
    path: string,
    live: Buffer,
  ): Promise<boolean> {
    for (const conflict of this.state.conflicts) {
      if (
        conflict.path === path &&
        conflict.oursFile.startsWith(CONFLICTS_PREFIX) &&
        (await copyHolds(join(this.scopeDir, conflict.oursFile), live))
      ) {
        return true;
      }
    }
    return false;
  }

  /** A copy of `live` under `stem` that no conflict records, by its name. */
  private async unrecordedCopyOf(
    stem: string,
    live: Buffer,
  ): Promise<string | null> {
    const slash = stem.lastIndexOf('/');
    const folder = stem.slice(0, slash + 1);
    const prefix = `${stem.slice(slash + 1)}.`;
    const recorded = new Set(
      this.state.conflicts.map((conflict) => conflict.oursFile),
    );
    const conflicts = memorySyncPrivateDir(this.scopeDir, 'conflicts');
    for (const name of await markdownNames(join(conflicts, folder))) {
      const relative = `${folder}${name}`;
      if (
        name.startsWith(prefix) &&
        !recorded.has(`${CONFLICTS_PREFIX}${relative}`) &&
        (await copyHolds(join(conflicts, relative), live))
      ) {
        return relative;
      }
    }
    return null;
  }

  /** Writes `live` under `name` in `.sync/conflicts/`, numbered when taken. */
  private async writeConflictCopy(name: string, live: Buffer): Promise<string> {
    const folder = memorySyncPrivateDir(this.scopeDir, 'conflicts');
    for (let attempt = 1; attempt <= MAX_FREE_NAMES; attempt += 1) {
      const relative = `${attempt === 1 ? name : `${name}-${attempt}`}.md`;
      try {
        await writeMemoryFileDurably(
          this.scopeDir,
          join(folder, relative),
          live,
          {
            replace: false,
          },
        );
        return relative;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
    }
    throw new Error(`No free name for the conflict copy ${name}`);
  }

  /**
   * The base key of the document `path` names: its own spelling when this
   * replica applied one, else another spelling of it, else `path`.
   */
  private basePathFor(path: string): string {
    if (this.base[path] !== undefined) return path;
    const identity = memoryDocumentIdentity(path);
    return (
      Object.keys(this.base).find(
        (key) => memoryDocumentIdentity(key) === identity,
      ) ?? path
    );
  }

  /** What this replica last applied under `path`, else another spelling. */
  private baseOf(
    path: string,
  ): MemorySyncStateFile['baseDocuments'][string] | undefined {
    return this.base[this.basePathFor(path)];
  }

  /** The document as this replica last applied it; null when it had none. */
  private async baseContent(path: string): Promise<string | null> {
    const key = this.basePathFor(path);
    if (this.base[key] === undefined) return null;
    return readTextOrNull(
      join(memorySyncPrivateDir(this.scopeDir, 'base'), key),
    );
  }

  /**
   * Whether this device's own user-scope note is one its organization now
   * keeps off the cloud (design §10.4): the cloud withholds it, and this
   * device keeps it as local-only.
   */
  private isWithheldHere(local: LocalNote): boolean {
    return (
      local.own &&
      isMemoryNoteOriginBlocked(
        {
          scopeKind: this.state.binding.kind,
          blockedOriginOrganizationIds:
            this.options.blockedOriginOrganizationIds,
        },
        local.originOrganizationId,
      )
    );
  }

  /**
   * Whether a replica file's content is preserved elsewhere, so a pull or a
   * snapshot may replace it, remove it or move it aside without losing what
   * only this device has (design §8.4). Every such decision asks this, but
   * for a note the cloud removes by its ID (see {@link removeNote}).
   *
   * A document is when it holds the bytes this replica last applied, which
   * `.sync/base/` and the cloud keep; other bytes are a local edit, merged
   * with a pulled change, kept under `.sync/conflicts/` first or left in
   * place. Line endings another editor changed are no edit, as committing
   * normalizes them. One deleted here is a local edit when this replica
   * applied it, and has nothing to lose otherwise. Bytes that are not UTF-8
   * text are never what was applied, since every applied document came from
   * the cloud as text, so such a file is always a local edit. A note is
   * unless only this device has it: kept local-only, one the outbox may
   * still hold, an import staged here (imports are not pushed yet), or this
   * device's own note its organization withholds.
   */
  private async preservedElsewhere(file: ReplicaFile): Promise<boolean> {
    if (file.kind === 'document') {
      const base = this.baseOf(file.path);
      if (file.live === null) return base === undefined;
      const { text } = file.live;
      return (
        text !== null &&
        base !== undefined &&
        base.contentHash === sha256Hex(normalizeMemoryDocumentContent(text))
      );
    }
    const { noteId, local } = file;
    return !(
      this.state.localOnlyNoteIds.includes(noteId) ||
      (await this.outboxHolds(noteId, local)) ||
      (local.own && local.pendingImport) ||
      this.isWithheldHere(local)
    );
  }

  /** Whether the live document holds a local edit a change would lose. */
  private async isLocalEdit(
    path: string,
    live: MemoryFileContent | null,
  ): Promise<boolean> {
    return !(await this.preservedElsewhere({ kind: 'document', path, live }));
  }

  /**
   * What the live document becomes when a pulled change meets a local edit
   * (design §13.2): theirs, ours kept (it is committed again at the head),
   * the merged text, or theirs with ours kept as a conflict. `spelling` is
   * the one the live document was read under.
   */
  private async mergeLocalEdit(
    path: string,
    live: MemoryFileContent | null,
    theirs: string | null,
    revision: number,
    spelling: string = path,
  ): Promise<{ keep: true } | { keep: false; content: string | null }> {
    const merge = await mergeMemoryDocumentOffMain(
      await this.baseContent(spelling),
      live?.text ?? null,
      theirs,
    );
    this.result.merges[merge.kind] += 1;
    switch (merge.kind) {
      case 'ours':
      case 'same':
        return { keep: true };
      case 'merged':
        return { keep: false, content: merge.content };
      case 'conflict':
        await this.recordConflict(path, live, revision, merge.reason, spelling);
        return { keep: false, content: theirs };
      case 'theirs':
        return { keep: false, content: theirs };
    }
  }

  /**
   * Replaces or removes the live document `path` while it still holds
   * `expected`, the bytes the change was decided on: false, with nothing
   * written, once another editor saved it meanwhile (the scope lock keeps
   * only the app's writers out), so the caller decides again.
   */
  private async writeLive(
    path: string,
    expected: MemoryFileContent | null,
    content: string | null,
  ): Promise<boolean> {
    await this.beforeDocumentWrite();
    const target = join(this.scopeDir, path);
    const unchanged = holds(target, expected);
    const written =
      content === null
        ? await removeMemoryFile(this.scopeDir, target, unchanged)
        : await replaceMemoryFileIfUnchanged(
            this.scopeDir,
            target,
            content,
            unchanged,
          );
    if (written) this.result.documentsChanged += 1;
    return written;
  }

  /**
   * Moves a kept live document to the spelling a change pulled, where
   * letter case tells files apart, so the replica and its base name it the
   * same way. False, with nothing moved, when another editor saved under
   * `to` meanwhile, or over `from` since `live` was read: that save is read
   * and merged, never replaced or removed.
   */
  private async respellLive(
    from: string,
    to: string,
    live: MemoryFileContent,
  ): Promise<boolean> {
    await this.beforeDocumentWrite();
    try {
      await respellMemoryFile(
        this.scopeDir,
        join(this.scopeDir, from),
        join(this.scopeDir, to),
        live.bytes,
      );
    } catch (error) {
      if (isNodeError(error, 'EEXIST') || isNodeError(error, 'ECHANGED')) {
        return false;
      }
      throw error;
    }
    this.result.documentsChanged += 1;
    return true;
  }

  /** Forgets what was applied under every spelling of `path`. */
  private forgetBase(path: string): void {
    const identity = memoryDocumentIdentity(path);
    for (const documents of [this.state.baseDocuments, this.base]) {
      for (const key of Object.keys(documents)) {
        if (memoryDocumentIdentity(key) === identity) delete documents[key];
      }
    }
  }

  /**
   * The live document `path` names and the spelling it was read under: its
   * own, else, where letter case tells files apart, the spelling this
   * replica last applied.
   */
  private async readLive(
    path: string,
  ): Promise<{ spelling: string; live: MemoryFileContent | null }> {
    const live = await readMemoryFile(join(this.scopeDir, path));
    const prior = this.basePathFor(path);
    if (live !== null || prior === path) return { spelling: path, live };
    return {
      spelling: prior,
      live: await readMemoryFile(join(this.scopeDir, prior)),
    };
  }

  /**
   * Leaves `path` the only spelling of its document in the replica and in
   * `.sync/base/`, after its bytes are written there: the file of a
   * case-insensitive file system takes its spelling, and a separate file
   * under another spelling goes, its local edit kept as a conflict first.
   * The spelling a change was merged from is not judged again, and stays
   * when the merge kept it. Applying this replica's own manual edit removes
   * only spellings that hold no edit. A crash part way leaves the new bytes
   * in place and the rest to the replayed page.
   */
  private async settleSpellings(
    path: string,
    content: string,
    revision: number,
    merged: MergedSpelling | null,
  ): Promise<void> {
    const baseDir = memorySyncPrivateDir(this.scopeDir, 'base');
    for (const root of [this.scopeDir, baseDir]) {
      const target = join(root, path);
      const inReplica = root === this.scopeDir;
      for (const other of await otherSpellings(root, path)) {
        const source = join(root, other);
        if (inReplica && merged?.spelling === other && merged.kept) continue;
        if (await isSameFile(source, target)) {
          if (inReplica && this.keepLiveDocuments) continue;
          if (inReplica) await this.beforeDocumentWrite();
          await respellMemoryFile(this.scopeDir, source, target);
          continue;
        }
        if (inReplica) {
          await this.removeSpelling(path, other, content, revision, merged);
        } else {
          await removeMemoryFile(this.scopeDir, source);
        }
      }
    }
  }

  /**
   * Removes the separate file of another spelling of `path`, its local edit
   * kept as a conflict first unless the merge took it in as it still is. A
   * save another editor makes meanwhile is judged again, never removed
   * unseen; one that keeps coming stays.
   */
  private async removeSpelling(
    path: string,
    other: string,
    content: string,
    revision: number,
    merged: MergedSpelling | null,
  ): Promise<void> {
    const source = join(this.scopeDir, other);
    for (let attempt = 0; attempt < MAX_LIVE_WRITE_ATTEMPTS; attempt += 1) {
      const ours = await readMemoryFile(source);
      if (ours === null) return;
      const edited =
        (ours.text === null ||
          normalizeMemoryDocumentContent(ours.text) !== content) &&
        !(
          merged?.spelling === other && sameMemoryFileContent(merged.live, ours)
        ) &&
        (await this.isLocalEdit(other, ours));
      if (edited && this.keepLiveDocuments) return;
      await this.beforeDocumentWrite();
      if (edited) {
        await this.recordConflict(path, ours, revision, 'overlap', other);
      }
      if (await removeMemoryFile(this.scopeDir, source, holds(source, ours))) {
        this.result.documentsChanged += 1;
        return;
      }
    }
  }

  /**
   * A put replaces the document of its identity: what a local edit merges
   * to is written under the pulled spelling, which then becomes the only
   * one.
   */
  async putDocument(
    path: string,
    content: string,
    contentHash: string,
    revision: number,
  ): Promise<void> {
    const merged = this.keepLiveDocuments
      ? null
      : await this.putLive(path, content, revision);
    await writeMemoryFileAtomically(
      this.scopeDir,
      join(memorySyncPrivateDir(this.scopeDir, 'base'), path),
      content,
    );
    await this.settleSpellings(path, content, revision, merged);
    this.forgetBase(path);
    const applied = { contentHash, changedInRevision: revision };
    this.state.baseDocuments[path] = applied;
    this.base[path] = applied;
  }

  /**
   * Makes the live document of `path` hold `content`, or what its local
   * edit merges to with it, and returns the spelling that was decided on. A
   * save another editor makes meanwhile is read and merged again, never
   * replaced; one that keeps coming, within {@link MAX_LIVE_WRITE_ATTEMPTS}
   * tries, is left as a local edit under the spelling it was read from, and
   * so is a file whose bytes are not text (see {@link decideLive}).
   */
  private async putLive(
    path: string,
    content: string,
    revision: number,
  ): Promise<MergedSpelling | null> {
    let read = await this.readLive(path);
    for (let attempt = 0; attempt < MAX_LIVE_WRITE_ATTEMPTS; attempt += 1) {
      const { spelling, live } = read;
      if (live?.text === content && spelling === path) return null;
      const next = await this.decideLive(
        path,
        spelling,
        live,
        content,
        revision,
      );
      if (next.keep) {
        if (live === null || spelling === path) {
          return { spelling, live, kept: true };
        }
        // A save under the pulled spelling meanwhile is read and merged.
        if (await this.respellLive(spelling, path, live)) {
          return { spelling: path, live, kept: true };
        }
      } else if (
        (next.content === live?.text && spelling === path) ||
        (await this.writeLive(
          path,
          spelling === path ? live : null,
          next.content,
        ))
      ) {
        return { spelling, live, kept: false };
      }
      read = await this.readLive(path);
    }
    // Out of attempts: the save that keeps coming stays where it is, under
    // the spelling it was read from, and the next commit reports it.
    return { ...read, kept: true };
  }

  /**
   * What a pulled change makes of the live document read under `spelling`.
   * Bytes that are not UTF-8 text are kept as they are: nothing can merge
   * them, and the lossy decode a merge would read is not the file, so
   * replacing it would lose bytes only this device has.
   */
  private async decideLive(
    path: string,
    spelling: string,
    live: MemoryFileContent | null,
    theirs: string | null,
    revision: number,
  ): Promise<{ keep: true } | { keep: false; content: string | null }> {
    if (live !== null && live.text === null) return { keep: true };
    if (!(await this.isLocalEdit(spelling, live))) {
      return { keep: false, content: theirs };
    }
    return this.mergeLocalEdit(path, live, theirs, revision, spelling);
  }

  /**
   * Removes one spelling of a document a pulled revision deleted, its local
   * edit merged first; a save another editor makes meanwhile is merged
   * again, and one that keeps coming stays.
   */
  private async deleteLive(
    path: string,
    spelling: string,
    revision: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_LIVE_WRITE_ATTEMPTS; attempt += 1) {
      const live = await readMemoryFile(join(this.scopeDir, spelling));
      if (live === null) return;
      const next = await this.decideLive(path, spelling, live, null, revision);
      if (next.keep || (await this.writeLive(spelling, live, next.content))) {
        return;
      }
    }
  }

  async deleteDocument(path: string, revision: number): Promise<void> {
    const baseDir = memorySyncPrivateDir(this.scopeDir, 'base');
    if (!this.keepLiveDocuments) {
      const target = join(this.scopeDir, path);
      for (const spelling of [
        path,
        ...(await otherSpellings(this.scopeDir, path)),
      ]) {
        const source = join(this.scopeDir, spelling);
        if (spelling !== path && (await isSameFile(source, target))) continue;
        await this.deleteLive(path, spelling, revision);
      }
    }
    for (const spelling of [path, ...(await otherSpellings(baseDir, path))]) {
      await removeMemoryFile(this.scopeDir, join(baseDir, spelling));
    }
    this.forgetBase(path);
  }

  /**
   * Writes a pending note that is not on disk yet, unless this device has
   * already queued its tombstone or a replacement of it. A note that
   * replaces the one holding its file key takes the key in place, the old
   * note removed as `note_removed` would remove it; otherwise it goes under
   * a free name, so a pulled note never replaces a file.
   */
  async writePendingNote(note: MemoryNoteRecord): Promise<void> {
    const notes = await this.noteIndex();
    if (
      notes.has(note.noteId) ||
      this.state.localOnlyNoteIds.includes(note.noteId) ||
      (await this.outboxNoteIds()).retired.has(note.noteId)
    ) {
      return;
    }
    const content = renderPulledNote(note);
    const occupant = [...notes.entries()].find(
      ([, local]) => claimsFileKey(local) && local.fileKey === note.fileKey,
    );
    if (occupant !== undefined && occupant[0] === note.supersedes) {
      await this.removeNote(occupant[0], 'superseded');
    }
    const fileKey = await this.freeFileKey(note, notes, content);
    const path = join(this.scopeDir, fileKey);
    await ensureOwnerOnlyMemoryDir(this.scopeDir, dirname(path));
    const modified = new Date(note.modifiedAt);
    await writeMemoryFileAtomically(this.scopeDir, path, content, {
      atime: modified,
      mtime: modified,
    });
    if (note.kind === 'import') await this.recordPulledImport(note, fileKey);
    notes.set(note.noteId, {
      fileKey,
      path,
      archived: false,
      own: note.device.deviceId === this.options.deviceId,
      pendingImport: note.kind === 'import',
      originOrganizationId: note.origin.organizationId,
    });
    this.result.notesWritten += 1;
  }

  /**
   * The note's own file key when no file or note claims it, else
   * `<stem>-<last 10 of its ULID>.md`, then numbered. A file no note claims
   * that already holds `content` is this note's, written by a pull cut short
   * before its import ledger write, and is written again in place.
   */
  private async freeFileKey(
    note: MemoryNoteRecord,
    notes: ReadonlyMap<string, LocalNote>,
    content: string,
  ): Promise<string> {
    const stem = note.fileKey.slice(0, -'.md'.length);
    const suffix = note.noteId.slice(-10).toLowerCase();
    for (let attempt = 0; attempt < MAX_PULLED_NOTE_NAMES; attempt += 1) {
      const candidate =
        attempt === 0
          ? note.fileKey
          : `${stem}-${suffix}${attempt === 1 ? '' : `-${attempt}`}.md`;
      const claimed = [...notes.values()].some(
        (local) => claimsFileKey(local) && local.fileKey === candidate,
      );
      if (claimed) continue;
      const path = join(this.scopeDir, candidate);
      if (
        !(await exists(path)) ||
        (await readTextOrNull(path).catch(() => null)) === content
      ) {
        return candidate;
      }
    }
    throw new Error('A pulled memory note has no free name');
  }

  private async recordPulledImport(
    note: MemoryNoteRecord,
    fileKey: string,
  ): Promise<void> {
    const imports = await readImportState(this.scopeDir);
    const tool = note.importSource?.tool;
    imports.sources[`${IMPORT_SYNC_SOURCE_PREFIX}${note.noteId}`] = {
      fileHash: sha256Hex(note.body),
      importedAt: note.receivedAt,
      stagedAs: fileKey,
      modified: note.modifiedAt,
      noteId: note.noteId,
      ...(tool === 'claude-code' || tool === 'codex'
        ? { sourceTool: tool }
        : {}),
    };
    await writeImportState(this.scopeDir, imports);
  }

  private forgetLocalOnly(noteId: string): void {
    const index = this.state.localOnlyNoteIds.indexOf(noteId);
    if (index !== -1) this.state.localOnlyNoteIds.splice(index, 1);
  }

  /**
   * Removes the live copy of a note the cloud removed by its ID, or one a
   * pulled note supersedes in its file. A note kept local-only stays unless
   * purged, since only this device has what it holds; this device's own
   * withheld note becomes one. A removed note loses its local-only mark,
   * also when a replay finds its file already gone, and a removed import's
   * ledger entry is retired after its file goes.
   */
  async removeNote(
    noteId: string,
    reason: 'tombstoned' | 'superseded' | 'withheld' | 'purged',
  ): Promise<void> {
    const notes = await this.noteIndex();
    const local = notes.get(noteId);
    if (local === undefined) {
      this.forgetLocalOnly(noteId);
      return;
    }
    if (reason === 'withheld' && local.own) {
      if (!local.archived) this.keepLocalOnly(noteId);
      return;
    }
    if (
      !local.archived &&
      reason !== 'purged' &&
      this.state.localOnlyNoteIds.includes(noteId)
    ) {
      return;
    }
    if (!local.archived) {
      await removeMemoryFile(this.scopeDir, local.path);
      this.result.notesRemoved += 1;
    }
    notes.delete(noteId);
    this.forgetLocalOnly(noteId);
    if (isImportFileKey(local.fileKey)) await this.retireImports([noteId]);
  }

  private async retireImports(noteIds: readonly string[]): Promise<void> {
    await retireImportNotes(
      this.scopeDir,
      new Set(noteIds),
      this.options.now().toISOString(),
    );
  }

  /**
   * Moves consumed notes into `.consolidated/`, as local consolidation does,
   * then stamps consumed imports in the ledger. The stamp also covers an
   * import a replayed page finds already moved, so an archive cut short
   * between the move and the stamp completes. This replica's own commit
   * leaves a note it consumed alone while a delete or edit made here since
   * is not settled, or while the last snapshot kept it for the outbox: the
   * file is the change's to settle, and an edit's replacement is written
   * over it rather than lost with it.
   */
  async archiveNotes(
    noteIds: readonly string[],
    ownCommit = false,
  ): Promise<void> {
    if (noteIds.length === 0) return;
    const notes = await this.noteIndex();
    const consumedImports = new Set<string>();
    const changedHere = ownCommit
      ? new Set([
          ...(await this.outboxNoteIds()).unsettled,
          ...(this.currentSnapshotKept()?.notes ?? []).map(
            (entry) => entry.noteId,
          ),
        ])
      : new Set<string>();
    for (const noteId of noteIds) {
      const local = notes.get(noteId);
      if (local === undefined || changedHere.has(noteId)) continue;
      const imported = isImportFileKey(local.fileKey);
      if (imported && local.pendingImport) consumedImports.add(noteId);
      if (local.archived) continue;
      const destination = await moveToFreeName(
        this.scopeDir,
        local.path,
        join(this.scopeDir, imported ? 'imported' : 'inbox', '.consolidated'),
      );
      notes.set(noteId, { ...local, path: destination, archived: true });
    }
    await stampImportNotesConsolidated(
      this.scopeDir,
      consumedImports,
      this.options.now().toISOString(),
    );
    for (const noteId of consumedImports) {
      const local = notes.get(noteId);
      if (local !== undefined) {
        notes.set(noteId, { ...local, pendingImport: false });
      }
    }
  }

  async applyNotePut(note: MemoryNoteRecord): Promise<void> {
    if (note.state === 'pending') {
      const known = (await this.noteIndex()).has(note.noteId);
      await this.writePendingNote(note);
      if (!known && note.device.deviceId !== this.options.deviceId) {
        const delay =
          this.options.now().getTime() - Date.parse(note.receivedAt);
        if (Number.isFinite(delay))
          this.result.delaysMs.push(Math.max(0, delay));
      }
    } else if (note.state === 'consolidated') {
      await this.archiveNotes([note.noteId]);
    } else {
      await this.removeNote(note.noteId, note.state);
    }
  }

  async applyRevision(
    change: Extract<MemoryChange, { kind: 'revision' }>,
  ): Promise<void> {
    const { revision } = change;
    const pending = this.state.pendingCommit;
    // A commit this replica sent and saw land: its run is resolved (§12.1).
    const own = pending?.commitId === revision.commitId;
    if (own) this.state.pendingCommit = null;
    if (revision.revision <= this.state.baseRevision) return;
    if (revision.parentRevision !== this.state.baseRevision) {
      throw new MemoryReplicaGapError('revision_gap');
    }
    // Its own manual edit, whose answer was lost, applies as an answered
    // one does: the live documents hold it, or a newer edit made since.
    const keepLive = this.keepLiveDocuments;
    this.keepLiveDocuments ||= own && pending?.kind === 'manual_edit';
    try {
      for (const documentChange of change.changes) {
        await this.applyDocumentChange(documentChange, revision.revision);
      }
    } finally {
      this.keepLiveDocuments = keepLive;
    }
    await this.archiveNotes(change.consumedNoteIds, own);
    this.state.baseRevision = revision.revision;
  }

  private async applyDocumentChange(
    change: MemoryDocumentChange,
    revision: number,
  ): Promise<void> {
    if (change.op === 'put') {
      await this.putDocument(
        change.path,
        change.content,
        change.contentHash,
        revision,
      );
    } else {
      await this.deleteDocument(change.path, revision);
    }
  }

  /**
   * Moves documents and notes a snapshot does not hold out of the way, when
   * their content is preserved elsewhere (see {@link preservedElsewhere}).
   * A document made here stays, and a local edit of one the cloud dropped is
   * kept under `.sync/conflicts/` first. A note only this device has stays,
   * and its own note an organization withholds becomes local-only. An inbox
   * file without a note ID, which the cloud cannot hold, stays too. A note
   * that stays only because the outbox holds it is recorded in
   * `snapshotKept`, so it is settled once the outbox lets it go (see
   * {@link settleSnapshotKept}).
   */
  async displaceUnlisted(
    snapshot: Pick<
      MemoryReplicaSnapshot,
      'revision' | 'cursor' | 'documents' | 'pendingNotes'
    >,
  ): Promise<void> {
    const listed = new Set(
      snapshot.documents.map((document) =>
        memoryDocumentIdentity(document.path),
      ),
    );
    const localDocuments = [
      MEMORY_INDEX_PATH,
      ...(await markdownNames(join(this.scopeDir, 'topics'))).map(
        (name) => `topics/${name}`,
      ),
    ];
    for (const path of localDocuments) {
      if (listed.has(memoryDocumentIdentity(path))) continue;
      const live = await readMemoryFile(join(this.scopeDir, path));
      if (live === null) continue;
      const preserved = await this.preservedElsewhere({
        kind: 'document',
        path,
        live,
      });
      if (!preserved && this.baseOf(path) === undefined) continue;
      await this.beforeDocumentWrite();
      if (!preserved) {
        await this.recordConflict(path, live, snapshot.revision, 'overlap');
      }
      await this.displace(path);
      await removeMemoryFile(
        this.scopeDir,
        join(memorySyncPrivateDir(this.scopeDir, 'base'), path),
      );
      this.result.documentsChanged += 1;
    }
    const pending = new Set(snapshot.pendingNotes.map((note) => note.noteId));
    const notes = await this.noteIndex();
    const displaced: Array<[string, LocalNote]> = [];
    // A pending import whose file is gone and that the cloud no longer holds
    // pending is retired too, so it stops claiming its path.
    const vanished: Array<[string, LocalNote]> = [];
    const keptForOutbox: string[] = [];
    for (const [noteId, local] of notes) {
      if (pending.has(noteId) || !claimsFileKey(local)) continue;
      if (await this.preservedElsewhere({ kind: 'note', noteId, local })) {
        (local.archived ? vanished : displaced).push([noteId, local]);
      } else if (!local.archived && this.isWithheldHere(local)) {
        this.keepLocalOnly(noteId);
      } else if (await this.keptOnlyForOutbox(noteId, local)) {
        keptForOutbox.push(noteId);
      }
    }
    this.recordSnapshotKept(snapshot.cursor, keptForOutbox);
    // Retired first: a crash before a move leaves a staged file that no
    // entry claims, which the next snapshot moves aside.
    await this.retireImports(
      [...displaced, ...vanished].flatMap(([noteId, local]) =>
        isImportFileKey(local.fileKey) ? [noteId] : [],
      ),
    );
    for (const [noteId] of vanished) notes.delete(noteId);
    for (const [noteId, local] of displaced) {
      await this.displace(local.fileKey);
      notes.delete(noteId);
      this.result.notesRemoved += 1;
    }
    // A staged file no live entry claims was retired here or left by a
    // crash before its ledger write; the cloud or its source still has it.
    const claimed = new Set(
      Object.values((await readImportState(this.scopeDir)).sources).flatMap(
        (entry) => (isLiveImportEntry(entry) ? [entry.stagedAs] : []),
      ),
    );
    for (const name of await markdownNames(join(this.scopeDir, 'imported'))) {
      if (!claimed.has(`imported/${name}`))
        await this.displace(`imported/${name}`);
    }
  }

  /** Moves a replica file into this apply's `.sync/displaced/` folder. */
  private async displace(relative: string): Promise<void> {
    this.displacedDir ??= join(
      memorySyncPrivateDir(this.scopeDir, 'displaced'),
      timestampSlug(this.options.now()),
    );
    await moveToFreeName(
      this.scopeDir,
      join(this.scopeDir, relative),
      join(this.displacedDir, dirname(relative)),
    );
  }

  /** A live inbox note a snapshot keeps for the outbox's sake alone. */
  private async keptOnlyForOutbox(
    noteId: string,
    local: LocalNote,
  ): Promise<boolean> {
    if (
      local.archived ||
      isImportFileKey(local.fileKey) ||
      this.state.localOnlyNoteIds.includes(noteId)
    ) {
      return false;
    }
    const outbox = await this.outboxNoteIds();
    return outbox.readable && outbox.held.has(noteId);
  }

  /** The state's kept notes when they are current at the replica's cursor. */
  private currentSnapshotKept(): SnapshotKept | undefined {
    const kept = this.state.snapshotKept;
    return kept !== undefined && kept.cursor === this.state.cursor
      ? kept
      : undefined;
  }

  /**
   * Records the notes a snapshot at `cursor` kept for the outbox alone,
   * keeping what a push already answered for those it kept before.
   */
  private recordSnapshotKept(cursor: string, noteIds: string[]): void {
    const before = new Map(
      (this.currentSnapshotKept()?.notes ?? []).map((entry) => [
        entry.noteId,
        entry,
      ]),
    );
    this.state.snapshotKept =
      noteIds.length === 0
        ? undefined
        : {
            cursor,
            notes: noteIds.map((noteId) => before.get(noteId) ?? { noteId }),
          };
  }

  /** Drops kept notes a page names: the feed speaks for them from now. */
  forgetSnapshotKept(noteIds: readonly string[]): void {
    const kept = this.currentSnapshotKept();
    if (kept === undefined) {
      this.state.snapshotKept = undefined;
      return;
    }
    const named = new Set(noteIds);
    this.state.snapshotKept = {
      ...kept,
      notes: kept.notes.filter((entry) => !named.has(entry.noteId)),
    };
  }

  /**
   * After a page that ends at `nextCursor`: settles the notes the last
   * snapshot kept for the outbox alone once the outbox no longer holds
   * them. One a push answered as new, refused or kept on this device has
   * left the list already. One answered as replayed may have been stored
   * before the snapshot, which found it no longer pending; once the feed
   * reaches the push without naming it, it goes as the snapshot would have
   * moved it aside, while its file still holds the body the push carried.
   * Other bytes of the note stay as a local-only note. The file moves
   * before `sync-state.json` drops its entry, so a replayed page finds it
   * gone and settles nothing twice.
   */
  async settleSnapshotKept(nextCursor: string): Promise<void> {
    const kept = this.currentSnapshotKept();
    if (kept === undefined) {
      this.state.snapshotKept = undefined;
      return;
    }
    const outbox = await this.outboxNoteIds();
    const left: SnapshotKept['notes'] = [];
    for (const entry of kept.notes) {
      const { replayed } = entry;
      const waiting =
        !outbox.readable ||
        outbox.held.has(entry.noteId) ||
        (replayed !== undefined &&
          replayed.cursor !== null &&
          (compareMemoryChangeCursors(nextCursor, replayed.cursor) ?? 0) < 0);
      if (waiting) {
        left.push(entry);
      } else if (replayed !== undefined) {
        await this.displaceReplayed(entry.noteId, replayed.contentHash);
      }
    }
    this.state.snapshotKept =
      left.length === 0 ? undefined : { cursor: nextCursor, notes: left };
  }

  private async displaceReplayed(
    noteId: string,
    contentHash: string,
  ): Promise<void> {
    const notes = await this.noteIndex();
    const local = notes.get(noteId);
    if (
      local === undefined ||
      local.archived ||
      this.state.localOnlyNoteIds.includes(noteId)
    ) {
      return;
    }
    if (this.isWithheldHere(local)) {
      this.keepLocalOnly(noteId);
      return;
    }
    const content = await readTextOrNull(local.path);
    if (content === null || memoryNoteId(content) !== noteId) return;
    const body = inboxNoteBody(content);
    if (body === null || sha256Hex(body) !== contentHash) {
      this.keepLocalOnly(noteId);
      return;
    }
    await this.displace(local.fileKey);
    notes.delete(noteId);
    this.result.notesRemoved += 1;
  }

  /**
   * Whether the outbox may hold a note: queued to be sent, or deleted here
   * meanwhile. While the outbox cannot be read, any note of this device's
   * may be in it.
   */
  private async outboxHolds(
    noteId: string,
    local: LocalNote,
  ): Promise<boolean> {
    const outbox = await this.outboxNoteIds();
    return outbox.held.has(noteId) || (!outbox.readable && local.own);
  }

  /** What the outbox holds and retires (tombstones or supersedes). */
  private async outboxNoteIds(): Promise<OutboxNotes> {
    if (this.outboxNotes === null) {
      const outbox = await readMemorySyncOutbox(
        this.scopeDir,
        this.state.binding,
      );
      const ops = (outbox?.ops ?? []).map((entry) => entry.op);
      this.outboxNotes = {
        readable: outbox !== null,
        held: new Set([
          ...ops.flatMap((op) =>
            op.op === 'tombstone' ? [] : [op.note.noteId],
          ),
          ...(outbox?.localDeletes ?? []).map((pending) => pending.noteId),
        ]),
        unsettled: new Set(
          (outbox?.localDeletes ?? []).map((pending) => pending.noteId),
        ),
        retired: new Set(
          ops.flatMap((op) => {
            if (op.op === 'tombstone') return [op.noteId];
            return op.note.supersedes === undefined ? [] : [op.note.supersedes];
          }),
        ),
      };
    }
    return this.outboxNotes;
  }
}

async function readBoundState(scopeDir: string): Promise<MemorySyncStateFile> {
  const state = await readMemorySyncState(scopeDir);
  if (state === undefined || state === null) {
    throw new MemoryReplicaGapError('state');
  }
  return state;
}

/**
 * Queues the notes that carry the conflicts an apply recorded to the next
 * consolidation (see {@link queueConflictNotes}), in the apply's lock. A
 * failure, such as an unreadable outbox, leaves them to the next pass.
 */
async function queueConflictNotesAfterApply(
  scopeDir: string,
  state: MemorySyncStateFile,
  apply: ReplicaApply,
  options: MemoryReplicaWriteOptions,
): Promise<void> {
  if (apply.result.conflicts === 0) return;
  await queueConflictNotes(
    scopeDir,
    state.binding,
    { deviceId: options.deviceId, label: options.deviceLabel },
    options.now(),
  ).catch(() => 0);
}

/**
 * Makes the replica hold exactly the snapshot: its documents at the pinned
 * revision and the notes pending at its cursor. Then records the cursor, so
 * pulling continues from there.
 */
export function applyMemoryReplicaSnapshot(
  scopeDir: string,
  snapshot: MemoryReplicaSnapshot,
  options: MemoryReplicaWriteOptions,
): Promise<MemoryReplicaApplyResult> {
  return withMemoryWriteLock(scopeDir, async () => {
    const state = await readBoundState(scopeDir);
    const apply = new ReplicaApply(scopeDir, state, options);
    state.baseDocuments = {};
    for (const document of snapshot.documents) {
      await apply.putDocument(
        document.path,
        document.content,
        document.contentHash,
        document.changedInRevision,
      );
    }
    for (const note of snapshot.pendingNotes) {
      await apply.writePendingNote(note);
    }
    await apply.displaceUnlisted(snapshot);
    await writeMemorySyncState(scopeDir, {
      ...state,
      cursor: snapshot.cursor,
      baseRevision: snapshot.revision,
      lastPulledAt: options.now().toISOString(),
    });
    await queueConflictNotesAfterApply(scopeDir, state, apply, options);
    return apply.result;
  });
}

/**
 * Applies one page of changes, pulled from the cursor the replica holds,
 * then records the page's next cursor. Rejects with
 * {@link MemoryReplicaGapError} when the page or a revision does not
 * continue from the replica's state.
 */
export function applyMemoryReplicaChanges(
  scopeDir: string,
  page: {
    fromCursor: string;
    nextCursor: string;
    changes: readonly MemoryChange[];
  },
  options: MemoryReplicaWriteOptions,
): Promise<MemoryReplicaApplyResult> {
  return withMemoryWriteLock(scopeDir, async () => {
    const state = await readBoundState(scopeDir);
    if (state.cursor !== page.fromCursor) {
      throw new MemoryReplicaGapError('cursor_mismatch');
    }
    const apply = new ReplicaApply(scopeDir, state, options);
    for (const change of page.changes) {
      switch (change.kind) {
        case 'note_put':
          apply.forgetSnapshotKept([change.note.noteId]);
          await apply.applyNotePut(change.note);
          break;
        case 'note_removed':
          apply.forgetSnapshotKept([change.noteId]);
          await apply.removeNote(change.noteId, change.reason);
          break;
        case 'revision':
          apply.forgetSnapshotKept(change.consumedNoteIds);
          await apply.applyRevision(change);
          break;
        case 'scope_updated':
          break;
      }
    }
    await apply.settleSnapshotKept(page.nextCursor);
    await writeMemorySyncState(scopeDir, {
      ...state,
      cursor: page.nextCursor,
      lastPulledAt: options.now().toISOString(),
    });
    await queueConflictNotesAfterApply(scopeDir, state, apply, options);
    return apply.result;
  });
}

/**
 * Applies a revision this replica committed itself, through the same steps
 * as a pulled one, so the later feed entry for it is a no-op. For a manual
 * edit the live documents are left as they are: they hold what was
 * committed, or a newer edit that the next commit sends.
 */
export function applyMemoryReplicaCommit(
  scopeDir: string,
  commit: {
    revision: MemoryRevisionRecord;
    changes: readonly MemoryDocumentChange[];
    consumedNoteIds: readonly string[];
    keepLiveDocuments: boolean;
  },
  options: MemoryReplicaWriteOptions,
): Promise<MemoryReplicaApplyResult> {
  return withMemoryWriteLock(scopeDir, async () => {
    const state = await readBoundState(scopeDir);
    const apply = new ReplicaApply(scopeDir, state, options);
    apply.keepLiveDocuments = commit.keepLiveDocuments;
    await apply.applyRevision({
      kind: 'revision',
      seq: '0',
      revision: commit.revision,
      changes: [...commit.changes],
      consumedNoteIds: [...commit.consumedNoteIds],
    });
    await writeMemorySyncState(scopeDir, state);
    await queueConflictNotesAfterApply(scopeDir, state, apply, options);
    return apply.result;
  });
}

/**
 * A note a leased consolidation may consume, by the file key it is read
 * from: its ID and, for an import, the hash of the body the cloud holds
 * (an inbox note carries its ID in its own content).
 */
export interface MemoryConsumableNote {
  noteId: string;
  contentHash: string | null;
}

/**
 * The notes a leased consolidation may consume: those the cloud holds as
 * pending. A note still queued for sync, kept on this device only, deleted
 * or edited here and not settled yet, one the last snapshot kept for the
 * outbox (the cloud may have consolidated it before that snapshot), or an
 * import this device staged and never sent is left for a later run (the
 * cloud refuses to consume a note it does not hold). While the outbox cannot be read, any note of this
 * device's may still be queued, as a snapshot assumes too. Only a pending
 * import claims its staged path, as in {@link indexImports}. A note whose
 * organization keeps it off the cloud is left out too: the cloud still
 * lists one the sweep has not withheld yet, and cloud consolidation leaves
 * it out by the same rule.
 */
export async function listConsumableNotes(
  scopeDir: string,
  origins: MemoryOriginPolicy,
): Promise<Map<string, MemoryConsumableNote>> {
  const state = await readBoundState(scopeDir);
  const outbox = await readMemorySyncOutbox(scopeDir, state.binding);
  const held = new Set([
    ...state.localOnlyNoteIds,
    ...(outbox?.ops ?? []).flatMap((entry) =>
      entry.op.op === 'tombstone'
        ? [entry.op.noteId]
        : [
            entry.op.note.noteId,
            ...(entry.op.note.supersedes === undefined
              ? []
              : [entry.op.note.supersedes]),
          ],
    ),
    ...(outbox?.localDeletes ?? []).map((pending) => pending.noteId),
    ...(state.snapshotKept?.cursor === state.cursor
      ? state.snapshotKept.notes.map((entry) => entry.noteId)
      : []),
  ]);
  const notes = new Map<string, MemoryConsumableNote>();
  for (const [noteId, local] of await indexLocalNotes(
    scopeDir,
    state.deviceId,
  )) {
    if (
      !local.archived &&
      local.fileKey.startsWith('inbox/') &&
      !held.has(noteId) &&
      (outbox !== null || !local.own) &&
      !isMemoryNoteOriginBlocked(origins, local.originOrganizationId)
    ) {
      notes.set(local.fileKey, { noteId, contentHash: null });
    }
  }
  const imports = await readImportState(scopeDir);
  for (const [source, entry] of Object.entries(imports.sources)) {
    if (
      source.startsWith(IMPORT_SYNC_SOURCE_PREFIX) &&
      isLiveImportEntry(entry) &&
      entry.consolidatedAt === undefined &&
      entry.noteId !== undefined &&
      !held.has(entry.noteId) &&
      (await exists(join(scopeDir, entry.stagedAs)))
    ) {
      notes.set(entry.stagedAs, {
        noteId: entry.noteId,
        contentHash: entry.fileHash,
      });
    }
  }
  return notes;
}
