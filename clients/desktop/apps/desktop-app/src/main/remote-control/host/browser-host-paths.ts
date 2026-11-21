import type { CloneJobSnapshot } from '@canopy/protocol/clone-jobs';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { repositoryCloneErrorMessage } from '@canopy/protocol/remote-control/shell';

/**
 * Host paths a browser controller does not receive (CAN-7433). A clone job's
 * `destinationPath` names a folder on this computer; mobile has always
 * received it, but the browser's pending clone rows never read it, so a
 * browser gets `null`. `error` is free text, so a browser receives it only
 * when it is one of the safe clone messages: a failed cleanup, which names the
 * folder, gets path-free copy, and any other text gets the generic failure.
 * Applied after the remote URL projection, to browser sessions only.
 */

const BROWSER_CLEANUP_FAILED_MESSAGE =
  "Couldn't remove the incomplete clone. Remove it on the computer.";

/**
 * The snapshot fields a browser receives as the host sent them. None is free
 * text that can name a host path: `received` and `throughput` are formatted
 * sizes, `workspaceName` is the project's display name, and `remoteUrl` is
 * already blank for controllers. `destinationPath` and `error` are projected
 * below, and any other field (one a newer host adds) is never sent.
 */
const BROWSER_CLONE_JOB_FIELDS = [
  'id',
  'repoName',
  'remoteUrl',
  'status',
  'phase',
  'phasePercent',
  'percent',
  'processedCount',
  'totalCount',
  'received',
  'throughput',
  'startedAt',
  'background',
  'cancellable',
  'workspaceId',
  'workspaceName',
] as const satisfies readonly Exclude<
  keyof CloneJobSnapshot,
  'destinationPath' | 'error'
>[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function browserCloneError(error: string, path: unknown): string {
  if (typeof path === 'string' && path !== '' && error.includes(path))
    return BROWSER_CLEANUP_FAILED_MESSAGE;
  // Returns `error` unchanged only when it is a safe clone message.
  return repositoryCloneErrorMessage(error);
}

// Fails closed: every job record gets the projection whether or not it
// carries a `destinationPath` key, an `error` that is not text becomes `null`
// (the wire value for "no error", which the controller's parser requires),
// and anything that is not a job list or a job record reaches a browser as no
// jobs.
function cloneJobWithoutPath(
  job: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of BROWSER_CLONE_JOB_FIELDS)
    if (field in job) projected[field] = job[field];
  projected.destinationPath = null;
  projected.error =
    typeof job.error === 'string'
      ? browserCloneError(job.error, job.destinationPath)
      : null;
  return projected;
}

function cloneJobsWithoutPaths(jobs: unknown): Record<string, unknown>[] {
  return Array.isArray(jobs)
    ? jobs.filter(isRecord).map(cloneJobWithoutPath)
    : [];
}

/** A tunnelled invoke's result as a browser controller may see it. */
export function projectBrowserResult(channel: string, value: unknown): unknown {
  return channel === IPC_CHANNELS.cloneJobsList
    ? cloneJobsWithoutPaths(value)
    : value;
}

/**
 * A push's arguments as a browser controller may see them. A clone job push
 * carries only the projected job list.
 */
export function projectBrowserPush(
  channel: string,
  args: readonly unknown[],
): unknown[] {
  if (channel !== IPC_CHANNELS.cloneJobsChanged) return [...args];
  return [cloneJobsWithoutPaths(args[0])];
}
