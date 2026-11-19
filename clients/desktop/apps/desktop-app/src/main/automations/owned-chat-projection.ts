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
import {
  getStoredPipelineBySource,
  withStoredPipelineIndexSnapshot,
} from '../pipelines/pipeline-service';
import type { PipelineLocalMetadata } from '../pipelines/pipeline-local-metadata-store';
import { ownedChatPipelineState, ownedPipelineId } from './owned-pipeline';
import { cachedCloudRecord, projectCloudScheduleStub } from './cloud-schedules';
import {
  isAgentGrantedPipeline,
  isSharedByOtherSchedules,
  isWorkflowPagePipeline,
  scheduledUserPipelineId,
  userPipelineMetadata,
} from './workflow-schedules';

type PipelineAction = Extract<
  ScheduledActivity['action'],
  { type: 'worktree_pipeline' }
>;

/** What a projection reads whatever the context (CAN-7087). */
interface ProjectionBase {
  readonly activity: ScheduledActivity;
  readonly pipeline?: {
    readonly action: PipelineAction;
    readonly scheduled: string | undefined;
    readonly metadata: PipelineLocalMetadata | undefined;
    readonly pipelineId: string | undefined;
    /** Undefined when the owned pipeline can't be read. */
    readonly owned?: {
      readonly chatAction: ReturnType<typeof ownedPipelineToChatAction>;
      readonly agentGranted: boolean;
    };
  };
}

function projectionBase(record: ScheduledActivity): ProjectionBase {
  // CAN-6183: a cloud stub shows its server record's values.
  const activity = projectCloudScheduleStub(record, cachedCloudRecord(record));
  const { action } = activity;
  if (action.type !== 'worktree_pipeline') return { activity };
  const scheduled = scheduledUserPipelineId(activity);
  const metadata =
    scheduled === undefined ? undefined : userPipelineMetadata(scheduled);
  const pipelineId = ownedPipelineId(activity);
  const pipeline = { action, scheduled, metadata, pipelineId };
  if (pipelineId === undefined) return { activity, pipeline };
  const stored = getStoredPipelineBySource('user', pipelineId);
  if (!stored.success || !stored.data) return { activity, pipeline };
  const chatAction = ownedPipelineToChatAction(
    stored.data.content,
    action.inputs ?? {},
    isCoworkWorkspace,
    ownedChatPipelineState(action, pipelineId),
  );
  const agentGranted =
    metadata !== undefined && isAgentGrantedPipeline(metadata);
  return {
    activity,
    pipeline: { ...pipeline, owned: { chatAction, agentGranted } },
  };
}

function finishProjection(
  { activity, pipeline }: ProjectionBase,
  activities: readonly ScheduledActivity[] | undefined,
): ScheduledActivity {
  if (pipeline === undefined) return activity;
  const { action, scheduled, metadata, pipelineId, owned } = pipeline;
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
  if (pipelineId === undefined || owned === undefined)
    return { ...activity, ...schedule };
  const { chatAction, agentGranted } = owned;
  const shared =
    activities !== undefined &&
    isSharedByOtherSchedules(activities, activity, pipelineId);
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

/**
 * `activities` is every stored activity; without it, nothing is marked a
 * workflow schedule and an owner is never counted as shared.
 */
export function projectOwnedChatAutomation(
  record: ScheduledActivity,
  activities?: readonly ScheduledActivity[],
): ScheduledActivity {
  return finishProjection(projectionBase(record), activities);
}

export type OwnedChatProjector = (
  record: ScheduledActivity,
  activities?: readonly ScheduledActivity[],
) => ScheduledActivity;

/**
 * Projects like {@link projectOwnedChatAutomation}, reading each record's
 * pipeline once however many contexts it is projected against (CAN-7087).
 * It caches what it read, so use one only within a single synchronous pass.
 */
export function ownedChatProjector(): OwnedChatProjector {
  const bases = new Map<ScheduledActivity, ProjectionBase>();
  return (record, activities) => {
    let base = bases.get(record);
    if (base === undefined) {
      base = projectionBase(record);
      bases.set(record, base);
    }
    return finishProjection(base, activities);
  };
}

/** Runs one projection pass; its pipeline lookups share one index read. */
export function withOwnedChatProjectionPass<T>(run: () => T): T {
  return withStoredPipelineIndexSnapshot(run);
}

/** `activities` defaults to the snapshot's own. */
export function projectOwnedChatAutomations(
  snapshot: AutomationsListResponse,
  activities: readonly ScheduledActivity[] = snapshot.activities,
  project: OwnedChatProjector = projectOwnedChatAutomation,
): AutomationsListResponse {
  return withOwnedChatProjectionPass(() => ({
    ...snapshot,
    activities: snapshot.activities.map((activity) =>
      project(activity, activities),
    ),
  }));
}
