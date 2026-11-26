import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  GIT_CHANGE_SET_MAX_UNTRACKED_FILES,
  type GitUntrackedEstimate,
} from './change-set';

/**
 * Files larger than this are skipped so artifacts cannot inflate line counts
 * or stall a changed-files listing.
 */
export const GIT_UNTRACKED_ESTIMATE_MAX_FILE_BYTES = 512_000;
export const GIT_UNTRACKED_ESTIMATE_MAX_FILES =
  GIT_CHANGE_SET_MAX_UNTRACKED_FILES;
const MAX_CONCURRENT_READS = 16;
const MAX_INSERTIONS = 100_000;
/** Git's binary heuristic: a NUL byte within the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;

const NO_CHANGE: GitUntrackedEstimate = { insertions: 0, binary: false };
const CONFINED: GitUntrackedEstimate = { ...NO_CHANGE, confined: true };

async function estimateOne(filePath: string): Promise<GitUntrackedEstimate> {
  const initialStats = await lstat(filePath);
  if (!initialStats.isFile()) return NO_CHANGE;
  if (initialStats.size > GIT_UNTRACKED_ESTIMATE_MAX_FILE_BYTES)
    return NO_CHANGE;

  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) return NO_CHANGE;
    if (openedStats.size > GIT_UNTRACKED_ESTIMATE_MAX_FILE_BYTES)
      return NO_CHANGE;
    const buffer = Buffer.allocUnsafe(
      GIT_UNTRACKED_ESTIMATE_MAX_FILE_BYTES + 1,
    );
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytesRead,
        buffer.length - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    if (totalBytesRead > GIT_UNTRACKED_ESTIMATE_MAX_FILE_BYTES)
      return NO_CHANGE;
    if (
      buffer
        .subarray(0, Math.min(totalBytesRead, BINARY_SNIFF_BYTES))
        .includes(0)
    )
      // Binary, as git classifies it: it has no lines to count.
      return { insertions: 0, binary: true };
    const content = buffer.toString('utf8', 0, totalBytesRead);
    return {
      insertions:
        content.length === 0
          ? 0
          : content.split('\n').length - (content.endsWith('\n') ? 1 : 0),
      binary: false,
    };
  } finally {
    await handle.close();
  }
}

/** `child` is `root` or below it; both are real paths. */
function isWithin(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
}

export interface GitUntrackedEstimateOptions {
  /**
   * Count a file only when its parent directory resolves inside `root`, so a
   * directory swapped for a symbolic link after Git listed it is not read.
   * The final component is never followed either way.
   */
  readonly confined?: boolean;
}

/**
 * Line counts for untracked files, which `git diff --numstat` never lists
 * because they have no HEAD side, so an added file shows `+N` like a tracked
 * one. Unreadable files count as 0 rather than failing the whole listing;
 * the total is capped after every read, in listing order.
 */
export async function estimateGitUntrackedChanges(
  root: string,
  files: readonly string[],
  options: GitUntrackedEstimateOptions = {},
): Promise<GitUntrackedEstimate[]> {
  const realRoot = options.confined
    ? await realpath(root).catch(() => null)
    : undefined;
  const counts = new Array<GitUntrackedEstimate>(files.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(files.length, MAX_CONCURRENT_READS) },
    async () => {
      while (nextIndex < files.length) {
        const index = nextIndex;
        nextIndex += 1;
        const file = files[index];
        if (file === undefined) continue;
        let count = NO_CHANGE;
        try {
          const filePath = join(root, file);
          // An unresolvable root skips the file without claiming it escaped.
          if (realRoot === undefined) count = await estimateOne(filePath);
          else if (realRoot !== null)
            count = isWithin(realRoot, await realpath(dirname(filePath)))
              ? await estimateOne(filePath)
              : CONFINED;
        } catch {
          // Unreadable files count as zero without failing the whole listing.
        }
        counts[index] = count;
      }
    },
  );
  await Promise.all(workers);
  // Apply the ceiling after reads finish so filesystem timing cannot change
  // which files contribute to the displayed aggregate.
  let remaining = MAX_INSERTIONS;
  return counts.map((change) => {
    const insertions = Math.min(change.insertions, remaining);
    remaining -= insertions;
    return { ...change, insertions };
  });
}
