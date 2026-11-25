import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type SharedContainerRunStatus,
  type SharedContainerRunStatusRequest,
} from '@canopy/desktop-shared/types';
import { listTrackedShellScriptsForWorktree } from '../lib/script-runner';
import { workerTerminal } from '../terminal/worker-terminal';
import {
  getSharedContainerAcceptance,
  isSharedContainerAccepted,
} from './acceptance-store';
import { getSharedContainerReader } from './read/reader';
import {
  projectSharedContainerRunEnvironment,
  readSharedContainerRunEnvironment,
} from './run-env-store';
import {
  getSharedContainerRunCopyState,
  measureSharedContainerRunCopyBytes,
} from './run/run-copy';

/** run-status for a container this device has not accepted. */
export class SharedContainerNotAcceptedError extends Error {
  constructor() {
    super('Shared container has not been accepted on this device.');
    this.name = 'SharedContainerNotAcceptedError';
  }
}

/**
 * One accepted container's run status for `revisionId` (CAN-6501): consent,
 * the revision's run record, the stored values as stored-secret references
 * and the run copy's state. The run environment's plaintext never leaves
 * here. `signal` stops the run-copy walk. A revision that is not the available one throws the reader's
 * `SharedContainerRevisionUnavailableError`. Callers check the
 * shared-containers gate, the platform and the ids.
 */
export async function readSharedContainerRunStatus(
  request: SharedContainerRunStatusRequest,
  signal?: AbortSignal,
): Promise<SharedContainerRunStatus> {
  if (!(await isSharedContainerAccepted(request.containerId))) {
    throw new SharedContainerNotAcceptedError();
  }
  const run = await getSharedContainerReader().readRunConfig(request);
  const acceptance = await getSharedContainerAcceptance(request.containerId);
  const declared = new Set(run?.requiredEnv ?? []);
  const stored = (
    await readSharedContainerRunEnvironment(request.containerId)
  ).filter((entry) => declared.has(entry.key));
  const applied = new Map(stored.map((entry) => [entry.key, entry.value]));
  const runCopy = await getSharedContainerRunCopyState(request.containerId);
  const hasRunningProcesses =
    listTrackedShellScriptsForWorktree({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: request.containerId,
    }).length > 0 ||
    workerTerminal.hasLiveTerminals({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: request.containerId,
    });
  return {
    allowed: acceptance?.runAllowedAt !== undefined,
    ...(acceptance?.runAllowedAt ? { allowedAt: acceptance.runAllowedAt } : {}),
    ...(acceptance?.runAllowedPublisherUserId
      ? { publisherUserId: acceptance.runAllowedPublisherUserId }
      : {}),
    ...(run ? { run } : {}),
    values: projectSharedContainerRunEnvironment(request.containerId, stored),
    unsetRequiredEnv:
      run?.requiredEnv.filter((name) => !(applied.get(name) ?? '').trim()) ??
      [],
    runCopySizeBytes: String(
      await measureSharedContainerRunCopyBytes(request.containerId, signal),
    ),
    runCopyNeedsRefresh:
      runCopy.state !== 'missing' &&
      (runCopy.state === 'pending' ||
        runCopy.revisionId !== request.revisionId),
    hasRunningProcesses,
  };
}
