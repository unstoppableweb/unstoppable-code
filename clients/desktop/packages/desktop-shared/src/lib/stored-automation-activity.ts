import type { ScheduledActivity } from '../types';

/**
 * An automation as main stores and runs it (CAN-4551). The automations list
 * shows a converted chat automation as its chat action; sharing publishes
 * what actually runs, its owned workflow, so it reads this instead.
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
 * workflow it runs, except one installed with a capability package that
 * still shows as its chat (CAN-5479): its package binds that chat action, and
 * its install pins the content hash of the chat action it shows.
 */
export function sharedAutomationActivity(
  activity: ScheduledActivity,
): ScheduledActivity {
  const { ownedPipeline, ...shown } = activity;
  return ownedPipeline?.chatEditable === true &&
    activity.installedFrom?.capabilityPackage !== undefined
    ? shown
    : storedAutomationActivity(activity);
}
