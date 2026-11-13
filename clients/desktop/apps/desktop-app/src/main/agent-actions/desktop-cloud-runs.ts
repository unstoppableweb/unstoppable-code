import { AgentPortError, type CloudRunAccess } from '@canopy/agent-actions';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import { requestCloud } from '@canopy/app-state/cloud-pipeline-runs';
import {
  cloudPipelineRunsAgentInvoker,
  readPipelineCloudRunsAvailability,
} from '../pipelines/cloud-pipeline-runs';
import { agentPipelineOwnerContext } from '../pipelines/pipeline-owner-policy';

/**
 * A desktop chat's reach into cloud runs (CAN-6354, plan CP-42) for the
 * shared cloud run execution actions: main's own web core calls, through
 * the CAN-6326 `requestCloud`, as the signed-in account.
 *
 * A chat reaches the cloud runs of its project's owner, the owner its cloud
 * starts run under, since a cloud run started from desktop records no agent
 * chat to narrow to (a cloud chat reaches the runs its task started). A run
 * recorded without an owner is Personal.
 */

/** Whether the signed-in account's web core serves cloud runs; fails closed. */
export async function cloudRunsAvailable(): Promise<boolean> {
  return (await readPipelineCloudRunsAvailability()).pipelineCloudRuns;
}

export const CLOUD_RUNS_UNAVAILABLE_MESSAGE =
  "Cloud runs aren't available right now: sign in, or try again later.";

export async function desktopCloudRunAccess(chat: {
  projectId: string;
  worktreeId: string;
}): Promise<CloudRunAccess> {
  const owner = await agentPipelineOwnerContext(chat);
  if ('refusal' in owner)
    throw new AgentPortError('owner_context_unavailable', owner.refusal);
  const invoker = cloudPipelineRunsAgentInvoker();
  return {
    call: (method, params, result) =>
      requestCloud(invoker, method, params, result),
    payloadOf: (error) =>
      error instanceof CoreCoworkRequestError ? error.payload : null,
    owner: owner.owner,
    reaches: (view) => (view.execution.owner ?? 'personal') === owner.owner,
    notFoundMessage: (executionId) =>
      `No workflow run this chat can reach has the id ${executionId}.`,
  };
}
