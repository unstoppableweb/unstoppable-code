import {
  access,
  lstat,
  readFile,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { LocalMemoryScopeRequest } from '@canopy/desktop-shared/types';
import {
  findChatHistoryProfileIndexLine,
  isChatHistoryProfileTopic,
} from '@canopy/memory-consolidation/chat-history-profile';
import type { RunConsolidationResult } from './consolidation-task';
import {
  inspectImportState,
  writeImportState,
  writeImportStateRaw,
  type ImportState,
  type ImportStateInspection,
  type ImportStateStagedEntry,
} from './import/ledger';
import { listPendingInboxNotes, listPendingSources } from './pending-sources';
import {
  listTopicFilenames,
  type LocalMemoryState,
  type LocalMemoryWriteGuard,
} from './snapshots';
import {
  assertMemoryPathContained,
  assertMemoryScopeLockHeld,
  ensureOwnerOnlyMemoryDir,
  isMemoryMarkdownFileName,
  moveWithoutReplacing,
} from './memory-files';
import { memoryNoteId } from './note-identity';

/** Upper bound on consolidation runs one rebuild performs. */
export const MAX_REBUILD_CONSOLIDATION_RUNS = 100;

const ARCHIVE_DIRNAME = '.consolidated';
const PRUNED_TOPIC_ARCHIVE_PREFIX = 'topic-';

// Why a rebuild refused before changing anything. Each is a fragment shown
// after "Couldn't finish rebuilding memories: " (docs/ux-writing.md).
export const REBUILD_IMPORT_LEDGER_UNREADABLE_REASON =
  "the record of imported memories couldn't be read, so nothing was changed";
export const REBUILD_IMPORT_LEDGER_MISSING_REASON =
  'the record of imported memories is missing, so nothing was changed';
export const REBUILD_IMPORTS_NOT_RECORDED_REASON =
  "some imported memories aren't in the record of imported memories yet, so nothing was changed";
export const REBUILD_SOURCES_UNREADABLE_REASON =
  "saved notes or imports couldn't be read, so nothing was changed";
export const REBUILD_SOURCES_NOT_RESTORED_REASON =
  "some saved notes or imports couldn't be put back, so nothing was changed";
export const REBUILD_IMPORTS_NOT_RESTAGED_REASON =
  "an imported memory couldn't be staged again from its original, so nothing was changed";
export const REBUILD_IMPORT_MOVED_REASON =
  "an imported memory no longer belongs in these memories, or its project's settings no longer allow it, so nothing was changed";
export const REBUILD_IMPORT_ORIGIN_UNKNOWN_REASON =
  "an imported memory doesn't record which project it came from, so its project's settings can't be checked and nothing was changed";

export function rebuildUnrecoverableImportsReason(count: number): string {
  return count === 1
    ? 'an imported memory has no saved copy to rebuild from, so nothing was changed'
    : `${count} imported memories have no saved copy to rebuild from, so nothing was changed`;
}

export interface RestoredConsolidatedSources {
  inboxNotes: number;
  imports: number;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
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

/** A file a restore or rebuild replaces, deletes or moves, as a revision sees it. */
export interface MemoryReplacementFile {
  fileKey: string;
  modifiedAt: string;
  sizeBytes: number;
}

/**
 * Every file a restore or rebuild of the scope replaces, deletes or moves:
 * the index, each topic a snapshot keeps and the inbox and import notes,
 * pending or consolidated. By name and file status only, with no lock and no
 * backfill, so a caller holding the scope's write lock can read it (CAN-6005).
 */
export async function listMemoryReplacementFiles(
  scopeDir: string,
): Promise<MemoryReplacementFile[]> {
  const fileKeys = [
    'MEMORY.md',
    ...(await listTopicFilenames(scopeDir)).map((name) => `topics/${name}`),
  ];
  for (const folder of [
    'inbox',
    `inbox/${ARCHIVE_DIRNAME}`,
    'imported',
    `imported/${ARCHIVE_DIRNAME}`,
  ])
    for (const name of await listMarkdownFiles(join(scopeDir, folder)))
      fileKeys.push(`${folder}/${name}`);
  const files: MemoryReplacementFile[] = [];
  for (const fileKey of fileKeys.sort()) {
    try {
      const entry = await lstat(join(scopeDir, fileKey));
      if (entry.isFile())
        files.push({
          fileKey,
          modifiedAt: entry.mtime.toISOString(),
          sizeBytes: entry.size,
        });
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }
  return files;
}

function markdownStem(filename: string): string {
  return filename.slice(0, -'.md'.length);
}

/** Puts a moved file back under its archived name, which is still free. */
async function moveBack(scopeDir: string, move: SourceMove): Promise<void> {
  await moveWithoutReplacing(scopeDir, move.to, move.from);
}

interface SourceMove {
  from: string;
  to: string;
}

/**
 * Moves archived inbox notes back to the pending inbox under their archived
 * name, or the next free `-N` name when a different note holds it. An
 * archived note identical to the pending one stays archived, unless it
 * carries a note ID: then the pending file is that note, as an earlier
 * restore cut short after its copy leaves it, and only the archived copy
 * goes, so the note stays in one file. Topics the prune pass archived
 * (`topic-*`) stay archived: they were retired for disuse, not consumed as
 * source material.
 */
async function restoreArchivedInboxNotes(
  scopeDir: string,
  moves: SourceMove[],
): Promise<Set<string>> {
  const inboxDir = join(scopeDir, 'inbox');
  const archiveDir = join(inboxDir, ARCHIVE_DIRNAME);
  const duplicates = new Set<string>();
  const archived = (await listMarkdownFiles(archiveDir)).filter(
    (name) => !name.startsWith(PRUNED_TOPIC_ARCHIVE_PREFIX),
  );
  if (archived.length === 0) return duplicates;
  await ensureOwnerOnlyMemoryDir(scopeDir, inboxDir);
  for (const filename of archived) {
    const source = join(archiveDir, filename);
    for (let suffix = 1; ; suffix += 1) {
      const candidate =
        suffix === 1 ? filename : `${markdownStem(filename)}-${suffix}.md`;
      const destination = join(inboxDir, candidate);
      try {
        await moveWithoutReplacing(scopeDir, source, destination);
        moves.push({ from: source, to: destination });
        break;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
      const [archivedText, pendingText] = await Promise.all([
        readFile(source, 'utf8'),
        readFile(destination, 'utf8'),
      ]);
      if (archivedText === pendingText) {
        if (memoryNoteId(archivedText) === null) {
          duplicates.add(filename);
          break;
        }
        await assertMemoryPathContained(scopeDir, source);
        await assertMemoryScopeLockHeld();
        await unlink(source);
        moves.push({ from: source, to: destination });
        break;
      }
    }
  }
  return duplicates;
}

/**
 * The archived copy of a staged import. Archiving adds `-N` when the plain
 * name is taken, always choosing the first free suffix, so the highest suffix
 * is the most recent copy.
 */
function archivedImportFor(
  archived: readonly string[],
  stagedFilename: string,
): string | null {
  const stem = markdownStem(stagedFilename);
  let best: { name: string; suffix: number } | null = null;
  for (const name of archived) {
    let suffix: number | null = null;
    if (name === stagedFilename) {
      suffix = 1;
    } else if (name.startsWith(`${stem}-`) && name.endsWith('.md')) {
      const tail = markdownStem(name).slice(stem.length + 1);
      if (/^[1-9]\d*$/.test(tail)) suffix = Number(tail);
    }
    if (suffix !== null && (best === null || suffix > best.suffix)) {
      best = { name, suffix };
    }
  }
  return best?.name ?? null;
}

/**
 * A consolidated import whose staged file and archived copy are both gone
 * but whose original file still exists: a rebuild stages it again from the
 * original before it changes anything.
 */
export interface ImportRestage {
  sourcePath: string;
  entry: ImportStateStagedEntry;
}

/**
 * How a rebuild returns archived imports to `imported/`, decided from the
 * stored ledger before anything changes.
 */
export interface ImportRestorePlan {
  /**
   * `imported/<name>` paths already staged when the plan was made. They stay
   * where they are, and the rebuild's drain must still consume them.
   */
  staged: string[];
  restores: Array<{ archived: string; stagedAs: string }>;
  /** Imports to stage again from their originals before anything changes. */
  restages: ImportRestage[];
  /** The ledger to write once the copies are back; null when unchanged. */
  ledger: ImportState | null;
  /** The ledger's bytes before the rebuild, written back on undo. */
  originalLedger: string | null;
}

export type SourceRestorePlan =
  | { ok: true; imports: ImportRestorePlan }
  | { ok: false; reason: string };

async function sourceFileExists(sourcePath: string): Promise<boolean> {
  if (!isAbsolute(sourcePath)) return false;
  try {
    await access(sourcePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * How many import files a rebuild could clear the memory of that the ledger
 * cannot account for. This is the one rule every ledger state goes through,
 * so a missing, unreadable, and readable ledger cannot disagree about which
 * files block a rebuild:
 * - Without a readable ledger (missing or invalid), no import file is
 *   accounted for, staged or archived.
 * - With one, a staged file must be named by an entry: consolidation skips
 *   any other, so its content would never be rebuilt. An archived file is
 *   either the copy an entry restores or a revision the ledger has already
 *   replaced, which stays archived; both are accounted for.
 */
function unmappedImportFileCount(
  ledger: ImportStateInspection,
  staged: readonly string[],
  archived: readonly string[],
): number {
  if (ledger.kind !== 'present') return staged.length + archived.length;
  const named = new Set<string>();
  for (const entry of Object.values(ledger.state.sources)) {
    if ('stagedAs' in entry) named.add(entry.stagedAs);
  }
  return staged.filter((filename) => !named.has(`imported/${filename}`)).length;
}

function unmappedImportsReason(ledger: ImportStateInspection): string {
  switch (ledger.kind) {
    case 'missing':
      return REBUILD_IMPORT_LEDGER_MISSING_REASON;
    case 'invalid':
      return REBUILD_IMPORT_LEDGER_UNREADABLE_REASON;
    case 'present':
      return REBUILD_IMPORTS_NOT_RECORDED_REASON;
  }
}

/**
 * Checks, without changing anything, that a rebuild can put back every
 * import it is about to clear the memory of. The ledger is read as stored:
 * an unreadable one is never treated as "no imports" (the ledger reader
 * would quarantine it and report an empty ledger). Refuses when any staged
 * or archived import file cannot be mapped to the ledger (see
 * {@link unmappedImportFileCount}), or when a consolidated import has
 * neither a staged file, an archived copy, nor an original file. A
 * consolidated import with only its original left is planned as a restage
 * ({@link stageImportOriginalsAgain}); the plan leaves its ledger entry as is.
 */
export async function planConsolidatedSourceRestore(
  scopeDir: string,
): Promise<SourceRestorePlan> {
  // Listing both archives first also proves they are readable.
  await listMarkdownFiles(join(scopeDir, 'inbox', ARCHIVE_DIRNAME));
  const archived = await listMarkdownFiles(
    join(scopeDir, 'imported', ARCHIVE_DIRNAME),
  );
  const staged = await listMarkdownFiles(join(scopeDir, 'imported'));
  const ledger = await inspectImportState(scopeDir);
  if (unmappedImportFileCount(ledger, staged, archived) > 0) {
    return { ok: false, reason: unmappedImportsReason(ledger) };
  }
  if (ledger.kind !== 'present') {
    // No import file exists, so there is nothing to put back.
    return {
      ok: true,
      imports: {
        staged: [],
        restores: [],
        restages: [],
        ledger: null,
        originalLedger: null,
      },
    };
  }
  const state: ImportState = {
    version: 1,
    sources: { ...ledger.state.sources },
  };
  const restores: ImportRestorePlan['restores'] = [];
  const restages: ImportRestage[] = [];
  const claimed = new Set<string>();
  let unrecoverable = 0;
  let changed = false;
  for (const [sourcePath, entry] of Object.entries(ledger.state.sources)) {
    if (!('stagedAs' in entry)) continue;
    const { consolidatedAt, ...pendingEntry } = entry;
    if (await exists(join(scopeDir, entry.stagedAs))) {
      if (consolidatedAt !== undefined) {
        state.sources[sourcePath] = pendingEntry;
        changed = true;
      }
      continue;
    }
    const copy = archivedImportFor(
      archived.filter((name) => !claimed.has(name)),
      basename(entry.stagedAs),
    );
    if (copy !== null) {
      claimed.add(copy);
      restores.push({ archived: copy, stagedAs: entry.stagedAs });
      state.sources[sourcePath] = pendingEntry;
      changed = true;
    } else if (consolidatedAt !== undefined) {
      if (!(await sourceFileExists(sourcePath))) {
        unrecoverable += 1;
        continue;
      }
      restages.push({ sourcePath, entry });
    }
  }
  if (unrecoverable > 0) {
    return {
      ok: false,
      reason: rebuildUnrecoverableImportsReason(unrecoverable),
    };
  }
  return {
    ok: true,
    imports: {
      staged: staged.map((filename) => `imported/${filename}`),
      restores,
      restages,
      ledger: changed ? state : null,
      originalLedger: ledger.raw,
    },
  };
}

export interface StagedImportOriginals {
  /** `imported/<name>` paths staged from originals. */
  stagedImports: string[];
  /**
   * Deletes the staged files and writes the ledger back as it was; resolves
   * false when something could not be put back.
   */
  undo: () => Promise<boolean>;
}

/**
 * Stages each planned import again from its original file with the
 * importer's own staging, and records the new pending ledger entries. This
 * adds sources and changes no memory; a failure part way undoes what it
 * staged and rejects, so a rebuild refuses with nothing changed.
 */
export async function stageImportOriginalsAgain(
  scopeDir: string,
  target: LocalMemoryScopeRequest,
  restages: readonly ImportRestage[],
): Promise<StagedImportOriginals> {
  const ledger = await inspectImportState(scopeDir);
  if (ledger.kind !== 'present') {
    throw new Error('The import ledger changed before imports were staged.');
  }
  // Kept off the startup import path: only a rebuild stages originals.
  const { ImportRestageRefusedError, restageImportSource } =
    await import('./import/import-runner');
  const stagedImports: string[] = [];
  let ledgerWritten = false;
  const undo = async (): Promise<boolean> => {
    const failures: unknown[] = [];
    for (const stagedAs of stagedImports) {
      await unlinkIfPresent(join(scopeDir, stagedAs)).catch((error: unknown) =>
        failures.push(error),
      );
    }
    stagedImports.length = 0;
    if (ledgerWritten) {
      await writeImportStateRaw(scopeDir, ledger.raw).catch((error: unknown) =>
        failures.push(error),
      );
    }
    for (const failure of failures) {
      process.emitWarning(
        failure instanceof Error ? failure.message : String(failure),
        { code: 'LOCAL_MEMORY_REBUILD_UNDO_FAILED' },
      );
    }
    return failures.length === 0;
  };
  const state: ImportState = {
    version: 1,
    sources: { ...ledger.state.sources },
  };
  try {
    for (const { sourcePath } of restages) {
      const current = state.sources[sourcePath];
      if (current === undefined || !('stagedAs' in current)) {
        throw new Error(
          'The import ledger changed before imports were staged.',
        );
      }
      const entry = await restageImportSource({
        scopeDir,
        target,
        sourcePath,
        previous: current,
      });
      stagedImports.push(entry.stagedAs);
      state.sources[sourcePath] = entry;
    }
    ledgerWritten = true;
    await writeImportState(scopeDir, state);
  } catch (error) {
    throw new SourceRestoreError(
      error,
      await undo(),
      error instanceof ImportRestageRefusedError
        ? error.kind === 'moved'
          ? REBUILD_IMPORT_MOVED_REASON
          : REBUILD_IMPORT_ORIGIN_UNKNOWN_REASON
        : undefined,
    );
  }
  return { stagedImports: [...stagedImports], undo };
}

export interface RestoredSourcesHandle extends RestoredConsolidatedSources {
  /** `imported/<name>` paths this restore put back. */
  restoredImports: string[];
  /** Archived inbox notes left archived because the same note is pending. */
  duplicateInboxNotes: Set<string>;
  /**
   * Puts every source back in its archive and the ledger back as it was;
   * resolves false when something could not be put back.
   */
  undo: () => Promise<boolean>;
}

/**
 * Returns archived inbox notes and the planned imports to the pending queue
 * and writes the planned ledger. A failure part way undoes what was moved.
 */
export async function restoreConsolidatedSources(
  scopeDir: string,
  plan: ImportRestorePlan,
): Promise<RestoredSourcesHandle> {
  const moves: SourceMove[] = [];
  let ledgerWritten = false;
  const undo = async (): Promise<boolean> => {
    const failures: unknown[] = [];
    for (const move of [...moves].reverse()) {
      await moveBack(scopeDir, move).catch((error: unknown) =>
        failures.push(error),
      );
    }
    moves.length = 0;
    if (ledgerWritten && plan.originalLedger !== null) {
      await writeImportStateRaw(scopeDir, plan.originalLedger).catch(
        (error: unknown) => failures.push(error),
      );
    }
    for (const failure of failures) {
      process.emitWarning(
        failure instanceof Error ? failure.message : String(failure),
        { code: 'LOCAL_MEMORY_REBUILD_UNDO_FAILED' },
      );
    }
    return failures.length === 0;
  };
  try {
    const duplicateInboxNotes = await restoreArchivedInboxNotes(
      scopeDir,
      moves,
    );
    const inboxNotes = moves.length;
    const archiveDir = join(scopeDir, 'imported', ARCHIVE_DIRNAME);
    for (const restore of plan.restores) {
      await ensureOwnerOnlyMemoryDir(scopeDir, join(scopeDir, 'imported'));
      const from = join(archiveDir, restore.archived);
      const to = join(scopeDir, restore.stagedAs);
      await moveWithoutReplacing(scopeDir, from, to);
      moves.push({ from, to });
    }
    if (plan.ledger !== null) {
      ledgerWritten = true;
      await writeImportState(scopeDir, plan.ledger);
    }
    return {
      inboxNotes,
      imports: plan.restores.length,
      restoredImports: plan.restores.map((restore) => restore.stagedAs),
      duplicateInboxNotes,
      undo,
    };
  } catch (error) {
    throw new SourceRestoreError(error, await undo());
  }
}

/**
 * A source restore that failed; `undone` says whether it was rolled back,
 * and `reason`, when set, why a rebuild should say it refused.
 */
export class SourceRestoreError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause: unknown;

  constructor(
    cause: unknown,
    readonly undone: boolean,
    readonly reason?: string,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
    this.name = 'SourceRestoreError';
  }
}

/**
 * Whether nothing a rebuild should have put back is still archived: every
 * archived inbox note left is a duplicate of a pending one, and the ledger
 * plans no further import restores.
 */
export async function consolidatedSourcesFullyRestored(
  scopeDir: string,
  restored: RestoredSourcesHandle,
): Promise<boolean> {
  const archivedNotes = (
    await listMarkdownFiles(join(scopeDir, 'inbox', ARCHIVE_DIRNAME))
  ).filter((name) => !name.startsWith(PRUNED_TOPIC_ARCHIVE_PREFIX));
  if (archivedNotes.some((name) => !restored.duplicateInboxNotes.has(name))) {
    return false;
  }
  const plan = await planConsolidatedSourceRestore(scopeDir);
  return (
    plan.ok &&
    plan.imports.restores.length === 0 &&
    plan.imports.restages.length === 0 &&
    plan.imports.ledger === null
  );
}

export const REBUILD_SOURCES_MISSING_REASON =
  'some saved notes or imports went missing before they were rebuilt';

/** Which file a tracked source is, kept across renames into the archive. */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

async function fileIdentity(filePath: string): Promise<FileIdentity | null> {
  try {
    const info = await stat(filePath, { bigint: true });
    return info.isFile() ? { dev: info.dev, ino: info.ino } : null;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function archiveIdentities(directory: string): Promise<FileIdentity[]> {
  const identities: FileIdentity[] = [];
  for (const name of await listMarkdownFiles(directory)) {
    const identity = await fileIdentity(join(directory, name));
    if (identity !== null) identities.push(identity);
  }
  return identities;
}

/** The ledger as stored (never quarantined); null when it cannot be used. */
async function readLedgerOrNull(scopeDir: string): Promise<ImportState | null> {
  try {
    const ledger = await inspectImportState(scopeDir);
    return ledger.kind === 'present' ? ledger.state : null;
  } catch {
    return null;
  }
}

/** The consolidation stamp of the ledger entry staged as `stagedAs`. */
function consolidationStamp(
  ledger: ImportState | null,
  stagedAs: string,
): string | undefined {
  for (const entry of Object.values(ledger?.sources ?? {})) {
    if ('stagedAs' in entry && entry.stagedAs === stagedAs) {
      return entry.consolidatedAt;
    }
  }
  return undefined;
}

interface TrackedSource {
  /** The file as last seen in the pending queue; null if never seen. */
  identity: FileIdentity | null;
  /** Imports only: the ledger stamp when tracking began. */
  initialStamp: string | undefined;
}

export interface RebuildPendingCount {
  total: number;
  /** The rebuild's imports that are staged but consolidation cannot use. */
  unusableRebuildImports: number;
}

/** Stops the drain: a tracked source is gone and was never consumed. */
export interface DrainPendingStop {
  stop: string;
}

export interface RebuildSourceTracker {
  /**
   * Sources still pending, or a stop when a tracked source left the pending
   * queue without being verifiably consumed.
   */
  count: () => Promise<RebuildPendingCount | DrainPendingStop>;
  /** Records a finished run; only successful runs consume sources. */
  recordRun: (result: RunConsolidationResult) => void;
}

/**
 * Tracks, by identity, every source a rebuild's drain must consume: each
 * inbox note pending once sources are restored, and each of the rebuild's
 * imports (already staged, restored, or staged again). A tracked source
 * stays unresolved until it is verifiably consumed: an import whose ledger
 * entry gained a consolidation stamp, or a file that a successful run moved
 * into its archive (the same file, found by device and inode). A tracked
 * source missing from the pending queue without either stops the drain, so
 * a rebuild is never reported finished while a source silently dropped out.
 *
 * Counts pending inbox notes and usable imports, plus the rebuild's imports
 * that are staged but unusable (for example, the ledger became unreadable).
 */
export async function trackRebuildSources(
  scopeDir: string,
  rebuildImports: readonly string[],
): Promise<RebuildSourceTracker> {
  const rebuilding = new Set(rebuildImports);
  const ledgerAtStart = await readLedgerOrNull(scopeDir);
  const tracked = new Map<string, TrackedSource>();
  for (const name of await listPendingInboxNotes(scopeDir)) {
    tracked.set(`inbox/${name}`, {
      identity: await fileIdentity(join(scopeDir, 'inbox', name)),
      initialStamp: undefined,
    });
  }
  for (const fileKey of Array.from(rebuilding)) {
    tracked.set(fileKey, {
      identity: await fileIdentity(join(scopeDir, fileKey)),
      initialStamp: consolidationStamp(ledgerAtStart, fileKey),
    });
  }
  let successfulRuns = 0;

  const count = async (): Promise<RebuildPendingCount | DrainPendingStop> => {
    const pending = await listPendingSources(scopeDir);
    const present = new Set([
      ...pending.inboxFiles.map((name) => `inbox/${name}`),
      ...pending.imports.map((source) => source.fileKey),
      ...pending.unusableImports.map((name) => `imported/${name}`),
    ]);
    let ledger: ImportState | null | undefined;
    const archives = new Map<string, FileIdentity[]>();
    const archived = async (fileKey: string): Promise<FileIdentity[]> => {
      const folder = fileKey.startsWith('imported/') ? 'imported' : 'inbox';
      const known = archives.get(folder);
      if (known !== undefined) return known;
      const identities = await archiveIdentities(
        join(scopeDir, folder, ARCHIVE_DIRNAME),
      );
      archives.set(folder, identities);
      return identities;
    };
    const consumed = async (
      fileKey: string,
      source: TrackedSource,
    ): Promise<boolean> => {
      if (fileKey.startsWith('imported/')) {
        ledger ??= await readLedgerOrNull(scopeDir);
        const stamp = consolidationStamp(ledger, fileKey);
        if (stamp !== undefined && stamp !== source.initialStamp) return true;
      }
      const identity = source.identity;
      if (successfulRuns === 0 || identity === null) return false;
      return (await archived(fileKey)).some(
        (candidate) =>
          candidate.dev === identity.dev && candidate.ino === identity.ino,
      );
    };

    let unresolved = 0;
    for (const [fileKey, source] of Array.from(tracked)) {
      if (present.has(fileKey)) {
        const identity = await fileIdentity(join(scopeDir, fileKey));
        if (identity !== null) {
          source.identity = identity;
          continue;
        }
      }
      if (await consumed(fileKey, source)) tracked.delete(fileKey);
      else unresolved += 1;
    }
    if (unresolved > 0) return { stop: REBUILD_SOURCES_MISSING_REASON };

    const unusableRebuildImports = pending.unusableImports.filter((name) =>
      rebuilding.has(`imported/${name}`),
    ).length;
    return {
      total:
        pending.inboxFiles.length +
        pending.imports.length +
        unusableRebuildImports,
      unusableRebuildImports,
    };
  };

  return {
    count,
    recordRun: (result: RunConsolidationResult): void => {
      if (result.status === 'success') successfulRuns += 1;
    },
  };
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await assertMemoryScopeLockHeld();
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

/**
 * The state {@link clearConsolidatedMemory} leaves when it starts from
 * `prior`: only the chat history profile topic, and an index holding only
 * the line that links it (no index when there is no profile to keep). A
 * failed clear's rollback accepts the scope anywhere between `prior` and
 * this state.
 */
export function consolidatedMemoryClearedState(
  prior: LocalMemoryState,
): LocalMemoryState {
  const topicFiles = prior.topicFiles.filter((topic) =>
    isChatHistoryProfileTopic(topic.filename),
  );
  const profileLine =
    topicFiles.length > 0
      ? findChatHistoryProfileIndexLine(prior.memoryMd ?? '')
      : undefined;
  return {
    memoryMd: profileLine === undefined ? null : `${profileLine}\n`,
    topicFiles,
  };
}

/**
 * Deletes every topic a snapshot captures and the index, keeping only the
 * generated chat history profile topic and the index line that links it
 * (see {@link consolidatedMemoryClearedState}). The kept index is staged
 * before the first deletion, and every change goes through `guard`: callers
 * snapshot first and pass the guard of a `runVerifiedLocalMemoryWrite`
 * against the snapshotted state. Files a snapshot skips (hidden or
 * non-regular files) are left alone.
 */
export async function clearConsolidatedMemory(
  scopeDir: string,
  guard: LocalMemoryWriteGuard,
): Promise<void> {
  const indexPath = join(scopeDir, 'MEMORY.md');
  let memoryMd = '';
  try {
    memoryMd = await readFile(indexPath, 'utf8');
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  const topics = await listTopicFilenames(scopeDir);
  const profileKept = topics.some(isChatHistoryProfileTopic);
  const profileLine = profileKept
    ? findChatHistoryProfileIndexLine(memoryMd)
    : undefined;
  const index =
    profileLine === undefined
      ? null
      : await guard.stage(indexPath, `${profileLine}\n`);
  for (const filename of topics) {
    if (isChatHistoryProfileTopic(filename)) continue;
    await guard.remove(join(scopeDir, 'topics', filename));
  }
  if (index === null) await guard.remove(indexPath);
  else await guard.replace(index);
}

export interface DrainConsolidationOptions {
  runOnce: () => Promise<RunConsolidationResult>;
  /**
   * Sources still pending; a {@link DrainPendingStop} stops the drain with
   * its reason, before the next run or instead of completing.
   */
  countPending: () => Promise<number | DrainPendingStop>;
  /** Checked before each run; a false answer stops with `stopReason`. */
  mayContinue?: () => Promise<boolean>;
  stopReason?: string;
  onRun?: (result: RunConsolidationResult) => Promise<void>;
  maxRuns?: number;
}

export interface DrainConsolidationOutcome {
  status: 'completed' | 'stopped';
  reason?: string;
  runs: number;
}

/**
 * Consolidates until nothing is pending. Completion is always decided by a
 * fresh pending count, never by the run status alone: a run can find the
 * scope `clean` while a note too large for the input budget stays queued.
 * Stops at the first run that does not succeed, at a `clean` run that leaves
 * sources it cannot consume, at a successful run that leaves as much
 * pending as before, which would otherwise repeat forever, and whenever the
 * count reports a stop (a tracked source that is gone but not consumed).
 */
export async function drainConsolidation(
  options: DrainConsolidationOptions,
): Promise<DrainConsolidationOutcome> {
  const maxRuns = options.maxRuns ?? MAX_REBUILD_CONSOLIDATION_RUNS;
  const initial = await options.countPending();
  if (typeof initial !== 'number') {
    return { status: 'stopped', reason: initial.stop, runs: 0 };
  }
  let pending = initial;
  let runs = 0;
  while (runs < maxRuns) {
    if (options.mayContinue && !(await options.mayContinue())) {
      return {
        status: 'stopped',
        reason: options.stopReason ?? 'cancelled',
        runs,
      };
    }
    let result: RunConsolidationResult;
    try {
      result = await options.runOnce();
    } catch (error) {
      result = {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    runs += 1;
    await options.onRun?.(result);
    if (result.status !== 'success' && result.status !== 'clean') {
      return {
        status: 'stopped',
        reason: result.reason ?? result.status,
        runs,
      };
    }
    const remaining = await options.countPending();
    if (typeof remaining !== 'number') {
      return { status: 'stopped', reason: remaining.stop, runs };
    }
    if (remaining === 0) return { status: 'completed', runs };
    if (result.status === 'clean') {
      return { status: 'stopped', reason: 'undrainable', runs };
    }
    if (remaining >= pending) {
      return { status: 'stopped', reason: 'no-progress', runs };
    }
    pending = remaining;
  }
  return { status: 'stopped', reason: 'too-many-runs', runs };
}
