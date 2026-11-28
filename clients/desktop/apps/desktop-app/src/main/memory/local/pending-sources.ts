import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isLiveImportEntry,
  readImportState,
  type ImportState,
  type ImportStateStagedEntry,
} from '@canopy/memory-store/import/ledger';
import { isMemoryMarkdownFileName } from '@canopy/memory-store/memory-files';

export interface PendingImport {
  fileKey: string;
  filename: string;
  originalPath: string;
  entry: ImportStateStagedEntry;
}

/**
 * The sources consolidation can consume, in the one definition shared by the
 * consolidation input reader and rebuild's drain loop. Staged files the
 * ledger does not describe are listed separately: consolidation skips them
 * until the next import run restages them and heals the ledger.
 */
export interface PendingSources {
  /** Top-level `inbox/*.md` filenames, oldest first. */
  inboxFiles: string[];
  imports: PendingImport[];
  /** Staged `imported/*.md` files consolidation cannot use yet. */
  unusableImports: string[];
  /** The import ledger could not be read, so no staged file is usable. */
  ledgerUnreadable: boolean;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/** Markdown files directly in `directory`, sorted; missing means none. */
async function listMarkdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    // Only a missing directory means "nothing pending". Any other failure
    // must abort consolidation before MEMORY.md is overwritten from input
    // that silently dropped sources.
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
}

/**
 * Pending inbox notes. Filenames are ISO-timestamp-prefixed, so the
 * lexicographic sort is chronological (oldest first).
 */
export function listPendingInboxNotes(scopeDir: string): Promise<string[]> {
  return listMarkdownFiles(join(scopeDir, 'inbox'));
}

async function readLedger(scopeDir: string): Promise<ImportState | null> {
  try {
    return await readImportState(scopeDir);
  } catch {
    // A corrupt ledger must not wedge consolidation for the scope; the next
    // import run rewrites it.
    return null;
  }
}

export async function listPendingSources(
  scopeDir: string,
): Promise<PendingSources> {
  const [inboxFiles, stagedNames] = await Promise.all([
    listPendingInboxNotes(scopeDir),
    listMarkdownFiles(join(scopeDir, 'imported')),
  ]);
  if (stagedNames.length === 0) {
    return {
      inboxFiles,
      imports: [],
      unusableImports: [],
      ledgerUnreadable: false,
    };
  }
  const ledger = await readLedger(scopeDir);
  if (ledger === null) {
    return {
      inboxFiles,
      imports: [],
      unusableImports: stagedNames,
      ledgerUnreadable: true,
    };
  }
  const sourcesByStagedPath = new Map<
    string,
    { originalPath: string; entry: ImportStateStagedEntry }
  >();
  for (const [originalPath, entry] of Object.entries(ledger.sources)) {
    if (isLiveImportEntry(entry)) {
      sourcesByStagedPath.set(entry.stagedAs, { originalPath, entry });
    }
  }
  const imports: PendingImport[] = [];
  const unusableImports: string[] = [];
  for (const filename of stagedNames) {
    const fileKey = `imported/${filename}`;
    const source = sourcesByStagedPath.get(fileKey);
    // Staging succeeded but the ledger write failed: the orphan is skipped
    // until the next import run restages it and heals the ledger.
    if (source) imports.push({ fileKey, filename, ...source });
    else unusableImports.push(filename);
  }
  return { inboxFiles, imports, unusableImports, ledgerUnreadable: false };
}

/** Sources consolidation can still consume: inbox notes plus usable imports. */
export async function countPendingSources(scopeDir: string): Promise<number> {
  const pending = await listPendingSources(scopeDir);
  return pending.inboxFiles.length + pending.imports.length;
}
