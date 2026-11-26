/**
 * Which automations the native chat dispatch still serves (deferred.md
 * item 2). A chat automation that converts to a workflow runs only as that
 * workflow; the native dispatch serves the ones that stay native: D4 sends,
 * the agent automations D11 keeps native, a run restriction the action
 * doesn't imply, and a chat pinned to an Agent route.
 */
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { convertsToOwnedChatPipeline } from './chat-automation-conversion';

/** Whether `activity` must not run through the native chat dispatch. */
export function refusesNativeChatDispatch(
  activity: ScheduledActivity,
): boolean {
  return convertsToOwnedChatPipeline(activity);
}
