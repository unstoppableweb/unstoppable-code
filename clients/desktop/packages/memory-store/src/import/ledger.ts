import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isMemoryUlid } from '@canopy/protocol/memory-sync';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import { writeMemoryFileAtomically } from '../memory-files';
import type { MemoryImportSourceTool } from '@canopy/memory-consolidation/input-budget';

const IMPORT_STATE_FILENAME = 'import-state.json';
const IMPORT_STATE_VERSION = 1;

export type ImportSkipReason = 'oversize' | 'undrainable' | 'deferred';

export interface ImportStateStagedEntry {
  fileHash: string;
  importedAt: string;
  checkedAt?: string;
  stagedAs: string;
  repo?: string;
  /** The project the source was imported from, when there was one. */
  workspaceId?: string;
  modified?: string;
  consolidatedAt?: string;
  sourceTool?: MemoryImportSourceTool;
  /** The import's note ID; its content stays verbatim, without front matter. */
  noteId?: string;
  /**
   * When the note was deleted, tombstoned, superseded or withheld here. A
   * retired entry no longer claims its staged path, so a later import may
   * be staged there; it stays so that an unchanged source is not imported
   * again.
   */
  retiredAt?: string;
}

export interface ImportStateSkipEntry {
  checkedAt: string;
  skipReason: ImportSkipReason;
}

export type ImportStateEntry = ImportStateStagedEntry | ImportStateSkipEntry;

export interface ImportState {
  version: 1;
  sources: Record<string, ImportStateEntry>;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isImportStateStagedEntry(
  value: unknown,
): value is ImportStateStagedEntry {
  return (
    isRecord(value) &&
    typeof value.fileHash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.fileHash) &&
    isTimestamp(value.importedAt) &&
    (value.checkedAt === undefined || isTimestamp(value.checkedAt)) &&
    typeof value.stagedAs === 'string' &&
    /^imported\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(value.stagedAs) &&
    (value.repo === undefined || typeof value.repo === 'string') &&
    (value.workspaceId === undefined ||
      typeof value.workspaceId === 'string') &&
    (value.modified === undefined || typeof value.modified === 'string') &&
    (value.consolidatedAt === undefined || isTimestamp(value.consolidatedAt)) &&
    (value.sourceTool === undefined ||
      value.sourceTool === 'claude-code' ||
      value.sourceTool === 'codex') &&
    (value.noteId === undefined || isMemoryUlid(value.noteId)) &&
    (value.retiredAt === undefined || isTimestamp(value.retiredAt))
  );
}

/** A staged import whose note is still live: it claims its staged path. */
export function isLiveImportEntry(
  entry: ImportStateEntry,
): entry is ImportStateStagedEntry {
  return 'stagedAs' in entry && entry.retiredAt === undefined;
}

function isImportStateSkipEntry(value: unknown): value is ImportStateSkipEntry {
  return (
    isRecord(value) &&
    isTimestamp(value.checkedAt) &&
    (value.skipReason === 'oversize' ||
      value.skipReason === 'undrainable' ||
      value.skipReason === 'deferred') &&
    value.fileHash === undefined &&
    value.importedAt === undefined &&
    value.stagedAs === undefined
  );
}

function isImportStateEntry(value: unknown): value is ImportStateEntry {
  return isImportStateStagedEntry(value) || isImportStateSkipEntry(value);
}

function parseImportState(value: unknown): ImportState | null {
  if (
    !isRecord(value) ||
    value.version !== IMPORT_STATE_VERSION ||
    !isRecord(value.sources)
  ) {
    return null;
  }
  const sources: Record<string, ImportStateEntry> = {};
  for (const [sourcePath, entry] of Object.entries(value.sources)) {
    if (!isImportStateEntry(entry)) {
      return null;
    }
    sources[sourcePath] = entry;
  }
  return { version: 1, sources };
}

export function emptyImportState(): ImportState {
  return { version: 1, sources: {} };
}

async function quarantineInvalidImportState(filePath: string): Promise<void> {
  await rename(filePath, `${filePath}.corrupt`).catch(() => undefined);
  process.emitWarning(
    'Invalid local memory import ledger; quarantined corrupt state when possible',
    { code: 'LOCAL_MEMORY_IMPORT_LEDGER_QUARANTINED' },
  );
}

