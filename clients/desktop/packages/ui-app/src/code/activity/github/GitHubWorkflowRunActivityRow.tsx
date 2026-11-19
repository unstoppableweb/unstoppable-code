'use client';

import { useMemo, type JSX } from 'react';
import { DrawerRowPresentationContext } from '../background-tray/drawer-presentation';
import { useDrawerClock } from '../background-tray/drawer-layout';
import {
  RunJobRows,
  githubBackgroundTrayRun,
  type BackgroundTrayRun,
  type BackgroundTrayRunDag,
} from '../background-tray/RunRow';
import {
  GitHubWorkflowRunRow,
  type GitHubWorkflowRunRowJob,
  type GitHubWorkflowRunRowProps,
} from './GitHubWorkflowRunRow';

export interface GitHubWorkflowRunActivityRowProps extends Omit<
  GitHubWorkflowRunRowProps,
  'renderJobs'
> {
  /** Opens one job on GitHub from the row's job list. */
  onJobClick: (job: GitHubWorkflowRunRowJob) => void;
}

/**
 * The open job list. Mounted only while the row's jobs are shown, so its
 * clock runs only then, and only while a job is still in progress.
 */
function GitHubWorkflowRunJobs({
  run,
  dag,
  onJobClick,
  canOpenJob,
}: {
  readonly run: BackgroundTrayRun;
  readonly dag: BackgroundTrayRunDag;
  readonly onJobClick: (jobId: string) => void;
  readonly canOpenJob: (jobId: string) => boolean;
}): JSX.Element {
  const running = Object.values(dag.jobs).some(
    (job) => job.status === 'running' || job.status === 'restarting',
  );
  const now = useDrawerClock(running);
  return (
    // The list alone, without a drawer row's action column.
    <DrawerRowPresentationContext.Provider value="modal">
      <RunJobRows
        run={run}
        dag={dag}
        now={now}
        onJobClick={(_runId, jobId): void => onJobClick(jobId)}
        canOpenJob={canOpenJob}
      />
    </DrawerRowPresentationContext.Provider>
  );
}

/**
 * The Agent activity row for a watched GitHub run, with its jobs behind the
 * row's dots: the same job list the composer's background drawer shows for
 * the run, each job with its state and time, opening its page on GitHub.
 */
export function GitHubWorkflowRunActivityRow({
  run,
  onJobClick,
  ...row
}: GitHubWorkflowRunActivityRowProps): JSX.Element {
  const trayRun = useMemo(() => githubBackgroundTrayRun(run.runId, run), [run]);
  const { dag } = trayRun;
  // Jobs GitHub has created, by id: only these have a page to open. A job
  // the workflow declares but GitHub has not created yet is a plain row.
  const observed = useMemo(
    () => new Map((run.jobs ?? []).map((job) => [job.jobId, job])),
    [run.jobs],
  );
  return (
    <GitHubWorkflowRunRow
      {...row}
      run={run}
      renderJobs={
        dag === null
          ? undefined
          : (): JSX.Element => (
              <GitHubWorkflowRunJobs
                run={trayRun}
                dag={dag}
                canOpenJob={(jobId): boolean => observed.has(jobId)}
                onJobClick={(jobId): void => {
                  const job = observed.get(jobId);
                  if (job) onJobClick(job);
                }}
              />
            )
      }
    />
  );
}
