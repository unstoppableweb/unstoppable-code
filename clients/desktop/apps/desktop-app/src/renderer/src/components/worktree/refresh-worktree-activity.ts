import { useGitHubStore } from '@/stores/githubStore';
import { requestChangedFilesRefresh } from '@/stores/changedFilesRefreshRuntime';

export async function refreshWorktreeActivity(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  try {
    await requestChangedFilesRefresh(projectId, worktreeId, {
      kind: 'mutation',
    });
  } catch {
    // Best-effort reload so the UI does not block on sidebar refresh failures.
  }

  await useGitHubStore.getState().requestFastRefresh(projectId, worktreeId);
}
