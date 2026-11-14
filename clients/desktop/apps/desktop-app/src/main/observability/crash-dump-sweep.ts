import { lstat, readdir, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { MainCrashCapturePolicy } from '@canopy/desktop-instrumentation/electron/main';
import { isMissingFileError } from '../lib/fs-utils';
import { isPathInside } from '../lib/path-safety';

/** Dumps older than this are deleted. */
export const CRASH_DUMP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Of the dumps within the age limit, at most this many newest are kept. */
export const CRASH_DUMP_MAX_KEPT = 20;
/** Deep enough for every Crashpad layout; bounds a hostile directory tree. */
const MAX_DIRECTORY_DEPTH = 8;

export type CrashDumpSweepVerdict = 'process' | 'discard';

export interface CrashDumpSweepDirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface CrashDumpSweepStats {
  readonly mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** The file system calls the sweep makes; injectable for tests. */
export interface CrashDumpSweepFs {
  readonly readdir: (
    directory: string,
    options: { readonly withFileTypes: true },
  ) => Promise<readonly CrashDumpSweepDirent[]>;
  readonly lstat: (filePath: string) => Promise<CrashDumpSweepStats>;
  readonly unlink: (filePath: string) => Promise<void>;
}

export const nodeCrashDumpSweepFs: CrashDumpSweepFs = {
  readdir: (directory) => readdir(directory, { withFileTypes: true }),
  lstat: (filePath) => lstat(filePath),
  unlink: (filePath) => unlink(filePath),
};

export interface CrashDumpSweepOptions {
  /** Absolute path of Electron's `crashDumps` directory. */
  readonly crashDumpsDir: string;
  /**
   * Decides whether a dump is Canopy's (`process`) or a foreign process's
   * (`discard`). Pass the foreign crash-dump filter where it applies; without
   * one, every dump is treated as Canopy's. A throwing classifier keeps the
   * dump and counts an error.
   */
  readonly classify?: (filePath: string) => Promise<CrashDumpSweepVerdict>;
  readonly onKept?: (filePath: string, mtimeMs: number) => void;
  readonly fs?: CrashDumpSweepFs;
  readonly now?: () => number;
}

/** Counts only; the sweep never reports paths. */
export interface CrashDumpSweepResult {
  /** `.dmp` files found outside `new/`. */
  readonly listed: number;
  /** Deleted because the classifier returned `discard`. */
  readonly discardedForeign: number;
  /** Deleted by the age limit or the newest-count cap. */
  readonly deletedByRetention: number;
  /** Canopy's dumps left in place. */
  readonly kept: number;
  /** Files or directories that could not be read, classified, or deleted. */
  readonly errors: number;
  /** False if an error or a disappearing entry could have hidden a dump. */
  readonly complete: boolean;
}

interface ListedDump {
  readonly filePath: string;
  readonly mtimeMs: number;
}

export interface CrashDumpFileListing {
  /** Absolute paths of `.dmp` files inside the root, outside `new/`. */
  readonly filePaths: readonly string[];
  /** Directories or entries that could not be listed safely. */
  readonly errors: number;
  readonly complete: boolean;
}

function isInsideCrashDumpsRoot(root: string, candidate: string): boolean {
  return candidate !== root && isPathInside(root, candidate);
}

/**
 * Lists the `.dmp` files under `crashDumpsDir`, recursively, skipping
 * Crashpad's top-level `new/` directory (dumps still being written) and
 * symlinks. A missing directory lists nothing and is not an error.
 */
export async function listCrashDumpFiles(
  crashDumpsDir: string,
  fs: Pick<CrashDumpSweepFs, 'readdir'> = nodeCrashDumpSweepFs,
): Promise<CrashDumpFileListing> {
  const root = resolve(crashDumpsDir);
  const newDirectory = join(root, 'new');
  const filePaths: string[] = [];
  let errors = 0;
  let complete = true;

  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries: readonly CrashDumpSweepDirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!isMissingFileError(error)) errors += 1;
      else if (directory !== root) complete = false;
      return;
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (!isInsideCrashDumpsRoot(root, entryPath)) {
        errors += 1;
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entryPath === newDirectory || depth >= MAX_DIRECTORY_DEPTH) {
          continue;
        }
        await walk(entryPath, depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.dmp')) {
        filePaths.push(entryPath);
      }
    }
  };

  await walk(root, 0);
  return { filePaths, errors, complete: complete && errors === 0 };
}

async function hasUnfinishedCrashpadDumps(
  root: string,
  fs: CrashDumpSweepFs,
): Promise<boolean> {
  const staging = join(root, 'new');
  let stats: CrashDumpSweepStats;
  try {
    stats = await fs.lstat(staging);
  } catch (error) {
    return !isMissingFileError(error);
  }
  // Do not follow a symlink or advance past an unreadable staging directory.
  if (!stats.isDirectory()) return true;
  try {
    return (await fs.readdir(staging, { withFileTypes: true })).length > 0;
  } catch {
    return true;
  }
}

