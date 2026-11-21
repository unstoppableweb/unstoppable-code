import { useMemo } from 'react';
import type { CloneJobSnapshot } from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  pendingCloneRowsVisible,
  pendingProjectsFromCloneJobs,
  type PendingCloneJobActions,
  type SidebarPendingProject,
} from '@canopy/ui-app';
import { useCloneJobsStore } from '@/stores/cloneJobsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';

const ACTIONS: PendingCloneJobActions<CloneJobSnapshot> = {
  // Retry reopens Add project on the same remote (`remoteUrl` already has
  // credentials removed) and leaves the destination to the dialog. The failed
  // job is not dismissed here: if the dialog never opens, or the user backs
  // out, the row and its message are still there.
  onRetry: (job): void => {
    const navigation = useNavigationStore.getState();
    // A second activation must not reseed a dialog the user is already in.
    if (navigation.addWorkspaceModalOpen) return;
    navigation.openAddWorkspaceModal({ initialRepoUrl: job.remoteUrl });
  },
  // A rejection is shown in the row that offered Cancel.
  onCancel: (job): Promise<void> => window.api.cancelCloneJob(job.id),
  onDismiss: (job): void => {
    void window.api.dismissCloneJob(job.id).catch((error: unknown): void => {
      useGitHubStore
        .getState()
        .addToast(`Couldn't dismiss ${job.repoName}`, 'error', undefined, {
          caught: error,
        });
    });
  },
};

/**
 * Native Add project clones as the shared pending project rows for the
 * selected context (see `pendingProjectsFromCloneJobs` and
 * `pendingCloneRowsVisible`).
 *
 * Clones started from the web call `workspace:add-from-remote` without a job
 * id, so they run inline and never enter the clone job registry; they do not
 * appear here.
 */
export function useDesktopPendingProjects(
  context: WorkspaceContext | undefined,
): readonly SidebarPendingProject[] {
  const jobs = useCloneJobsStore((state) => state.jobs);
  const visible = pendingCloneRowsVisible(context);
  return useMemo(
    () => pendingProjectsFromCloneJobs(jobs, ACTIONS, visible),
    [jobs, visible],
  );
}
