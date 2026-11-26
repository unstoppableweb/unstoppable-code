/**
 * The writes a chat automation converted to a pipeline it owns allowed on
 * its project's shared connections (CAN-6252). The native prompt carried the
 * list in its turn's dispatch; the owned pipeline keeps it as an automation
 * input, and its generated send step carries it the same way.
 *
 * Only the converter's send step, in a run the automation started of the
 * pipeline it owns, carries the list. Any other pipeline, step or run sends
 * with none, so its scheduled claim allows reads only.
 */
import {
  CHAT_AUTOMATION_JOB,
  sharedConnectionWritesFromInputs,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { ownedPipelineId } from './owned-pipeline';
import {
  CHAT_AUTOMATION_SEND_STEP,
  type OwnedPipelineSendCaller,
} from './owned-pipeline-package';

/** The list an activity's owned pipeline keeps, for a run of `pipelineId`. */
export function ownedPipelineSharedConnectionWrites(
  activity: Pick<ScheduledActivity, 'id' | 'action'>,
  pipelineId: string,
): Record<string, string[]> | undefined {
  const { action } = activity;
  if (
    action.type !== 'worktree_pipeline' ||
    ownedPipelineId(activity) !== pipelineId
  )
    return undefined;
  return sharedConnectionWritesFromInputs(action.inputs);
}

/** The list for a send step, or `undefined` when it carries none. */
export async function ownedPipelineSendSharedConnectionWrites(
  caller: OwnedPipelineSendCaller,
): Promise<Record<string, string[]> | undefined> {
  const { initiator } = caller;
  if (
    initiator?.kind !== 'automation' ||
    caller.jobId !== CHAT_AUTOMATION_JOB ||
    caller.stepId !== CHAT_AUTOMATION_SEND_STEP ||
    caller.childId !== undefined ||
    caller.pipelineId === undefined
  )
    return undefined;
  const { getAutomationsService } = await import('./service');
  const activity =
    await getAutomationsService().findActivityForBackgroundAuthorization(
      initiator.automationId,
    );
  return activity === undefined
    ? undefined
    : ownedPipelineSharedConnectionWrites(activity, caller.pipelineId);
}
