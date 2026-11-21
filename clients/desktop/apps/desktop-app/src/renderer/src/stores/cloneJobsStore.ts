import { create } from 'zustand';
import type { CloneJobSnapshot } from '@canopy/desktop-shared/types';
import { backgroundCloneJobs } from '@canopy/protocol/clone-jobs';

/**
 * Renderer projection of main's Add project clone jobs. Main owns the jobs;
 * this store only mirrors the latest broadcast and the progress dialog's
 * open state.
 */
interface CloneJobsState {
  jobs: CloneJobSnapshot[];
  /** True once a broadcast arrived, so a slower initial list cannot win. */
  received: boolean;
  isOpen: boolean;
  apply: (jobs: CloneJobSnapshot[]) => void;
  hydrate: (jobs: CloneJobSnapshot[]) => void;
  open: () => void;
  close: () => void;
}

export const useCloneJobsStore = create<CloneJobsState>((set, get) => ({
  jobs: [],
  received: false,
  isOpen: false,
  apply: (jobs): void => {
    set({ jobs, received: true });
    if (get().isOpen && backgroundCloneJobs(jobs).length === 0)
      set({ isOpen: false });
  },
  hydrate: (jobs): void => {
    if (!get().received) set({ jobs });
  },
  open: (): void => set({ isOpen: true }),
  close: (): void => set({ isOpen: false }),
}));

export interface CloneJobsSummary {
  label: string;
  /** Aggregate percent across active clones, or null when none are active. */
  percent: number | null;
  failed: number;
  running: number;
}

export function summarizeCloneJobs(
  jobs: readonly CloneJobSnapshot[],
): CloneJobsSummary | null {
  const visible = backgroundCloneJobs(jobs);
  if (visible.length === 0) return null;
  const failed = visible.filter((job) => job.status === 'failed');
  const active = visible.filter(
    (job) => job.status === 'running' || job.status === 'cancelling',
  );
  const succeeded = visible.filter((job) => job.status === 'succeeded');
  const percent =
    active.length === 0
      ? null
      : Math.floor(
          active.reduce((total, job) => total + job.percent, 0) / active.length,
        );
  let label: string;
  if (failed.length > 0) {
    label =
      failed.length === 1
        ? `Couldn't clone ${failed[0].repoName}`
        : `${failed.length} clones failed`;
  } else if (active.length > 1) {
    label = `Cloning ${active.length} projects`;
  } else if (active.length === 1) {
    label = cloneJobHeadline(active[0]);
  } else if (succeeded.length === 1) {
    label = cloneJobHeadline(succeeded[0]);
  } else {
    label = `Added ${succeeded.length} projects`;
  }
  return { label, percent, failed: failed.length, running: active.length };
}

/** One-line status for a single clone. */
export function cloneJobHeadline(job: CloneJobSnapshot): string {
  if (job.status === 'failed') return `Couldn't clone ${job.repoName}`;
  if (job.status === 'cancelling') return `Cancelling ${job.repoName}…`;
  if (job.status === 'succeeded') return `Added ${job.repoName}`;
  if (job.phase === 'finishing') return `Adding ${job.repoName}…`;
  return `Cloning ${job.repoName}`;
}
