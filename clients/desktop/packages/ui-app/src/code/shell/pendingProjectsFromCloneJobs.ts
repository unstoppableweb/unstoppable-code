import {
  backgroundCloneJobs,
  type PortableCloneJob,
} from '@canopy/protocol/clone-jobs';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { SidebarPendingProject } from './PendingProjectRow';

/** The clone job fields a pending project row reads. */
export type PendingCloneJob = Pick<
  PortableCloneJob,
  | 'id'
  | 'repoName'
  | 'workspaceName'
  | 'status'
  | 'error'
  | 'background'
  | 'cancellable'
>;

/**
 * Row actions a host offers. Each is optional: a host that leaves one out
 * shows no control for it. `onCancel` resolves or rejects when the host has
 * answered, so the row can hold its "Cancelling…" state until then.
 */
export interface PendingCloneJobActions<J extends PendingCloneJob> {
  readonly onRetry?: (job: J) => void;
  readonly onCancel?: (job: J) => Promise<void>;
  readonly onDismiss?: (job: J) => void;
}

/**
 * Whether pending clone rows show in `context`. A clone job carries no
 * destination to scope it by, so its row is shown in Personal (and unscoped)
 * views only and withheld from every organization view rather than leaking
 * into an unrelated one.
 */
export function pendingCloneRowsVisible(
  context: WorkspaceContext | undefined,
): boolean {
  return context?.kind !== 'organization';
}

/**
 * A host's Add project clones as the shared pending project rows.
 *
 * Only clones the dialog handed to the background are listed, and only until
 * they produce a project: a foreground clone still has its dialog, and a
 * succeeded one is about to be replaced by its real row. The host removes a
 * succeeded job once its outcome is announced, which can briefly precede the
 * refreshed project list. Returns no rows when `visible` is false (see
 * {@link pendingCloneRowsVisible}).
 */
export function pendingProjectsFromCloneJobs<J extends PendingCloneJob>(
  jobs: readonly J[],
  actions: PendingCloneJobActions<J>,
  visible: boolean,
): SidebarPendingProject[] {
  if (!visible) return [];
  const rows: SidebarPendingProject[] = [];
  for (const job of backgroundCloneJobs(jobs)) {
    const base = { id: job.id, name: job.workspaceName ?? job.repoName };
    const { onRetry, onCancel, onDismiss } = actions;
    if (job.status === 'running') {
      rows.push({
        ...base,
        status: 'cloning',
        // Cancel only while git can still be stopped: once the checkout is
        // complete the project is being added.
        ...(onCancel && job.cancellable
          ? { onCancel: (): Promise<void> => onCancel(job) }
          : {}),
      });
    } else if (job.status === 'cancelling') {
      rows.push({ ...base, status: 'cancelling' });
    } else if (job.status === 'failed') {
      rows.push({
        ...base,
        status: 'failed',
        ...(job.error ? { message: job.error } : {}),
        ...(onRetry ? { onRetry: (): void => onRetry(job) } : {}),
        ...(onDismiss ? { onDismiss: (): void => onDismiss(job) } : {}),
      });
    }
  }
  return rows;
}
