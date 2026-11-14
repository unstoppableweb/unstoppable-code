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
 */
export function sharedAutomationActivity(
  activity: ScheduledActivity,
): ScheduledActivity {
  const { ownedPipeline, ...shown } = activity;
  return ownedPipeline?.chatEditable === true &&
    (activity.installedFrom?.capabilityPackage !== undefined ||
      ('model' in activity.action &&
        activity.action.model?.startsWith(AGENT_MODEL_PREFIX) === true))
    ? shown
    : storedAutomationActivity(activity);
}
