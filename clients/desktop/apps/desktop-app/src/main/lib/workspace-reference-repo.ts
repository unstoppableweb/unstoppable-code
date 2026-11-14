import { getRepoRootFromWorktree } from './git';

export async function resolveWorkspaceReferenceRepoPath(
  configuredSourceRepoPath: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const resolvedRepoPath = await getRepoRootFromWorktree(
      configuredSourceRepoPath,
      signal ? { signal } : undefined,
    );
    return typeof resolvedRepoPath === 'string' && resolvedRepoPath.length > 0
      ? resolvedRepoPath
      : configuredSourceRepoPath;
  } catch {
    signal?.throwIfAborted();
    return configuredSourceRepoPath;
  }
}
