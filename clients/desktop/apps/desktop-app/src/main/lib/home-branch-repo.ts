import { readWorkspaceConfig } from './workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';

/**
 * The repository Home branch targets enumerate: a single-repo workspace's
 * repository or a multi-repo workspace's source repository, resolved to its
 * main repository root. `null` when the workspace has neither.
 */
export async function resolveHomeBranchRepoPath(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const config = await readWorkspaceConfig(workspaceId);
  signal?.throwIfAborted();
  if (config.type === 'single-repo' && config.repoPath) {
    return resolveWorkspaceReferenceRepoPath(config.repoPath, signal);
  }
  if (config.type === 'multi-repo' && config.sourceRepoPath) {
    return resolveWorkspaceReferenceRepoPath(config.sourceRepoPath, signal);
  }
  return null;
}
