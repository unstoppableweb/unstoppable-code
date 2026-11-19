import { useMemo } from 'react';
import type { CloneJobSnapshot } from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { SidebarPendingProject } from '@canopy/ui-app';
import {
  backgroundCloneJobs,
  useCloneJobsStore,
} from '@/stores/cloneJobsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';

export interface DesktopPendingProjectActions {
  readonly onRetry: (job: CloneJobSnapshot) => void;
  readonly onDismiss: (job: CloneJobSnapshot) => void;
}

/**
 * Native Add project clones as the shared pending project rows.
 *
 * Only clones the dialog handed to the background are listed, and only until
 * they produce a project: a foreground clone still has its dialog, and a
 * succeeded one is about to be replaced by its real row. Main removes a
 * succeeded job once its outcome is announced, which can briefly precede the
 * refreshed project list.
 *
 * Clones started from the web run inline in the Portal command handler and
 * never enter the clone job registry, so they do not appear here.
 */
export function pendingProjectsFromCloneJobs(
  jobs: readonly CloneJobSnapshot[],
  actions: DesktopPendingProjectActions,
): SidebarPendingProject[] {
  const rows: SidebarPendingProject[] = [];
  for (const job of backgroundCloneJobs(jobs)) {
    const base = { id: job.id, name: job.workspaceName ?? job.repoName };
    if (job.status === 'running') {
      rows.push({ ...base, status: 'cloning' });
    } else if (job.status === 'cancelling') {
      rows.push({ ...base, status: 'cancelling' });
    } else if (job.status === 'failed') {
      rows.push({
        ...base,
        status: 'failed',
        ...(job.error ? { message: job.error } : {}),
        onRetry: (): void => actions.onRetry(job),
        onDismiss: (): void => actions.onDismiss(job),
      });
    }
  }
  return rows;
}

const NO_ROWS: readonly SidebarPendingProject[] = [];

const ACTIONS: DesktopPendingProjectActions = {
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
 * Pending project rows for the selected context. A clone job carries no
 * destination to scope it by, so its row is shown in Personal (and unscoped)
 * views only and withheld from every organization view rather than leaking
 * into an unrelated one.
 */
export function useDesktopPendingProjects(
  context: WorkspaceContext | undefined,
): readonly SidebarPendingProject[] {
  const jobs = useCloneJobsStore((state) => state.jobs);
  const visible = context?.kind !== 'organization';
  return useMemo(
    () => (visible ? pendingProjectsFromCloneJobs(jobs, ACTIONS) : NO_ROWS),
    [jobs, visible],
  );
}
