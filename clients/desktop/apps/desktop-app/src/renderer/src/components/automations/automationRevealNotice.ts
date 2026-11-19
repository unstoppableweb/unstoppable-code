import { WORKFLOW_ITEM_LABEL } from '@canopy/ui-shared/lib/workflow-labels';

/**
 * Copy for the notice shown on Workflows → Library after a shared
 * automation is installed or updated from a share link (CAN-3651).
 *
 * The message follows the automation's live enabled state, so it stays true
 * after the user turns the automation on or off from the row. The Library
 * shows the automation as a workflow, so the copy names it one.
 */

export type AutomationRevealOutcome = 'installed' | 'updated';

/** How far revealing the row got. */
export type AutomationRevealResolution =
  /** The activity is in the list. */
  | { kind: 'shown'; enabled: boolean; runsInLabel: string | null }
  /** The install succeeded, but a refresh still did not return the row. */
  | { kind: 'unavailable' };

export interface AutomationRevealNoticeCopy {
  title: string;
  message: string;
  dismissLabel: string;
}

export const AUTOMATION_REVEAL_UNAVAILABLE_MESSAGE =
  "The workflow couldn't be shown. Refresh the list to find it.";

/** The secondary line on the revealed row. */
export function automationRevealRowCue(
  outcome: AutomationRevealOutcome,
): string {
  return outcome === 'installed' ? 'Newly installed' : 'Just updated';
}

export function automationRevealNoticeCopy(
  outcome: AutomationRevealOutcome,
  resolution: AutomationRevealResolution,
): AutomationRevealNoticeCopy {
  const title = `${WORKFLOW_ITEM_LABEL} ${outcome}`;
  const dismissLabel =
    outcome === 'installed'
      ? 'Dismiss installed workflow notice'
      : 'Dismiss updated workflow notice';
  if (resolution.kind === 'unavailable') {
    return {
      title,
      message: AUTOMATION_REVEAL_UNAVAILABLE_MESSAGE,
      dismissLabel,
    };
  }
  const state = !resolution.enabled
    ? "It's turned off until you enable it."
    : outcome === 'installed'
      ? "It's on."
      : "It's still on.";
  const message =
    resolution.runsInLabel === null
      ? state
      : `${state} ${resolution.runsInLabel}.`;
  return { title, message, dismissLabel };
}
