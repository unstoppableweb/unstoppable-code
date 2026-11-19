import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodeGraphRepositoryInput } from '../types/code-graph';

/** The repository id a workspace's root checkout is graphed under. */
export const CODE_GRAPH_WORKSPACE_ROOT_REPO_ID = '__workspace_root__';

export interface CodeGraphWorktreeLayout {
  readonly multiRepo: boolean;
  /** A multi-repo workspace records a source checkout for its root. */
  readonly hasSourceRepo: boolean;
}

/** `ENOENT`, `ENOTDIR` and an over-long name mean the path is missing. */
function isMissingPathError(error: unknown): boolean {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG';
}

/**
 * The repositories a worktree's graph covers, in order: a multi-repo
 * workspace's root checkout when it has a source or is itself a Git
 * checkout, then every directory under the worktree's `repos/`.
 */
export async function listCodeGraphWorktreeRepositories(
  worktreePath: string,
  layout: CodeGraphWorktreeLayout,
  isGitRepo: (directory: string) => Promise<boolean>,
): Promise<CodeGraphRepositoryInput[]> {
  const repositories: CodeGraphRepositoryInput[] = [];
  if (
    layout.multiRepo &&
    (layout.hasSourceRepo || (await isGitRepo(worktreePath)))
  ) {
    repositories.push({
      repoId: CODE_GRAPH_WORKSPACE_ROOT_REPO_ID,
      rootPath: worktreePath,
    });
  }
  const reposDir = join(worktreePath, 'repos');
  // Only a missing `repos/` lists no repositories. An unreadable one rejects:
  // an empty listing would reconcile away every repository's graph.
  const entries = await readdir(reposDir, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isMissingPathError(error)) return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    repositories.push({
      repoId: entry.name,
      rootPath: join(reposDir, entry.name),
    });
  }
  return repositories;
}

/**
 * The repositories a worktree build covers: a single-repo worktree with no
 * listed repositories is its root checkout; a multi-repo one builds nothing.
 */
export function codeGraphBuildRepositories(
  worktreePath: string,
  multiRepo: boolean,
  listed: readonly CodeGraphRepositoryInput[],
): CodeGraphRepositoryInput[] {
  if (listed.length > 0) return [...listed];
  return multiRepo
    ? []
    : [{ repoId: CODE_GRAPH_WORKSPACE_ROOT_REPO_ID, rootPath: worktreePath }];
}

/** The repositories a worktree read covers: its root checkout when none are listed. */
export function codeGraphReadRepositories(
  worktreePath: string,
  listed: readonly CodeGraphRepositoryInput[],
): CodeGraphRepositoryInput[] {
  return listed.length > 0
    ? [...listed]
    : [{ repoId: CODE_GRAPH_WORKSPACE_ROOT_REPO_ID, rootPath: worktreePath }];
}
