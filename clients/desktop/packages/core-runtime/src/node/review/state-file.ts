import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/*
 * The v1 code-review state file of one worktree (CAN-4167). Electron main is
 * its only writer: the host resolves the file's path with its canonical
 * helper, and every read-modify-write in the process runs under this
 * module's lock and replaces the file by atomic rename, so a crash mid-write
 * leaves the previous file whole. The core.review engine takes these over
 * unchanged; daemon placement waits on the store's qualification (CAN-4495)
 * and CAN-5092.
 */

const writeLocks = new Map<string, Promise<void>>();

/**
 * Serializes read-modify-write cycles on one state file in this process.
 * Holders must not take the same path's lock again: it is not re-entrant.
 */
export async function withReviewStateLock<T>(
  statePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = writeLocks.get(statePath) ?? Promise.resolve();
  let release = (): void => undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(statePath, next);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(statePath) === next) {
      writeLocks.delete(statePath);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  // Not `instanceof Error`: fs errors can come from another realm.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** The raw state text, or null before the first write. */
export async function readReviewStateText(
  statePath: string,
): Promise<string | null> {
  try {
    return await readFile(statePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/**
 * Replaces the state file atomically through a sibling temporary file. A
 * reader sees the previous file or this one, never a part of either.
 */
export async function writeReviewStateText(
  statePath: string,
  content: string,
): Promise<void> {
  const directory = dirname(statePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(statePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, statePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** Removes the state file; a missing file is already removed. */
export async function removeReviewState(statePath: string): Promise<void> {
  await rm(statePath, { force: true });
}
