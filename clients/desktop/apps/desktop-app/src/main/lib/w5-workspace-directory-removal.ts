import { drainDirectoryEffects } from './directory-effect-admission';
import type { BigIntStats } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { removeArchiveTree } from '../archive/archive-file-operations';
import { getWorkspaceDir } from './paths';
import { currentW5CommitScope } from './w5-commit-scope';
import { logMainProcessWarn } from './main-process-logging';
import { isErrnoException } from './type-guards';
import {
  INCARNATION_MARKER,
  removeDestructiveWorkspaceDirectory,
} from './w5-destructive-recovery';

async function entryIdentity(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function isReservedRecordEntry(
  directory: string,
  child: string,
): Promise<boolean> {
  if (
    child.toLowerCase() === INCARNATION_MARKER ||
    /^(?:workspace|worktrees)\.json$/iu.test(child)
  )
    return true;
  const entry = await entryIdentity(join(directory, child));
  if (!entry) return true;
  // Filesystem alias rules need not match Unicode case folding. Do not follow links.
  for (const recordName of [
    INCARNATION_MARKER,
    'workspace.json',
    'worktrees.json',
  ]) {
    const record = await entryIdentity(join(directory, recordName));
    if (record && record.dev === entry.dev && record.ino === entry.ino)
      return true;
  }
  return false;
}

function assertOutsideCommit(): void {
  if (currentW5CommitScope())
    throw new Error(
      'Workspace directory cleanup must run outside a W5 commit scope',
    );
}

/** Q2(b): clean non-W5 children before committing record removals. */
export async function removeWorkspaceNonW5Children(
  workspaceId: string,
): Promise<void> {
  assertOutsideCommit();
  await drainDirectoryEffects(getWorkspaceDir(workspaceId));
  const directory = getWorkspaceDir(workspaceId);
  let original;
  try {
    original = await lstat(directory);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return;
    throw error;
  }
  if (original.isSymbolicLink())
    throw new Error('Workspace directory cleanup refuses a symbolic link');
  if (!original.isDirectory())
    throw new Error('Workspace directory cleanup requires a directory');
  const canonicalDirectory = await realpath(directory);
  const assertUnchanged = async (): Promise<void> => {
    const current = await lstat(directory);
    if (
      !current.isDirectory() ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      current.birthtimeMs !== original.birthtimeMs ||
      (await realpath(directory)) !== canonicalDirectory
    )
      throw new Error('Workspace directory changed during cleanup');
  };
  await assertUnchanged();
  const children = await readdir(directory);
  await assertUnchanged();
  for (const child of children) {
    if (await isReservedRecordEntry(directory, child)) continue;
    await assertUnchanged();
    // The archive boundary rechecks before permission repair; no unchecked retries.
    // Path-based removal still has a last-check/syscall race, including descendants.
    await removeArchiveTree(
      join(directory, child),
      directory,
      assertUnchanged,
      {
        maxRetries: 0,
      },
    );
  }
}

/** Never recursively remove here: a peer may have recreated the records. */
export async function removeWorkspaceDirectoryAfterRecordRemoval(
  workspaceId: string,
): Promise<void> {
  assertOutsideCommit();
  await drainDirectoryEffects(getWorkspaceDir(workspaceId));
  try {
    await removeDestructiveWorkspaceDirectory(workspaceId);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ENOENT') return;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      logMainProcessWarn('Workspace directory kept after record removal', {
        workspaceId,
        code,
      });
      return;
    }
    throw error;
  }
}
