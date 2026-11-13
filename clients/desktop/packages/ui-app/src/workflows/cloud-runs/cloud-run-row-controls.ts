import type { CloudPipelineRunSession } from '@canopy/app-state/cloud-pipeline-runs';
import type { WorkflowRunAction } from '../workflow-run-model';

/** The controls a cloud run's Runs feed row sends without opening the run. */
export type CloudRunRowControl = 'cancel' | 'retry' | 'rerun';

export function isCloudRunRowControl(
  action: WorkflowRunAction,
): action is CloudRunRowControl {
  return action === 'cancel' || action === 'retry' || action === 'rerun';
}

/**
 * Sends one row control on a session made for it (CAN-6326), then closes the
 * session. The session was never opened, so the run isn't followed; its
 * answer still reaches the list through the session's `onView`. Rejects with
 * the cloud's refusal.
 */
export async function sendCloudRunRowControl(
  session: CloudPipelineRunSession,
  control: CloudRunRowControl,
): Promise<void> {
  try {
    if (control === 'cancel') await session.cancel();
    else if (control === 'retry') await session.retry();
    else await session.rerun();
  } finally {
    session.close();
  }
}
