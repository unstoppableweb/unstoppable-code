import * as path from 'path';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';

/**
 * Check whether `childPath` is inside (or equal to) `parentDir`.
 * Both paths are resolved and normalized before comparison.
 */
export function isPathInside(parentDir: string, childPath: string): boolean {
  const relative = path.relative(
    path.resolve(parentDir),
    path.resolve(childPath),
  );
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

// Windows has no O_NOFOLLOW; there the component walk and the identity check
// below still refuse links and swaps.
const NO_FOLLOW_FLAG: number =
  'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;

export type ContainedPathRefusal =
  | 'outside-root'
  | 'root-not-directory'
  | 'symbolic-link'
  | 'not-a-file';

/**
 * A refused contained-path access. The message carries only the reason code,
 * never the path or a link target, so callers can log it safely.
 */
export class ContainedPathRefusedError extends Error {
  readonly reason: ContainedPathRefusal;

  constructor(reason: ContainedPathRefusal) {
    super(`Path refused: ${reason}`);
    this.name = 'ContainedPathRefusedError';
    this.reason = reason;
  }
}

/**
 * Resolves `candidate` inside `root` without following a symbolic link (or a
 * Windows junction, which `lstat` reports as one) anywhere from `root` down to
 * the candidate itself, then confirms the real paths agree. A missing root or
 * component rejects with its ENOENT error so callers keep their not-found
 * handling.
 */
export async function resolveContainedRealPath(
  root: string,
  candidate: string,
): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new ContainedPathRefusedError('outside-root');
  }
  const rootInfo = await lstat(resolvedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new ContainedPathRefusedError('root-not-directory');
  }
  const suffix = path.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;
  for (const component of suffix ? suffix.split(path.sep) : []) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new ContainedPathRefusedError('symbolic-link');
    }
  }
  // Real path against real path only, so case folding and junction or drive
  // aliasing resolve the same way on both sides.
  if (!isPathInside(await realpath(resolvedRoot), await realpath(current))) {
    throw new ContainedPathRefusedError('outside-root');
  }
  return resolvedCandidate;
}

/**
 * Reads a regular file inside `root` through {@link resolveContainedRealPath}.
 * The open refuses a final symbolic link where the platform supports it.
 * Containment is then checked again with the file held open: the walk must
 * still pass, and the file it reaches must be the one opened. A parent swapped
 * for a link before the open sends the open outside the root, so the held file
 * no longer matches the file inside it.
 */
export async function readContainedFile(
  root: string,
  candidate: string,
): Promise<string> {
  const filePath = await resolveContainedRealPath(root, candidate);
  if (!(await lstat(filePath)).isFile()) {
    throw new ContainedPathRefusedError('not-a-file');
  }
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW_FLAG);
  } catch (error) {
    if (isLinkLoopError(error)) {
      throw new ContainedPathRefusedError('symbolic-link');
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new ContainedPathRefusedError('not-a-file');
    await resolveContainedRealPath(root, filePath);
    const reached = await lstat(filePath);
    if (opened.dev !== reached.dev || opened.ino !== reached.ino) {
      throw new ContainedPathRefusedError('symbolic-link');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function isLinkLoopError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ELOOP' || error.code === 'EMLINK')
  );
}
