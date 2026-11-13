import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isErrnoException } from './type-guards';

/** `pathValue` with its deepest existing ancestor resolved to its real path. */
export async function canonicalizePossiblyMissingPath(
  pathValue: string,
): Promise<string> {
  let existingAncestor = resolve(pathValue);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return join(await realpath(existingAncestor), ...missingSegments);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return resolve(pathValue);
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** The checkout an entry's `gitdir` text names, or null. */
function checkoutOfGitdir(
  registrationEntry: string,
  gitdir: string,
): string | null {
  const dotGit = resolve(registrationEntry, gitdir.replace(/\r?\n$/, ''));
  return basename(dotGit) === '.git' ? dirname(dotGit) : null;
}

/** The checkout a `$GIT_COMMON_DIR/worktrees/<id>` entry registers, or null. */
async function readRegisteredCheckout(
  registrationEntry: string,
): Promise<string | null> {
  try {
    return checkoutOfGitdir(
      registrationEntry,
      await readFile(join(registrationEntry, 'gitdir'), 'utf8'),
    );
  } catch {
    return null;
  }
}

/**
 * Whether `gitCommonDir` holds Git's own entry for any of `checkouts`, present
 * or not. Read-only: it reads the repository's entries, never a checkout. An
 * entry it cannot read, or a named path it cannot resolve, throws: the removal
 * leaves such an entry, so "none" would hide it.
 */
export async function hasWorktreeRegistration(
  gitCommonDir: string,
  checkouts: readonly string[],
): Promise<boolean> {
  const registrationEntries = join(gitCommonDir, 'worktrees');
  let entries: Dirent[];
  try {
    entries = (
      await readdir(registrationEntries, { withFileTypes: true })
    ).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
  if (!entries.length) return false;
  const comparableCheckouts = await Promise.all(
    checkouts.map((checkout) => canonicalizePossiblyMissingPath(checkout)),
  );
  // Reads every entry, so a look before the removal fails wherever the look
  // after it would.
  let found = false;
  for (const entry of entries) {
    const registrationEntry = join(registrationEntries, entry.name);
    let gitdir: string;
    try {
      gitdir = await readFile(join(registrationEntry, 'gitdir'), 'utf8');
    } catch (error) {
      // An entry Git has not written `gitdir` into registers no checkout yet.
      if (isErrnoException(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    const checkout = checkoutOfGitdir(registrationEntry, gitdir);
    if (checkout === null) continue;
    // As in the removal: a path that can't be resolved is another checkout's,
    // since every named one resolved (an unresolvable named one throws above).
    const comparable = await canonicalizePossiblyMissingPath(checkout).catch(
      () => null,
    );
    if (comparable !== null && comparableCheckouts.includes(comparable))
      found = true;
  }
  return found;
}

async function readLockReason(
  registrationEntry: string,
): Promise<string | null> {
  try {
    return await readFile(join(registrationEntry, 'locked'), 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

const CLEANUP_LOCK_REASON = 'canopy: removing stale registration';

/** Whether a worktree lock `reason` is one this cleanup takes. */
export function isRegistrationCleanupLock(reason: string): boolean {
  return reason.startsWith(CLEANUP_LOCK_REASON);
}

/**
 * Whether `registrationEntry` registers one of `comparableCheckouts` that is
 * absent. A registered path that can't be resolved is another checkout's,
 * since every named one resolved.
 */
async function registersAbsentCheckout(
  registrationEntry: string,
  comparableCheckouts: readonly string[],
): Promise<boolean> {
  const checkout = await readRegisteredCheckout(registrationEntry);
  if (checkout === null) return false;
  const comparable = await canonicalizePossiblyMissingPath(checkout).catch(
    () => null,
  );
  return (
    comparable !== null &&
    comparableCheckouts.includes(comparable) &&
    !(await exists(checkout))
  );
}

/**
 * Locks the entry as `git worktree lock` does, unless it is locked already.
 * Returns the lock reason the entry now holds, or null if it is gone.
 */
async function lockRegistration(
  registrationEntry: string,
): Promise<{ reason: string; own: boolean } | null> {
  const reason = `${CLEANUP_LOCK_REASON} ${randomUUID()}\n`;
  try {
    await writeFile(join(registrationEntry, 'locked'), reason, { flag: 'wx' });
    return { reason, own: true };
  } catch (error) {
    if (!isErrnoException(error)) throw error;
    if (error.code === 'ENOENT') return null;
    if (error.code !== 'EEXIST') throw error;
  }
  const held = await readLockReason(registrationEntry);
  return held === null ? null : { reason: held, own: false };
}

/**
 * Moves `aside` back to `registrationEntry` unless something holds that path
 * now, such as an entry Git re-created under the id; then `aside` stays, still
 * read as an entry, so its checkout counts as registered (review r6 finding 1).
 */
async function restoreAside(
  aside: string,
  registrationEntry: string,
): Promise<void> {
  // Node has no no-replace rename: an entry Git creates between this look and
  // the rename is still replaced (accepted window, can5334-aside-residual).
  if (await exists(registrationEntry)) return;
  await rename(aside, registrationEntry);
}

/**
 * Removes `registrationEntry` only if it is still the entry checked under
 * `lockReason`: it is moved to a private name beside it first, then deleted
 * if the moved entry has the checked inode and lock and still registers an
 * absent checkout. Any other entry, such as one Git replaced under the same
 * id after the check, is moved back and kept (review r5 finding 3), never
 * over an entry at its path (see {@link restoreAside}). Returns whether the
 * checked entry was removed.
 */
async function removeCheckedRegistration(
  registrationEntry: string,
  checked: { dev: number; ino: number },
  lockReason: string,
  comparableCheckouts: readonly string[],
  canRemove?: () => Promise<boolean>,
): Promise<boolean> {
  // Random, so neither an id Git picks nor another removal's aside. Git still
  // reads it as an entry; a crash leaves it to the next removal's pass.
  const aside = join(
    dirname(registrationEntry),
    `.canopy-removing-${basename(registrationEntry)}-${randomUUID()}`,
  );
  try {
    await rename(registrationEntry, aside);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
  let checkedEntry: boolean;
  try {
    const moved = await lstat(aside);
    checkedEntry =
      moved.dev === checked.dev &&
      moved.ino === checked.ino &&
      (await readLockReason(aside)) === lockReason &&
      (await registersAbsentCheckout(aside, comparableCheckouts)) &&
      (!canRemove || (await canRemove()));
  } catch (error) {
    // An entry that can't be checked may be another checkout's: put it back.
    await restoreAside(aside, registrationEntry).catch(() => undefined);
    throw error;
  }
  if (checkedEntry) {
    await rm(aside, { recursive: true, force: true });
    return true;
  }
  await restoreAside(aside, registrationEntry);
  return false;
}

/**
 * Removes Git's own entry (`$GIT_COMMON_DIR/worktrees/<id>`) for each of
 * `checkouts` that is absent, as `git worktree prune` does for one entry.
 * Not a repository-wide prune, which drops another archive's checkout moved
 * before its `git worktree repair`, nor a forced `git worktree remove`, which
 * deletes a checkout added at the path since the caller's check. A checkout
 * moved without repair is matched only by its pre-move path, which the caller
 * names; an entry id can be reused once its entry is gone.
 *
 * Each entry is locked before its final check, so `git worktree add -f`
 * refuses the path until the entry is gone (`add -f -f` overrides any lock).
 * An existing lock, a user's or one a crashed cleanup left, blocks it the same
 * way, so that entry is removed too. Git creates the checkout directory before
 * an entry's `gitdir`, so an entry it is still adding is never removed. An
 * `add -f` that checked the entry just before the lock can still replace it
 * under the same id after the final check; the removal then keeps the
 * replacement (see {@link removeCheckedRegistration}).
 *
 * An aborted `signal` rejects with its reason once the entry in progress is
 * removed or released, and before returning.
 */
export async function removeAbsentWorktreeRegistrations(
  gitCommonDir: string,
  checkouts: readonly string[],
  options: { signal?: AbortSignal; canRemove?: () => Promise<boolean> } = {},
): Promise<void> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (!checkouts.length) return;
  const registrationEntries = join(gitCommonDir, 'worktrees');
  let entries: Dirent[] = [];
  try {
    entries = (
      await readdir(registrationEntries, { withFileTypes: true })
    ).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
  // A named path that can't be resolved matches no entry, as an unrelated
  // entry's can't, so it leaves that entry in place instead of failing.
  const comparableCheckouts = entries.length
    ? (
        await Promise.all(
          checkouts.map((checkout) =>
            canonicalizePossiblyMissingPath(checkout).catch(() => null),
          ),
        )
      ).filter((checkout) => checkout !== null)
    : [];
  for (const entry of comparableCheckouts.length ? entries : []) {
    signal?.throwIfAborted();
    const registrationEntry = join(registrationEntries, entry.name);
    if (
      !(await registersAbsentCheckout(registrationEntry, comparableCheckouts))
    )
      continue;
    const lock = await lockRegistration(registrationEntry);
    if (lock === null) continue;
    const releaseOwnLock = async (): Promise<void> => {
      if (lock.own && (await readLockReason(registrationEntry)) === lock.reason)
        await rm(join(registrationEntry, 'locked'), { force: true });
    };
    try {
      const checked = await lstat(registrationEntry).catch((error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') return null;
        throw error;
      });
      if (
        checked !== null &&
        (await registersAbsentCheckout(
          registrationEntry,
          comparableCheckouts,
        )) &&
        (await readLockReason(registrationEntry)) === lock.reason &&
        (await removeCheckedRegistration(
          registrationEntry,
          checked,
          lock.reason,
          comparableCheckouts,
          options.canRemove,
        ))
      )
        continue;
    } catch (error) {
      // The original failure outranks a failed release.
      await releaseOwnLock().catch(() => undefined);
      throw error;
    }
    await releaseOwnLock();
  }
  signal?.throwIfAborted();
}
