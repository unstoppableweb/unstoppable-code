import type { OwnedChatPipelineState } from '@canopy/desktop-shared/lib/chat-automation-conversion';
import { loadPipelinePluginCollectionPreferences } from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import type {
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { PipelinePreferenceLocator } from '@canopy/execution-engine/types/pipeline';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  readPipelineLocalMetadata,
  type PipelineLocalMetadata,
} from '../pipelines/pipeline-local-metadata-store';

/**
 * The user pipeline an activity owns (CAN-4551): its action runs that
 * pipeline and the pipeline's owner marker names the activity. A marker
 * whose automation is gone, or no longer runs it, is stale and ignored.
 */
export function ownedPipelineId(
  activity: Pick<ScheduledActivity, 'id' | 'action'>,
): string | undefined {
  const { action } = activity;
  if (action.type !== 'worktree_pipeline' || action.pipelineSource !== 'user')
    return undefined;
  const { ownerAutomationId } = readPipelineLocalMetadata({
    type: 'stored',
    source: 'user',
    value: action.pipelineId,
  });
  return ownerAutomationId === activity.id ? action.pipelineId : undefined;
}

/**
 * What converting an owned pipeline back reads besides its content: the
 * action's model preferences, and its plugin preferences (CAN-5479). A legacy
 * conversion kept those on the action; a current one keeps them as the
 * pipeline's own on this machine, with the selections its defaults stand for.
 */
export function ownedChatPipelineState(
  action: Extract<AutomationAction, { type: 'worktree_pipeline' }>,
  pipelineId: string,
): OwnedChatPipelineState {
  const locator: PipelinePreferenceLocator = {
    type: 'stored',
    source: 'user',
    value: pipelineId,
  };
  const { chatPluginDefaults } = readPipelineLocalMetadata(locator);
  return {
    ...(action.modelAliasPreferences !== undefined
      ? { modelAliasPreferences: action.modelAliasPreferences }
      : {}),
    pluginCollectionPreferences:
      action.pluginCollectionPreferences ??
      loadPipelinePluginCollectionPreferences(locator),
    ...(chatPluginDefaults !== undefined
      ? { pluginDefaults: chatPluginDefaults }
      : {}),
  };
}

/**
 * Whether an activity is a converted Orchestrator prompt (CAN-4551), read
 * from the inputs its conversion stored on the activity: the Orchestrator's
 * bot and no chat. A session prompt to an Orchestrator chat also names its
 * chat. Unlike projecting the pipeline back to its chat action, an edit to
 * the pipeline itself doesn't change the answer.
 */
export function ownsOrchestratorPromptPipeline(
  activity: Pick<ScheduledActivity, 'id' | 'action'>,
): boolean {
  const { action } = activity;
  return (
    action.type === 'worktree_pipeline' &&
    action.inputs?.bot_id !== undefined &&
    action.inputs.chat_id === undefined &&
    ownedPipelineId(activity) !== undefined
  );
}

/**
 * Deletes the pipeline a deleted activity owned, through core with the
 * store's effects. A failure is logged: the activity is already gone, and a
 * leftover pipeline stays listed for the person to delete. With
 * `expectedRevision`, a pipeline written since that revision is kept.
 *
 * CAN-5782: while another record runs the pipeline, it stays as a workflow
 * page instead: the marker is cleared in the same write.
 */
