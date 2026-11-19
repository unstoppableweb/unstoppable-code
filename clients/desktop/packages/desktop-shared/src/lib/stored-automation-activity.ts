import { AGENT_MODEL_PREFIX } from '@canopy/protocol/agents';
import type { ScheduledActivity } from '../types';

/**
 * An automation as main stores and runs it (CAN-4551). The automations list
 * shows a converted chat automation as its chat action; workflow consumers
 * read its owned pipeline action instead.
 */
export function storedAutomationActivity(
  activity: ScheduledActivity,
): ScheduledActivity {
  const { ownedPipeline, ...stored } = activity;
  return ownedPipeline
    ? { ...stored, action: ownedPipeline.storedAction }
    : activity;
}

/**
 * The automation a share publishes. A converted chat automation shares the
 * workflow it runs, except a validated chat projection that uses an Agent
 * or has an installed capability package (CAN-5479). Pipeline publication
 * strips local alias preferences; the chat carries its Agent model portably.
 * CAN-7285: a workflow the install bundled always shares as the workflow
 * it runs, as it did before its install owned it: its package is pinned to
 * that workflow, not to a chat action.
 */
export function sharedAutomationActivity(
  activity: ScheduledActivity,
): ScheduledActivity {
  const { ownedPipeline, ...shown } = activity;
  return ownedPipeline?.chatEditable === true &&
    activity.installedFrom?.bundledPipelineLocalId !==
      ownedPipeline.pipelineId &&
    (activity.installedFrom?.capabilityPackage !== undefined ||
      ('model' in activity.action &&
        activity.action.model?.startsWith(AGENT_MODEL_PREFIX) === true))
    ? shown
    : storedAutomationActivity(activity);
}

/**
 * The stored workflow a packaged install shares in place of its chat
 * projection, when the chat form is kept only for its installed capability
 * package (CAN-6455), or `null`. The share carries the package rebuilt for the
 * workflow. A chat routed to an Agent stays a chat, as the share contract
 * carries the Agent only there.
 */
export function installedPackageWorkflowActivity(
  activity: ScheduledActivity,
): ScheduledActivity | null {
  if (
    activity.ownedPipeline?.chatEditable !== true ||
    activity.installedFrom?.capabilityPackage === undefined ||
    ('model' in activity.action &&
      activity.action.model?.startsWith(AGENT_MODEL_PREFIX) === true)
  )
    return null;
  const stored = storedAutomationActivity(activity);
  return stored.action.type === 'worktree_pipeline' &&
    stored.action.pipelineSource === 'user'
    ? stored
    : null;
}