/**
 * Deletes foreign crash dumps and applies Canopy's retention to the rest:
 * dumps older than {@link CRASH_DUMP_MAX_AGE_MS} go first, then all but the
 * newest {@link CRASH_DUMP_MAX_KEPT}. Crashpad's `new/` directory holds dumps
 * still being written and is never touched. Only paths inside
 * `crashDumpsDir` are deleted. A file that disappears mid-sweep (Crashpad
 * moves dumps between directories) does not count as an error, but prevents
 * dropping receipts for missing dumps. One bad file never stops the sweep.
 */
export async function sweepCrashDumps(
  options: CrashDumpSweepOptions,
): Promise<CrashDumpSweepResult> {
  const fs = options.fs ?? nodeCrashDumpSweepFs;
  const now = options.now ?? Date.now;
  const root = resolve(options.crashDumpsDir);
  // Read staging first. A dump that completes before this check will be
  // visible to the following retained-file listing.
  const unfinished = await hasUnfinishedCrashpadDumps(root, fs);
  const listing = await listCrashDumpFiles(root, fs);
  const listed = listing.filePaths.length;
  let discardedForeign = 0;
  let deletedByRetention = 0;
  let errors = listing.errors;
  let complete = listing.complete && !unfinished;

  /** Deletes one dump inside the root; counts an error when it cannot. */
  const remove = async (
    filePath: string,
  ): Promise<'deleted' | 'gone' | 'failed'> => {
    if (!isInsideCrashDumpsRoot(root, filePath)) {
      errors += 1;
      return 'failed';
    }
    try {
      await fs.unlink(filePath);
      return 'deleted';
    } catch (error) {
      if (isMissingFileError(error)) {
        complete = false;
        return 'gone';
      }
      errors += 1;
      return 'failed';
    }
  };

  const dumps: ListedDump[] = [];
  for (const filePath of listing.filePaths) {
    let stats: CrashDumpSweepStats;
    try {
      stats = await fs.lstat(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) errors += 1;
      complete = false;
      continue;
    }
    if (!stats.isFile()) {
      complete = false;
      continue;
    }

    let verdict: CrashDumpSweepVerdict = 'process';
    if (options.classify !== undefined) {
      try {
        verdict = await options.classify(filePath);
      } catch {
        errors += 1;
        verdict = 'process';
      }
    }
    if (verdict === 'discard') {
      if ((await remove(filePath)) === 'deleted') discardedForeign += 1;
      continue;
    }
    dumps.push({ filePath, mtimeMs: stats.mtimeMs });
  }

  const cutoff = now() - CRASH_DUMP_MAX_AGE_MS;
  const fresh: ListedDump[] = [];
  for (const dump of dumps) {
    if (dump.mtimeMs >= cutoff) {
      fresh.push(dump);
      continue;
    }
    if ((await remove(dump.filePath)) === 'deleted') deletedByRetention += 1;
  }

  fresh.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs ||
      left.filePath.localeCompare(right.filePath),
  );
  let kept = 0;
  for (const [index, dump] of fresh.entries()) {
    if (index < CRASH_DUMP_MAX_KEPT) {
      kept += 1;
      options.onKept?.(dump.filePath, dump.mtimeMs);
      continue;
    }
    if ((await remove(dump.filePath)) === 'deleted') deletedByRetention += 1;
  }

  return {
    listed,
    discardedForeign,
    deletedByRetention,
    kept,
    errors,
    complete: complete && errors === 0,
  };
}

/** Apply local retention before reading anything that gates crash reporting. */
export async function sweepStartupCrashDumps(options: {
  readonly crashDumpsDir: string;
  readonly classify?: CrashDumpSweepOptions['classify'];
  readonly policy: () => MainCrashCapturePolicy;
  readonly receipts: {
    read(): Promise<ReadonlySet<string>>;
    save(receipts: ReadonlySet<string>): void;
  };
  readonly report: (
    dumpPaths: readonly string[],
    onDelivered: (dumpName: string) => void,
  ) => Promise<boolean>;
}): Promise<Omit<CrashDumpSweepResult, 'complete'>> {
  const retained: string[] = [];
  const { complete, ...counts } = await sweepCrashDumps({
    crashDumpsDir: options.crashDumpsDir,
    classify: options.classify,
    onKept: (filePath): void => {
      retained.push(filePath);
    },
  });
  if (counts.listed === 0 && counts.errors === 0) return counts;

  try {
    if (options.policy() !== 'allow') return counts;
    const known = await options.receipts.read();
    const retainedNames = new Set(
      retained.map((filePath) => basename(filePath).toLowerCase()),
    );
    // In an incomplete listing a missing file may have moved, not been pruned.
    const delivered = new Set(
      complete ? [...known].filter((name) => retainedNames.has(name)) : known,
    );
    const pending = retained.filter(
      (filePath) => !delivered.has(basename(filePath).toLowerCase()),
    );
    let needsPrune = delivered.size !== known.size;
    await options.report(pending, (name): void => {
      delivered.add(name);
      options.receipts.save(delivered);
      needsPrune = false;
    });
    if (needsPrune) options.receipts.save(delivered);
  } catch {
    // Crash reporting is best effort. Retention has already run.
  }
  return counts;
}