export async function deleteOwnedPipeline(
  activity: Pick<ScheduledActivity, 'id' | 'action'>,
  expectedRevision: number | null = null,
): Promise<void> {
  const pipelineId = ownedPipelineId(activity);
  if (pipelineId === undefined) return;
  const [{ getAutomationsService }, schedules] = await Promise.all([
    import('./service'),
    import('./workflow-schedules'),
  ]);
  const activities = await getAutomationsService().allActivities();
  if (schedules.isSharedByOtherSchedules(activities, activity, pipelineId)) {
    // Callers that can still refuse release it before the owner goes
    // (CAN-5782); this is the fallback, which can only log a failure.
    if (!schedules.releaseOwnedPipeline(activity, pipelineId))
      logMainProcessError('Failed to keep a shared workflow', {
        operation: 'release-owned-pipeline',
      });
    return;
  }
  const [{ deleteUserPipeline }, { AUTOMATION_PIPELINE_CALLER }] =
    await Promise.all([
      import('../canopy-runtime/pipeline-definition-dispatch'),
      import('./chat-automation-conversion'),
    ]);
  const deleted = await deleteUserPipeline(
    pipelineId,
    expectedRevision,
    AUTOMATION_PIPELINE_CALLER,
  );
  if (!deleted.success)
    logMainProcessError('Failed to delete an automation’s own workflow', {
      operation: 'delete-owned-pipeline',
    });
}

/**
 * The user pipelines live automations own (CAN-4551), for lists that fold
 * each into its automation. A stale marker is not in it.
 */
export async function automationOwnedPipelineIds(): Promise<
  ReadonlySet<string>
> {
  const { getAutomationsService } = await import('./service');
  const { activities } = await getAutomationsService().list();
  return new Set(
    activities.flatMap((activity) => {
      const pipelineId = ownedPipelineId(activity);
      return pipelineId === undefined ? [] : [pipelineId];
    }),
  );
}

/**
 * Which of `pipelineIds` an agent in `caller`'s project may not see
 * (CAN-4551): the owned pipelines of Orchestrator automations, and
 * (CAN-5782) Orchestrator pipelines kept after their owner marker was
 * cleared (`agentHidden`). Where Orchestrator access is denied the
 * automation is hidden, so its pipeline is too, and converting it opens no
 * read, edit or delete path to its prompt. Only a pipeline with an owner
 * marker loads the automations.
 */
export async function agentHiddenOwnedPipelineIds(
  pipelineIds: readonly string[],
  caller: { projectId: string; worktreeId: string },
): Promise<ReadonlySet<string>> {
  const metadataOf = (pipelineId: string): PipelineLocalMetadata =>
    readPipelineLocalMetadata({
      type: 'stored',
      source: 'user',
      value: pipelineId,
    });
  const flagged = pipelineIds.filter(
    (pipelineId) => metadataOf(pipelineId).agentHidden === true,
  );
  const marked = new Set(
    pipelineIds.filter(
      (pipelineId) =>
        !flagged.includes(pipelineId) &&
        metadataOf(pipelineId).ownerAutomationId !== undefined,
    ),
  );
  if (marked.size === 0 && flagged.length === 0) return new Set();
  const advisorOwned: string[] = [];
  if (marked.size > 0) {
    const [{ getAutomationsService }, { projectOwnedChatAutomation }] =
      await Promise.all([
        import('./service'),
        import('./owned-chat-projection'),
      ]);
    // Every stored owner (CAN-6065): one the selected context leaves out
    // still hides its pipeline.
    const activities = await getAutomationsService().allActivities();
    for (const activity of activities) {
      const pipelineId = ownedPipelineId(activity);
      if (
        pipelineId !== undefined &&
        marked.has(pipelineId) &&
        (ownsOrchestratorPromptPipeline(activity) ||
          projectOwnedChatAutomation(activity).action.type ===
            'app_advisor_prompt')
      )
        advisorOwned.push(pipelineId);
    }
  }
  const hidden = [...flagged, ...advisorOwned];
  if (hidden.length === 0) return new Set();
  const { decideAppAdvisorAccessForCaller } =
    await import('../lib/app-advisor-project-agent-access');
  return (await decideAppAdvisorAccessForCaller(caller)).allowed
    ? new Set()
    : new Set(hidden);
}

/** Whether an agent in `caller`'s project may not see a stored pipeline. */
export async function isOwnedPipelineHiddenFromAgent(
  pipelineId: string,
  caller: { projectId: string; worktreeId: string },
): Promise<boolean> {
  return (await agentHiddenOwnedPipelineIds([pipelineId], caller)).has(
    pipelineId,
  );
}
