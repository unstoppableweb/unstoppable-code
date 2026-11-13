/**
 * The renderer's view of automations (CAN-4551, 7b): an automation that owns
 * its pipeline shows as the chat action the pipeline stands for, so the edit
 * form keeps one model, and names the pipeline. Main still runs, shares and
 * reports the stored action; only the automations list and its push are
 * projected.
 *
 * CAN-5782: given every activity, it also marks each schedule of a workflow
 * page (`workflowSchedule`), and an owner whose pipeline other schedules
 * share is not chat-editable: one record's chat action would regenerate the
 * steps the others run.
 *
 * CAN-6183: a cloud schedule's stub shows the values of its server record,
 * so desktop and web show one schedule.
 */
import { ownedPipelineToChatAction } from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type {
  AutomationsListResponse,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import { ownedChatPipelineState, ownedPipelineId } from './owned-pipeline';
import { cachedCloudRecord, projectCloudScheduleStub } from './cloud-schedules';
import {
  isAgentGrantedPipeline,
  isSharedByOtherSchedules,
  isWorkflowPagePipeline,
  scheduledUserPipelineId,
  userPipelineMetadata,
} from './workflow-schedules';

/**
 * `activities` is every stored activity; without it, nothing is marked a
 * workflow schedule and an owner is never counted as shared.
 */
export function projectOwnedChatAutomation(
  record: ScheduledActivity,
  activities?: readonly ScheduledActivity[],
): ScheduledActivity {
  // CAN-6183: a cloud stub shows its server record's values.
  const activity = projectCloudScheduleStub(record, cachedCloudRecord(record));
  const { action } = activity;
  if (action.type !== 'worktree_pipeline') return activity;
  const scheduled = scheduledUserPipelineId(activity);
  const metadata =
    scheduled === undefined ? undefined : userPipelineMetadata(scheduled);
  const pipelineId = ownedPipelineId(activity);
  const schedule =
    activities !== undefined &&
    scheduled !== undefined &&
    metadata !== undefined &&
    isWorkflowPagePipeline(activities, scheduled, metadata)
      ? {
          workflowSchedule: {
            pipelineId: scheduled,
            owner: pipelineId !== undefined,
            agentOrigin:
              activity.agentAuthor !== undefined ||
              metadata.agentAuthor !== undefined,
          },
        }
      : {};
  if (pipelineId === undefined) return { ...activity, ...schedule };
  const stored = getStoredPipelineBySource('user', pipelineId);
  if (!stored.success || !stored.data) return { ...activity, ...schedule };
  const chatAction = ownedPipelineToChatAction(
    stored.data.content,
    action.inputs ?? {},
    isCoworkWorkspace,
    ownedChatPipelineState(action, pipelineId),
  );
  const shared =
    activities !== undefined &&
    isSharedByOtherSchedules(activities, activity, pipelineId);
  const agentGranted =
    metadata !== undefined && isAgentGrantedPipeline(metadata);
  return chatAction && !shared
    ? {
        ...activity,
        ...schedule,
        action: chatAction,
        ownedPipeline: {
          pipelineId,
          chatEditable: true,
          storedAction: action,
          chatAction,
          agentGranted,
        },
      }
    : {
        ...activity,
        ...schedule,
        ownedPipeline: {
          pipelineId,
          chatEditable: false,
          storedAction: action,
          ...(chatAction ? { chatAction } : {}),
          agentGranted,
        },
      };
}

/** `activities` defaults to the snapshot's own. */
export function projectOwnedChatAutomations(
  snapshot: AutomationsListResponse,
  activities: readonly ScheduledActivity[] = snapshot.activities,
): AutomationsListResponse {
  return {
    ...snapshot,
    activities: snapshot.activities.map((activity) =>
      projectOwnedChatAutomation(activity, activities),
    ),
  };
}
