import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getWorkspaceWorktreeDir } from '../lib/paths';
import { resolveRegisteredChatWorktree } from '../lib/resolve-worktree';
import { getWorkspaceType } from '../lib/workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';

/** True when `path` is `cwd` itself or lies inside it, so it is already reachable. */
function withinCwd(cwd: string, path: string): boolean {
  const fromCwd = relative(cwd, path);
  return (
    fromCwd === '' ||
    (fromCwd !== '..' &&
      !fromCwd.startsWith(`..${sep}`) &&
      !isAbsolute(fromCwd))
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/**
 * The repositories of a multi-repo worktree other than the chat's `cwd`, as
 * absolute paths that exist on disk. Empty for single-repo projects and any
 * other scope. Repositories already reachable from `cwd` (the cwd itself or one
 * inside it) are left out; a workspace root around a selected child repository
 * is kept so its own files stay visible. Relative or missing paths are dropped. Never throws: extra roots must not fail a turn.
 */
export async function antigravityAdditionalDirectories(input: {
  projectId: string;
  worktreeId: string;
  cwd: string;
}): Promise<string[]> {
  try {
    const target = resolveRegisteredChatWorktree(
      input.projectId,
      input.worktreeId,
    );
    if (getWorkspaceType(target.projectId) !== 'multi-repo') return [];
    const cwd = resolve(input.cwd);
    const entries = await listWorkspaceWorktreeRepoEntries(
      target.projectId,
      getWorkspaceWorktreeDir(target.projectId, target.worktreeId),
    );
    const candidates = [
      ...new Set(
        entries
          .map((entry) => entry.repoPath)
          .filter((path) => isAbsolute(path))
          .map((path) => resolve(path))
          .filter((path) => !withinCwd(cwd, path)),
      ),
    ];
    const present = await Promise.all(candidates.map(isDirectory));
    return candidates.filter((_, index) => present[index]);
  } catch (error) {
    // Still open the session, but say which scope lost its extra roots so a
    // misregistered workspace does not silently hide repositories.
    logMainProcessWarn(
      '[antigravity-directories] Additional directories unavailable',
      { projectId: input.projectId, worktreeId: input.worktreeId, error },
    );
    return [];
  }
}