export type ImportStateInspection =
  | { kind: 'missing' }
  | { kind: 'invalid'; raw: string }
  | { kind: 'present'; state: ImportState; raw: string };

/**
 * The ledger as stored, without the reader's recovery: an invalid ledger is
 * reported, not quarantined or replaced with an empty one, so a caller about
 * to do something destructive can refuse instead of acting on "no imports".
 * Read failures other than a missing file reject.
 */
export async function inspectImportState(
  scopeDir: string,
): Promise<ImportStateInspection> {
  let raw: string;
  try {
    raw = await readFile(join(scopeDir, IMPORT_STATE_FILENAME), 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { kind: 'missing' };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', raw };
  }
  const state = parseImportState(parsed);
  return state === null
    ? { kind: 'invalid', raw }
    : { kind: 'present', state, raw };
}

/** Writes ledger bytes captured by {@link inspectImportState} back verbatim. */
export async function writeImportStateRaw(
  scopeDir: string,
  raw: string,
): Promise<void> {
  await writeMemoryFileAtomically(
    scopeDir,
    join(scopeDir, IMPORT_STATE_FILENAME),
    raw,
  );
}

export async function readImportState(scopeDir: string): Promise<ImportState> {
  const inspection = await inspectImportState(scopeDir);
  if (inspection.kind === 'missing') return emptyImportState();
  if (inspection.kind === 'invalid') {
    await quarantineInvalidImportState(join(scopeDir, IMPORT_STATE_FILENAME));
    return emptyImportState();
  }
  return inspection.state;
}

export async function writeImportState(
  scopeDir: string,
  state: ImportState,
): Promise<void> {
  await writeMemoryFileAtomically(
    scopeDir,
    join(scopeDir, IMPORT_STATE_FILENAME),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export async function stampImportsConsolidated(
  scopeDir: string,
  stagedFiles: string[],
  consolidatedAt: string,
): Promise<void> {
  if (stagedFiles.length === 0) {
    return;
  }
  const stagedSet = new Set(stagedFiles);
  const state = await readImportState(scopeDir);
  let changed = false;
  for (const [sourcePath, entry] of Object.entries(state.sources)) {
    if (!isLiveImportEntry(entry) || !stagedSet.has(entry.stagedAs)) {
      continue;
    }
    state.sources[sourcePath] = { ...entry, consolidatedAt };
    changed = true;
  }
  if (changed) {
    await writeImportState(scopeDir, state);
  }
}

/**
 * Stamps the live entries of consumed import notes that are not stamped yet,
 * by note ID: a replay of an archive cut short after its move completes the
 * stamp, and a stamp never lands on another import staged under the path.
 */
export async function stampImportNotesConsolidated(
  scopeDir: string,
  noteIds: ReadonlySet<string>,
  consolidatedAt: string,
): Promise<void> {
  if (noteIds.size === 0) return;
  const state = await readImportState(scopeDir);
  let changed = false;
  for (const [sourcePath, entry] of Object.entries(state.sources)) {
    if (
      !isLiveImportEntry(entry) ||
      entry.consolidatedAt !== undefined ||
      entry.noteId === undefined ||
      !noteIds.has(entry.noteId)
    ) {
      continue;
    }
    state.sources[sourcePath] = { ...entry, consolidatedAt };
    changed = true;
  }
  if (changed) {
    await writeImportState(scopeDir, state);
  }
}

/** Retires the entries of import notes that were removed (see `retiredAt`). */
export async function retireImportNotes(
  scopeDir: string,
  noteIds: ReadonlySet<string>,
  retiredAt: string,
): Promise<void> {
  if (noteIds.size === 0) return;
  const state = await readImportState(scopeDir);
  let changed = false;
  for (const [sourcePath, entry] of Object.entries(state.sources)) {
    if (
      !isLiveImportEntry(entry) ||
      entry.noteId === undefined ||
      !noteIds.has(entry.noteId)
    ) {
      continue;
    }
    state.sources[sourcePath] = { ...entry, retiredAt };
    changed = true;
  }
  if (changed) {
    await writeImportState(scopeDir, state);
  }
}
