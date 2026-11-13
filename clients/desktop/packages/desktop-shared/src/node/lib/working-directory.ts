import { AsyncLocalStorage } from 'node:async_hooks';
import { stat } from 'node:fs/promises';

const readCheck = new AsyncLocalStorage<() => boolean>();

/** Read work can be retired without preventing the lifecycle's own Git work. */
export function withWorkingDirectoryReadCheck<T>(
  available: () => boolean,
  read: () => Promise<T>,
): Promise<T> {
  return readCheck.run(available, read);
}

function assertReadAvailable(cwd: string): void {
  if (readCheck.getStore()?.() === false)
    throw new Error(`Worktree folder ${cwd} is being archived or deleted`);
}

/** Re-probe on every launch; a restored folder is usable in the same process. */
export async function assertWorkingDirectoryAvailable(
  cwd?: string,
): Promise<void> {
  if (!cwd) return;
  assertReadAvailable(cwd);
  try {
    const directory = await stat(cwd);
    if (!directory.isDirectory())
      throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      throw Object.assign(new Error(`Folder ${cwd} no longer exists`), {
        code: 'ENOENT',
      });
    throw error;
  }
  assertReadAvailable(cwd);
}

/** ENOENT can name a missing cwd even when the executable is installed. */
export async function workingDirectoryLaunchError(
  error: unknown,
  cwd?: string,
): Promise<unknown> {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    try {
      await assertWorkingDirectoryAvailable(cwd);
    } catch (directoryError) {
      return directoryError;
    }
  }
  return error;
}
